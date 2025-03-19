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

  const data = {
    someField: 123,
  };

  chrono.registerTaskHandler({
    kind: 'async-messaging',
    handler: async (task) => {
      console.log('async-messaging task handler:', task);
    },
  });

  chrono.registerTaskHandler({
    kind: 'send-email',
    handler: async (task) => {
      console.log('send-email task handler:', task);
    },
  });

  const result = await chrono.scheduleTask({
    when: new Date(),
    kind: 'async-messaging',
    data,
  });

  console.log('scheduled task:', result);

  const result2 = await chrono.scheduleTask({
    when: new Date(),
    kind: 'send-email',
    data: {
      url: 'https://example.com',
    },
  });

  console.log('scheduled task:', result2);
}

main().catch(console.error);
