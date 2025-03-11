import { describe, expect, test } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { Scheduler, type Task } from '../../src/scheduler';

describe('Scheduler', () => {
  const scheduler = new Scheduler();

  describe('schedule', () => {
    test('should schedule a task', async () => {
      const mockTask = mock<Task<boolean>>();

      await expect(scheduler.schedule(mockTask)).resolves.toBeTruthy();
    });
  });

  describe('run', () => {
    test('should schedule a task', async () => {
      const mockTask1 = mock<Task<boolean>>();
      const mockTask2 = mock<Task<boolean>>();

      await Promise.all([scheduler.schedule(mockTask1), scheduler.schedule(mockTask2)]);

      await expect(scheduler.run()).resolves.toBeTruthy();

      expect(mockTask1.run).toHaveBeenCalledOnce();
      expect(mockTask2.run).toHaveBeenCalledOnce();
    });
  });
});
