import { Chrono } from '@neofinancial/chrono-core';
import { ChronoMemoryDatastore } from '@neofinancial/chrono-memory-datastore';

type DatastoreOptions = undefined;

type TaskMapping = {
  'async-messaging': { someField: number };
  'send-email': { url: string };
};

async function main() {
  const memoryDatastore = new ChronoMemoryDatastore<DatastoreOptions>();
  const chrono = new Chrono<TaskMapping, undefined>(memoryDatastore);

  const data = {
    someField: 123,
  };

  const result = await chrono.scheduleTask({
    when: new Date(),
    kind: 'async-messaging',
    data,
  });

  console.log('scheduled task:', result);
}

main().catch(console.error);
