import type { Task } from "@neofinancial/chrono-core";

export class MongoTask implements Task<boolean> {
  public async run() {
    console.log("Running MongoTask");

    return true;
  }
}
