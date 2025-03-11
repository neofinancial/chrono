import { Scheduler } from '@neofinancial/chrono-core';

import { MongoTask } from './mongo-task';

async function main() {
  const task = new MongoTask();
  const scheduler = new Scheduler();

  await scheduler.schedule(task);
  await scheduler.run();

  console.log('Successfully ran MongoTask!');
}

main().catch(console.error);
