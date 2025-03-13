import { faker } from '@faker-js/faker';
import { describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { Chrono } from '../../src/chrono';
import type { Datastore, Task } from '../../src/datastore';

describe('Chrono', () => {
  type TaskKind = 'send-test-task';
  type TaskData = { someField: number };
  type DatastoreOptions = Record<string, unknown>;

  const mockDatastore = mock<Datastore<DatastoreOptions>>();

  const chrono = new Chrono<TaskKind, DatastoreOptions>(mockDatastore);

  describe('initialize', () => {
    test('emits ready event when chrono is instantiated successfully', async () => {
      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.initialize();

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('ready', { timestamp: expect.any(Date) });
    });
  });

  describe('scheduleTask', () => {
    const mockScheduleInput: Task<TaskKind, TaskData> = {
      id: faker.string.nanoid(),
      kind: 'send-test-task',
      status: 'pending',
      data: { someField: 1 },
      scheduledAt: faker.date.future(),
    };

    test('schedule a task successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockScheduleInput);

      const result = await chrono.scheduleTask({
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      });

      expect(result).toEqual(mockScheduleInput);
    });

    test('calls datastore.schedule successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockScheduleInput);

      await chrono.scheduleTask({
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      });

      expect(mockDatastore.schedule).toHaveBeenCalledOnce();
      expect(mockDatastore.schedule).toHaveBeenCalledWith({
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      });
    });

    test('emits task-scheduled event successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockScheduleInput);

      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.scheduleTask({
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      });

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('task-scheduled', {
        task: mockScheduleInput,
        timestamp: expect.any(Date),
      });
    });

    test('emits task-schedule-fail event when datastore fails', async () => {
      const mockDatastoreError = new Error('Failed to schedule task');

      mockDatastore.schedule.mockRejectedValueOnce(mockDatastoreError);

      const emitSpy = vitest.spyOn(chrono, 'emit');

      const mockScheduleTaskInput = {
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      };

      await expect(chrono.scheduleTask(mockScheduleTaskInput)).rejects.toThrow('Failed to schedule task');

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('task-schedule-failed', {
        error: mockDatastoreError,
        input: mockScheduleTaskInput,
        timestamp: expect.any(Date),
      });
    });
  });
});
