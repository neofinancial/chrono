import { Scheduler, type Task } from '@neofinancial/chrono-core';

export class MongoTask implements Task<boolean> {
  public async run() {
    console.log('Running MongoTask');

    return true;
  }
}

(async () => {
  const task = new MongoTask();
  const scheduler = new Scheduler();
  await scheduler.schedule(task);
  await scheduler.run();
})();
