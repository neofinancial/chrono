import { Chrono } from '@neofinancial/chrono-core';
import { MemoryDatastore } from '@neofinancial/chrono-memory-datastore';

type TaskKind = 'send-test-task';
type TaskData = { someField: number };
type DatastoreOptions = undefined;

async function main() {
  const memoryDatastore = new MemoryDatastore<DatastoreOptions>();
  const chrono = new Chrono<TaskKind, undefined>(memoryDatastore);

  const data: TaskData = {
    someField: 123,
  };

  const result = await chrono.scheduleTask({
    when: new Date(),
    kind: 'send-test-task',
    data,
  });

  console.log('scheduled task:', result);
}

main().catch(console.error);
