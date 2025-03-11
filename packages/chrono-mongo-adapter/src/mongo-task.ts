import { Task } from "@neofinancial/chrono-core";

export class MongoTask implements Task {
  public async run() {
    console.log("Running MongoTask");
  }
}
