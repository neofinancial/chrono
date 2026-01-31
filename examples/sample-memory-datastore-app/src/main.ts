import { Chrono, ChronoEvents, ProcessorEvents } from '@neofinancial/chrono';
import { ChronoMemoryDatastore } from '@neofinancial/chrono-memory-datastore';

type DatastoreOptions = undefined;

type TaskMapping = {
  'async-messaging': { someField: number };
  'send-email': { url: string };
};

async function main() {
  const memoryDatastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();
  const chrono = new Chrono<TaskMapping, DatastoreOptions>(memoryDatastore);

  chrono.on(ChronoEvents.STARTED, ({ startedAt }) => {
    console.log('Chrono successfully started and polling tasks', startedAt);
  });

  chrono.on(ChronoEvents.STOP_ABORTED, ({ error, timestamp }) => {
    console.error('Chrono failed to shutdown gracefully', timestamp, error);
  });

  // Register task handlers
  const processor1 = chrono.registerTaskHandler({
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

  const processor2 = chrono.registerTaskHandler({
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

  // you can attach event listeners to the processors
  const taskCompletions = [
    new Promise((resolve) => processor1.once(ProcessorEvents.TASK_COMPLETED, resolve)),
    new Promise((resolve) => processor2.once(ProcessorEvents.TASK_COMPLETED, resolve)),
  ];

  // Start the Chrono instance
  await chrono.start();

  // Try scheduling tasks
  await chrono.scheduleTask({
    when: new Date(),
    kind: 'async-messaging',
    data: { someField: 123 },
  });

  await chrono.scheduleTask({
    when: new Date(),
    kind: 'send-email',
    data: { url: 'https://example.com' },
  });

  await Promise.all(taskCompletions);

  console.log('stopping the Chrono instance...');

  // Finallly, stop the Chrono instance
  await chrono.stop();

  console.log('Chrono instance stopped.');
}

main().catch(console.error);
