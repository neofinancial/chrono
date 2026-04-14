import {
  Chrono,
  ChronoEvents,
  type ChronoHandlerRegistrar,
  type ChronoTaskScheduler,
  ProcessorEvents,
} from '@neofinancial/chrono';
import { ChronoMemoryDatastore } from '@neofinancial/chrono-memory-datastore';

type DatastoreOptions = undefined;

type TaskMapping = {
  'async-messaging': { someField: number };
  'send-email': { url: string };
};

/**
 * Consumers only need `ChronoHandlerRegistrar` -- they never see `use()` or
 * `scheduleTask()`, which keeps the type covariant in TaskMapping.
 */
function registerHandlers(registrar: ChronoHandlerRegistrar<TaskMapping>) {
  const processor1 = registrar.registerTaskHandler({
    kind: 'async-messaging',
    handler: async (task) => {
      console.log('async-messaging task handler:', task);
    },
    backoffStrategyOptions: {
      type: 'linear',
      incrementMs: 100,
      baseDelayMs: 100,
    },
  });

  const processor2 = registrar.registerTaskHandler({
    kind: 'send-email',
    handler: async (task) => {
      console.log('send-email task handler:', task);
    },
    processorConfiguration: { type: 'simple' },
    backoffStrategyOptions: {
      type: 'exponential',
      maxDelayMs: 10_000,
      baseDelayMs: 100,
      jitter: 'full',
    },
  });

  return { processor1, processor2 };
}

/**
 * Producers only need `ChronoTaskScheduler` -- they can schedule tasks without
 * access to handler registration or plugin methods.
 */
async function scheduleTasks(scheduler: ChronoTaskScheduler<TaskMapping, DatastoreOptions>) {
  await scheduler.scheduleTask({
    when: new Date(),
    kind: 'async-messaging',
    data: { someField: 123 },
  });

  await scheduler.scheduleTask({
    when: new Date(),
    kind: 'send-email',
    data: { url: 'https://example.com' },
  });
}

async function main() {
  const memoryDatastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();
  const chrono = new Chrono<TaskMapping, DatastoreOptions>(memoryDatastore);

  chrono.on(ChronoEvents.STARTED, ({ startedAt }) => {
    console.log('Chrono successfully started and polling tasks', startedAt);
  });

  chrono.on(ChronoEvents.STOP_ABORTED, ({ error, timestamp }) => {
    console.error('Chrono failed to shutdown gracefully', timestamp, error);
  });

  // Chrono satisfies both ChronoHandlerRegistrar and ChronoTaskScheduler,
  // so it can be passed directly to narrowly-typed functions.
  const { processor1, processor2 } = registerHandlers(chrono);

  const taskCompletions = [
    new Promise((resolve) => processor1.once(ProcessorEvents.TASK_COMPLETED, resolve)),
    new Promise((resolve) => processor2.once(ProcessorEvents.TASK_COMPLETED, resolve)),
  ];

  await chrono.start();

  await scheduleTasks(chrono);

  await Promise.all(taskCompletions);

  console.log('stopping the Chrono instance...');

  await chrono.stop();

  console.log('Chrono instance stopped.');
}

main().catch(console.error);
