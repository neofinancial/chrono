import { describe, test, expect, beforeEach } from 'vitest';
import { ChronoMemoryDatastore } from '../../src/chrono-memory-datastore';
import { TaskStatus, type Task } from '@neofinancial/chrono';

describe('ChronoMemoryDatastore DLQ', () => {
  type DatastoreOptions = Record<string, unknown>;
  type TaskMapping = {
    'failed-task': { reason: string };
  };

  let datastore: ChronoMemoryDatastore<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    datastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();
  });

  test('should add a failed task to the DLQ', async () => {
    const task: Task<'failed-task', { reason: string }> = {
      id: '1',
      kind: 'failed-task',
      status: TaskStatus.FAILED,
      data: { reason: 'Something went wrong' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: 1,
      priority: 0,
      idempotencyKey: undefined,
      claimedAt: undefined,
      lastExecutedAt: undefined,
      completedAt: undefined,
    };

    await datastore.addToDlq(task);

    // Assert DLQ contains the task
    expect(datastore['dlqStore'].size).toBe(1);
    const dlqEntry = datastore['dlqStore'].get('1');
    expect(dlqEntry?.task.id).toBe('1');
    expect(dlqEntry?.task.status).toBe(TaskStatus.FAILED);
  });

  test('should redrive tasks from DLQ back to main queue', async () => {
    const task: Task<'failed-task', { reason: string }> = {
      id: '2',
      kind: 'failed-task',
      status: TaskStatus.FAILED,
      data: { reason: 'Temporary issue' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: 1,
      priority: 0,
      idempotencyKey: undefined,
      claimedAt: undefined,
      lastExecutedAt: undefined,
      completedAt: undefined,
    };

    await datastore.addToDlq(task);
    await datastore.redriveFromDlq();

    // Assert DLQ is now empty
    expect(datastore['dlqStore'].size).toBe(0);

    // Assert main store has the redriven task
    expect(datastore['store'].size).toBe(1);
    const redrivenTask = datastore['store'].get('2');
    expect(redrivenTask?.status).toBe(TaskStatus.PENDING);
  });

  test('should not fail when DLQ is empty during redrive', async () => {
    await datastore.redriveFromDlq();

    expect(datastore['dlqStore'].size).toBe(0);
    expect(datastore['store'].size).toBe(0);
  });

  test('should move task to DLQ after reaching max retries and allow redrive', async () => {
    const maxRetries = 2;

    // Simulate a task that failed max times
    const task: Task<'failed-task', { reason: string }> = {
      id: '3',
      kind: 'failed-task',
      status: TaskStatus.CLAIMED,
      data: { reason: 'Keep failing' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: maxRetries,
      priority: 0,
      idempotencyKey: undefined,
      claimedAt: new Date(),
      lastExecutedAt: undefined,
      completedAt: undefined,
    };

    // Add it to main store
    datastore['store'].set(task.id, task);

    // Mark as FAILED and move to DLQ
    await datastore.fail(task.id);
    await datastore.addToDlq(task);

    // DLQ should now contain the task
    expect(datastore['dlqStore'].size).toBe(1);
    const dlqEntry = datastore['dlqStore'].get(task.id);
    expect(dlqEntry?.task.status).toBe(TaskStatus.FAILED);

    // Redrive the DLQ task
    await datastore.redriveFromDlq();

    // DLQ should be empty, main store should contain the task
    expect(datastore['dlqStore'].size).toBe(0);
    const redrivenTask = datastore['store'].get(task.id);
    expect(redrivenTask?.status).toBe(TaskStatus.PENDING);
    expect(redrivenTask?.retryCount).toBe(maxRetries); // retry count preserved
  });
});
