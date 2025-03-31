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

  // you can attach event listeners to the processors
  const taskCompletions = [
    new Promise((resolve) => processor1.once('task.completed', resolve)),
    new Promise((resolve) => processor2.once('task.completed', resolve)),
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
