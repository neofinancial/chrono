import { faker } from '@faker-js/faker';
import { describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { Chrono } from '../../src/chrono';
import { type Datastore, type Task, TaskStatus } from '../../src/datastore';

describe('Chrono', () => {
  type TaskData = { someField: number };
  type TaskMapping = {
    'send-test-task': TaskData;
  };
  type DatastoreOptions = Record<string, unknown>;
  const mockDatastore = mock<Datastore<TaskMapping, DatastoreOptions>>();

  const chrono = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);

  const mockTask: Task<keyof TaskMapping, TaskData> = {
    id: faker.string.nanoid(),
    kind: 'send-test-task',
    status: TaskStatus.PENDING,
    data: { someField: 1 },
    priority: 0,
    idempotencyKey: faker.string.nanoid(),
    originalScheduleDate: faker.date.future(),
    scheduledAt: faker.date.future(),
    retryCount: 0,
  };

  describe('start', () => {
    test('emits ready event when chrono is instantiated successfully', async () => {
      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.start();

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('ready', {
        timestamp: expect.any(Date),
      });
    });
  });

  describe('stop', () => {
    test('emits stopped and close event when chrono is stopped successfully', async () => {
      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.stop();

      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenNthCalledWith(1, 'stopped', {
        timestamp: expect.any(Date),
      });
      expect(emitSpy).toHaveBeenNthCalledWith(2, 'close', {
        timestamp: expect.any(Date),
      });
    });
  });

  describe('scheduleTask', () => {
    test('schedule a task successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockTask);

      const result = await chrono.scheduleTask({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });

      expect(result).toEqual(mockTask);
    });

    test('calls datastore.schedule successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockTask);

      await chrono.scheduleTask({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });

      expect(mockDatastore.schedule).toHaveBeenCalledOnce();
      expect(mockDatastore.schedule).toHaveBeenCalledWith({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });
    });

    test('emits task-scheduled event successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockTask);

      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.scheduleTask({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('task.scheduled', {
        task: mockTask,
        timestamp: expect.any(Date),
      });
    });

    test('emits task-schedule-fail event when datastore fails', async () => {
      const mockDatastoreError = new Error('Failed to schedule task');

      mockDatastore.schedule.mockRejectedValueOnce(mockDatastoreError);

      const emitSpy = vitest.spyOn(chrono, 'emit');

      const mockScheduleTaskInput = {
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      };

      await expect(chrono.scheduleTask(mockScheduleTaskInput)).rejects.toThrow('Failed to schedule task');

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('task.schedule.failed', {
        error: mockDatastoreError,
        input: mockScheduleTaskInput,
        timestamp: expect.any(Date),
      });
    });
  });

  describe('deleteTask', () => {
    test('calls the datastore to delete a task by id', async () => {
      mockDatastore.delete.mockResolvedValueOnce(mockTask);

      await chrono.deleteTask(mockTask.id);

      expect(mockDatastore.delete).toHaveBeenCalledOnce();
      expect(mockDatastore.delete).toHaveBeenCalledWith(mockTask.id);
    });

    test('returns the deleted task', async () => {
      mockDatastore.delete.mockResolvedValueOnce(mockTask);

      const result = await chrono.deleteTask(mockTask.id);

      expect(result).toEqual(mockTask);
    });

    test('emits a task.deleted event on successful deletion', async () => {
      const emitSpy = vitest.spyOn(chrono, 'emit');

      mockDatastore.delete.mockResolvedValueOnce(mockTask);

      await chrono.deleteTask(mockTask.id);

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('task.deleted', {
        task: mockTask,
        timestamp: expect.any(Date),
      });
    });

    test('emits a task.delete.failed event on failure', async () => {
      const mockDatastoreError = new Error('Failed to delete task');
      const emitSpy = vitest.spyOn(chrono, 'emit');

      mockDatastore.delete.mockRejectedValueOnce(mockDatastoreError);

      await expect(chrono.deleteTask(mockTask.id)).rejects.toThrow('Failed to delete task');

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('task.delete.failed', {
        error: mockDatastoreError,
        taskId: mockTask.id,
        timestamp: expect.any(Date),
      });
    });
  });
});
