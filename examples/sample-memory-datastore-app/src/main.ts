import { Chrono } from '@neofinancial/chrono-core';
import { ChronoMemoryDatastore } from '@neofinancial/chrono-memory-datastore';

type DatastoreOptions = undefined;

type TaskMapping = {
  'async-messaging': { someField: number };
  'send-email': { url: string };
};

async function main() {
  const memoryDatastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();
  const chrono = new Chrono<TaskMapping, DatastoreOptions>(memoryDatastore);

  // Register task handlers
  const processor1 = chrono.registerTaskHandler({
    kind: 'async-messaging',
    handler: async (task) => {
      console.log('async-messaging task handler:', task);
    },
  });

  const processor2 = chrono.registerTaskHandler({
    kind: 'send-email',
    handler: async (task) => {
      console.log('send-email task handler:', task);
    },
  });

  // Start the Chrono instance
  await chrono.start();

  // Wait for task processors to finish.
  // May not be necessary since we will call the `chrono.stop()` method next,
  // but this is to test that the scheduled task above are processed.
  const taskCompletions = Promise.all([
    new Promise((resolve) => processor1.once('task-completed', resolve)),
    new Promise((resolve) => processor2.once('task-completed', resolve)),
  ]);

  // Try scheduling tasks
  const result = await chrono.scheduleTask({
    when: new Date(),
    kind: 'async-messaging',
    data: { someField: 123 },
  });

  console.log('scheduled task 1:', result);

  const result2 = await chrono.scheduleTask({
    when: new Date(),
    kind: 'send-email',
    data: { url: 'https://example.com' },
  });

  console.log('scheduled task 2:', result2);

  console.log('stopping the Chrono instance...');

  await taskCompletions;

  // Finallly, stop the Chrono instance
  await chrono.stop();

  console.log('Chrono instance stopped.');
}

main().catch(console.error);
