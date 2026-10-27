import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  Chrono,
  type Datastore,
  ProcessorEvents,
  type RegisterTaskHandlerResponse,
  type Task,
} from '@neofinancial/chrono';
import { ChronoMongoDatastore, type MongoDatastoreOptions } from '@neofinancial/chrono-mongo-datastore';
import { MongoClient } from 'mongodb';

import { LatencyMetrics } from './latency-metrics.js';
import { TimedDatastore } from './timed-datastore.js';

type LoadTaskData = {
  ordinal: number;
  delayMs: number;
  failuresBeforeSuccess: number;
};

type IdempotencyTaskData = {
  logicalId: number;
};

type PriorityTaskData = {
  priority: number;
};

type LoadTaskMapping = {
  load: LoadTaskData;
  idempotency: IdempotencyTaskData;
  priority: PriorityTaskData;
};

type Config = {
  taskCount: number;
  workerCount: number;
  concurrencyPerWorker: number;
  maxDelayMs: number;
  retryPercent: number;
  seed: number;
  timeoutMs: number;
};

type Metrics = {
  claims: number;
  retries: number;
  completed: number;
  failed: number;
  handlerCalls: number;
  activeHandlers: number;
  maxParallelHandlers: number;
  completionErrors: number;
  processingErrors: number;
};

const SCENARIO_NAMES = ['load', 'idempotency', 'priority'] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

const DEFAULTS: Config = {
  taskCount: 1_000,
  workerCount: 4,
  concurrencyPerWorker: 8,
  maxDelayMs: 25,
  retryPercent: 10,
  seed: 42,
  timeoutMs: 120_000,
};

