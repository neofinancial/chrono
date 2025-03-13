import { faker } from '@faker-js/faker';
import { describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { Datastore, Task } from '../../src/chrono';
import { Chrono } from '../../src/chrono';

describe('Chrono', () => {
  type TaskKind = 'send-test-task';
  type TaskData = { someField: number };
  type DatastoreOptions = Record<string, unknown>;

  const mockDatastore = mock<Datastore<DatastoreOptions>>();

  const chrono = new Chrono<TaskKind, DatastoreOptions>(mockDatastore);

  describe('scheduleTask', () => {
    test('schedule a task successfully', async () => {
      const mockScheduleInput: Task<TaskKind, TaskData> = {
        id: faker.string.nanoid(),
        kind: 'send-test-task',
        status: 'pending',
        data: { someField: 1 },
        scheduledAt: faker.date.future(),
      };

      mockDatastore.schedule.mockResolvedValueOnce(mockScheduleInput);

      const result = await chrono.scheduleTask({
        when: mockScheduleInput.scheduledAt,
        kind: mockScheduleInput.kind,
        data: mockScheduleInput.data,
      });

      expect(result).toEqual(mockScheduleInput);
    });

    test('emits task-scheduled event successfully', async () => {
      const mockScheduleInput: Task<TaskKind, TaskData> = {
        id: faker.string.nanoid(),
        kind: 'send-test-task',
        status: 'pending',
        data: { someField: 1 },
        scheduledAt: faker.date.future(),
      };

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
  });
});
