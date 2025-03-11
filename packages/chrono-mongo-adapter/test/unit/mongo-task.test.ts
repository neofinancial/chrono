import { describe, expect, test } from "vitest";

import { MongoTask } from "../../src/mongo-task";

describe("MongoTask", () => {
  const mongoTask = new MongoTask();

  describe("run", () => {
    test("should successfully run mongo task", async () => {
      await expect(mongoTask.run()).resolves.toBeTruthy();
    });
  });
});