function integerFromEnvironment(name: string, defaultValue: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function loadConfig(): Config {
  return {
    taskCount: integerFromEnvironment('TASK_COUNT', DEFAULTS.taskCount, 1, 100_000),
    workerCount: integerFromEnvironment('WORKER_COUNT', DEFAULTS.workerCount, 1, 32),
    concurrencyPerWorker: integerFromEnvironment('CONCURRENCY_PER_WORKER', DEFAULTS.concurrencyPerWorker, 1, 100),
    maxDelayMs: integerFromEnvironment('MAX_DELAY_MS', DEFAULTS.maxDelayMs, 0, 30_000),
    retryPercent: integerFromEnvironment('RETRY_PERCENT', DEFAULTS.retryPercent, 0, 100),
    seed: integerFromEnvironment('SEED', DEFAULTS.seed, 1, 2_147_483_646),
    timeoutMs: integerFromEnvironment('TIMEOUT_MS', DEFAULTS.timeoutMs, 1_000, 3_600_000),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

function createTasks(config: Config): LoadTaskData[] {
  const random = seededRandom(config.seed);

  return Array.from({ length: config.taskCount }, (_, ordinal) => ({
    ordinal,
    delayMs: Math.floor(random() * (config.maxDelayMs + 1)),
    failuresBeforeSuccess: random() * 100 < config.retryPercent ? 1 : 0,
  }));
}

function attachMetrics(
  processor: RegisterTaskHandlerResponse<'load', LoadTaskMapping>,
  metrics: Metrics,
  errors: string[],
): void {
  processor.on(ProcessorEvents.TASK_CLAIMED, () => {
    metrics.claims += 1;
  });
  processor.on(ProcessorEvents.TASK_RETRY_SCHEDULED, () => {
    metrics.retries += 1;
  });
  processor.on(ProcessorEvents.TASK_COMPLETED, () => {
    metrics.completed += 1;
  });
  processor.on(ProcessorEvents.TASK_FAILED, ({ task, error }) => {
    metrics.failed += 1;
    errors.push(`task ${task.id} failed: ${String(error)}`);
  });
  processor.on(ProcessorEvents.TASK_COMPLETION_FAILURE, ({ task, error }) => {
    metrics.completionErrors += 1;
    errors.push(`could not complete task ${task.id}: ${String(error)}`);
  });
  processor.on(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, ({ error }) => {
    metrics.processingErrors += 1;
    errors.push(`processor error: ${String(error)}`);
  });
}

async function waitForCount(
  currentCount: () => number,
  expectedCount: number,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (currentCount() < expectedCount) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}: ${currentCount()} of ${expectedCount}`);
    }
    await sleep(25);
  }
}

async function waitForCompletion(metrics: Metrics, taskCount: number, timeoutMs: number): Promise<void> {
  await waitForCount(() => metrics.completed + metrics.failed, taskCount, timeoutMs, 'task completion');
}

function processorConfiguration(maxConcurrency: number) {
  return {
    maxConcurrency,
    claimIntervalMs: 1,
    idleIntervalMs: 20,
    claimStaleTimeoutMs: 30_000,
    taskHandlerTimeoutMs: 10_000,
    taskHandlerMaxRetries: 2,
    processLoopRetryIntervalMs: 50,
  };
}

async function scheduleTasks(
  chrono: Chrono<LoadTaskMapping, MongoDatastoreOptions>,
  tasks: LoadTaskData[],
): Promise<string[]> {
  const taskIds: string[] = [];
  const batchSize = 100;

  for (let offset = 0; offset < tasks.length; offset += batchSize) {
    const batch = tasks.slice(offset, offset + batchSize);
    const scheduled = await Promise.all(
      batch.map((data) =>
        chrono.scheduleTask({
          kind: 'load',
          when: new Date(),
          data,
        }),
      ),
    );
    taskIds.push(...scheduled.map((task) => task.id));
  }

  return taskIds;
}

async function runIdempotencyScenario(
  datastore: Datastore<LoadTaskMapping, MongoDatastoreOptions>,
  timeoutMs: number,
  latencyMetrics: LatencyMetrics,
) {
  const keyCount = 100;
  const schedulesPerKey = 5;
  const scheduler = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
  const requests = Array.from({ length: keyCount }, (_, logicalId) =>
    Array.from({ length: schedulesPerKey }, () => ({
      kind: 'idempotency' as const,
      when: new Date(),
      data: { logicalId },
      idempotencyKey: `chrono-load-idempotency-${logicalId}`,
    })),
  ).flat();
  const scheduled = await Promise.all(requests.map((request) => scheduler.scheduleTask(request)));
  const uniqueTaskIds = new Set(scheduled.map((task) => task.id));
  const effects = new Map<number, number>();
  let completed = 0;

  const worker = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
  const processor = worker.registerTaskHandler({
    kind: 'idempotency',
    handler: async (task) => {
      await latencyMetrics.measure('handler', async () => {
        effects.set(task.data.logicalId, (effects.get(task.data.logicalId) ?? 0) + 1);
      });
    },
    processorConfiguration: processorConfiguration(16),
  });
  processor.on(ProcessorEvents.TASK_COMPLETED, () => {
    completed += 1;
  });

  await worker.start();
  try {
    await waitForCount(() => completed, uniqueTaskIds.size, timeoutMs, 'idempotency scenario');
  } finally {
    await worker.stop();
  }

  const violations: string[] = [];
  if (uniqueTaskIds.size !== keyCount) {
    violations.push(`expected ${keyCount} task IDs for ${requests.length} schedules, found ${uniqueTaskIds.size}`);
  }
  if (effects.size !== keyCount || [...effects.values()].some((count) => count !== 1)) {
    violations.push(`expected one handler effect per idempotency key, observed ${completed} total effects`);
  }

  return {
    passed: violations.length === 0,
    scheduledCalls: requests.length,
    idempotencyKeys: keyCount,
    uniqueTaskIds: uniqueTaskIds.size,
    handlerEffects: completed,
    latenciesMs: latencyMetrics.summarize(),
    violations,
  };
}

async function runPriorityScenario(
  datastore: Datastore<LoadTaskMapping, MongoDatastoreOptions>,
  timeoutMs: number,
  latencyMetrics: LatencyMetrics,
) {
  const expectedOrder = [5, 4, 3, 2, 1];
  const schedulingOrder = [1, 2, 3, 4, 5];
  const baseScheduleTime = Date.now() - 10_000;
  const scheduler = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
  const scheduled = await Promise.all(
    schedulingOrder.map((priority) =>
      scheduler.scheduleTask({
        kind: 'priority',
        when: new Date(baseScheduleTime + priority * 1_000),
        data: { priority },
        priority,
      }),
    ),
  );

  const observedOrder: number[] = [];
  let completed = 0;
  const worker = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
  const processor = worker.registerTaskHandler({
    kind: 'priority',
    handler: async (task) => {
      await latencyMetrics.measure('handler', async () => {
        observedOrder.push(task.data.priority);
      });
    },
    processorConfiguration: processorConfiguration(1),
  });
  processor.on(ProcessorEvents.TASK_COMPLETED, () => {
    completed += 1;
  });

  await worker.start();
  try {
    await waitForCount(() => completed, schedulingOrder.length, timeoutMs, 'priority scenario');
  } finally {
    await worker.stop();
  }

  const violations: string[] = [];
  if (observedOrder.join(',') !== expectedOrder.join(',')) {
    violations.push(`expected priority order ${expectedOrder.join(',')}, observed ${observedOrder.join(',')}`);
  }

  return {
    passed: violations.length === 0,
    expectedOrder,
    observedOrder,
    storedPriorities: scheduled.map((task) => task.priority ?? null),
    latenciesMs: latencyMetrics.summarize(),
    violations,
  };
}

async function runLoadScenario(
  datastore: Datastore<LoadTaskMapping, MongoDatastoreOptions>,
  config: Config,
  latencyMetrics: LatencyMetrics,
) {
  const tasks = createTasks(config);
  const expectedRetries = tasks.reduce((total, task) => total + task.failuresBeforeSuccess, 0);
  const attempts = new Map<number, number>();
  const successes = new Map<number, number>();
  const errors: string[] = [];
  const metrics: Metrics = {
    claims: 0,
    retries: 0,
    completed: 0,
    failed: 0,
    handlerCalls: 0,
    activeHandlers: 0,
    maxParallelHandlers: 0,
    completionErrors: 0,
    processingErrors: 0,
  };
  const workers: Array<Chrono<LoadTaskMapping, MongoDatastoreOptions>> = [];
  const startedAt = Date.now();

  try {
    const handler = async (task: Task<'load', LoadTaskData>): Promise<void> => {
      await latencyMetrics.measure('handler', async () => {
        metrics.handlerCalls += 1;
        metrics.activeHandlers += 1;
        metrics.maxParallelHandlers = Math.max(metrics.maxParallelHandlers, metrics.activeHandlers);
        attempts.set(task.data.ordinal, (attempts.get(task.data.ordinal) ?? 0) + 1);

        try {
          await sleep(task.data.delayMs);
          if (task.retryCount < task.data.failuresBeforeSuccess) {
            throw new Error(`injected transient failure for task ${task.data.ordinal}`);
          }
          successes.set(task.data.ordinal, (successes.get(task.data.ordinal) ?? 0) + 1);
        } finally {
          metrics.activeHandlers -= 1;
        }
      });
    };

    for (let worker = 0; worker < config.workerCount; worker += 1) {
      const chrono = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
      const processor = chrono.registerTaskHandler({
        kind: 'load',
        handler,
        backoffStrategyOptions: { type: 'none' },
        processorConfiguration: {
          maxConcurrency: config.concurrencyPerWorker,
          claimIntervalMs: 1,
          idleIntervalMs: 20,
          claimStaleTimeoutMs: Math.max(config.maxDelayMs + 10_000, 30_000),
          taskHandlerTimeoutMs: Math.max(config.maxDelayMs + 5_000, 10_000),
          taskHandlerMaxRetries: 2,
          processLoopRetryIntervalMs: 50,
        },
      });
      attachMetrics(processor, metrics, errors);
      workers.push(chrono);
    }

    await Promise.all(workers.map((worker) => worker.start()));

    const scheduler = new Chrono<LoadTaskMapping, MongoDatastoreOptions>(datastore);
    const taskIds = await scheduleTasks(scheduler, tasks);
    await waitForCompletion(metrics, config.taskCount, config.timeoutMs);
    await Promise.all(workers.map((worker) => worker.stop()));
    workers.length = 0;

    const violations: string[] = [];
    if (new Set(taskIds).size !== config.taskCount) {
      violations.push(`expected ${config.taskCount} unique task IDs, found ${new Set(taskIds).size}`);
    }
    if (metrics.retries !== expectedRetries) {
      violations.push(`expected ${expectedRetries} retries, observed ${metrics.retries}`);
    }
    if (metrics.claims !== config.taskCount + expectedRetries) {
      violations.push(`expected ${config.taskCount + expectedRetries} claims, observed ${metrics.claims}`);
    }
    if (metrics.handlerCalls !== config.taskCount + expectedRetries) {
      violations.push(`expected ${config.taskCount + expectedRetries} handler calls, observed ${metrics.handlerCalls}`);
    }
    if (metrics.completed !== config.taskCount || metrics.failed !== 0) {
      violations.push(
        `expected ${config.taskCount} completed and 0 failed, observed ${metrics.completed} and ${metrics.failed}`,
      );
    }
    if (successes.size !== config.taskCount || [...successes.values()].some((count) => count !== 1)) {
      violations.push('each logical task must produce exactly one successful fake-handler effect');
    }
    if (tasks.some((task) => attempts.get(task.ordinal) !== task.failuresBeforeSuccess + 1)) {
      violations.push('one or more tasks ran an unexpected number of attempts');
    }
    violations.push(...errors);

    const durationMs = Date.now() - startedAt;
    return {
      passed: violations.length === 0,
      expectedRetries,
      metrics: {
        ...metrics,
        durationMs,
        tasksPerSecond: Math.round((config.taskCount / durationMs) * 1_000),
      },
      latenciesMs: latencyMetrics.summarize(),
      violations,
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
  }
}

function selectedScenarios(): ScenarioName[] | undefined {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h' },
      scenario: { type: 'string', short: 's' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log('Usage: chrono-load-tester [load|idempotency|priority|all]');
    console.log('       chrono-load-tester --scenario <name>');
    return undefined;
  }
  if (positionals.length > 1 || (positionals.length === 1 && values.scenario)) {
    throw new Error('provide one scenario using either a positional argument or --scenario');
  }

  const selected = positionals[0] ?? values.scenario ?? 'all';
  if (selected === 'all') {
    return [...SCENARIO_NAMES];
  }
  if (!SCENARIO_NAMES.includes(selected as ScenarioName)) {
    throw new Error(`unknown scenario "${selected}"; expected ${[...SCENARIO_NAMES, 'all'].join(', ')}`);
  }
  return [selected as ScenarioName];
}

async function run(): Promise<void> {
  const scenariosToRun = selectedScenarios();
  if (!scenariosToRun) {
    return;
  }

  const config = loadConfig();
  const mongoLatencies = new LatencyMetrics();
  const client = new MongoClient(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017', {
    monitorCommands: true,
  });
  client.on('commandSucceeded', (event) => {
    mongoLatencies.record(`command.${event.commandName}`, event.duration);
  });
  client.on('commandFailed', (event) => {
    mongoLatencies.record(`command.${event.commandName}.failed`, event.duration);
  });

  console.log(JSON.stringify({ event: 'load-test-start', scenarios: scenariosToRun, config }));

  try {
    await client.connect();
    const rawDatastore = new ChronoMongoDatastore<LoadTaskMapping>({
      collectionName: 'chrono-load-test-tasks',
      uninitializedDatastoreBehavior: 'throw',
    });
    const database = client.db('chronoLoadTest');
    await rawDatastore.initialize(database);
    await database.collection('chrono-load-test-tasks').deleteMany({});

    const scenarioResults: Record<string, { passed: boolean }> = {};
    for (const scenario of scenariosToRun) {
      const latencies = new LatencyMetrics();
      const datastore = new TimedDatastore<LoadTaskMapping, MongoDatastoreOptions>(rawDatastore, latencies);
      if (scenario === 'load') {
        scenarioResults.load = await runLoadScenario(datastore, config, latencies);
      } else if (scenario === 'idempotency') {
        scenarioResults.idempotency = await runIdempotencyScenario(datastore, config.timeoutMs, latencies);
      } else {
        scenarioResults.priority = await runPriorityScenario(datastore, config.timeoutMs, latencies);
      }
    }

    const result = {
      event: 'load-test-result',
      passed: Object.values(scenarioResults).every((scenario) => scenario.passed),
      config,
      scenarios: scenarioResults,
      mongoLatenciesMs: mongoLatencies.summarize(),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

run().catch((error: unknown) => {
  console.log(
    JSON.stringify({
      event: 'load-test-fatal',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
