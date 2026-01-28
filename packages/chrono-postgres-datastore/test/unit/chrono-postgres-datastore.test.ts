import { PGlite } from '@electric-sql/pglite';
import { faker } from '@faker-js/faker';
import { TaskStatus } from '@neofinancial/chrono';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChronoPostgresDatastore } from '../../src/chrono-postgres-datastore';
import { TEST_TABLE_NAME } from '../database-setup';
import { createMockDataSource, type MockDataSource } from '../helpers/mock-datasource';

type TaskMapping = {
  test: {
    test: string;
  };
};

const TEST_CLAIM_STALE_TIMEOUT_MS = 1_000; // 1 second

describe('ChronoPostgresDatastore', () => {
  let pglite: PGlite;
  let mockDataSource: MockDataSource;
  let dataStore: ChronoPostgresDatastore<TaskMapping>;

  beforeAll(async () => {
    // Create in-memory PGlite instance
    pglite = new PGlite();

    // Create the table schema
    await pglite.exec(`
      CREATE TABLE IF NOT EXISTS ${TEST_TABLE_NAME} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        data JSONB NOT NULL,
        priority INTEGER DEFAULT 0,
        idempotency_key VARCHAR(255),
        original_schedule_date TIMESTAMP WITH TIME ZONE NOT NULL,
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
        claimed_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        last_executed_at TIMESTAMP WITH TIME ZONE,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Create indexes
    await pglite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chrono_tasks_idempotency_key
      ON ${TEST_TABLE_NAME} (idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    mockDataSource = createMockDataSource(pglite);

    dataStore = new ChronoPostgresDatastore({});

    await dataStore.initialize(mockDataSource as unknown as Parameters<typeof dataStore.initialize>[0]);
  });

  beforeEach(async () => {
    await pglite.exec(`DELETE FROM ${TEST_TABLE_NAME}`);
  });

  afterAll(async () => {
    await pglite.close();
  });

  describe('initialize', () => {
    test('should throw an error if the DataSource is already set', async () => {
      await expect(() =>
        dataStore.initialize(mockDataSource as unknown as Parameters<typeof dataStore.initialize>[0]),
      ).rejects.toThrow('DataSource already initialized');
    });
  });

  describe('schedule', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(),
    };

    describe('when called with valid input', () => {
      test('should return task with correct properties', async () => {
        const task = await dataStore.schedule(input);

        expect(task).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
            priority: input.priority,
            originalScheduleDate: expect.any(Date),
            scheduledAt: expect.any(Date),
            id: expect.any(String),
            retryCount: 0,
          }),
        );
      });

      test('should store task in the database', async () => {
        const task = await dataStore.schedule(input);

        const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);

        expect(result.rows.length).toBe(1);
        expect(result.rows[0]).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
          }),
        );
      });
    });

    describe('idempotency', () => {
      test('should return existing task if one exists with same idempotency key', async () => {
        const idempotencyKey = faker.string.uuid();
        const inputWithIdempotency = {
          kind: 'test' as const,
          data: { test: 'test' },
          priority: 1,
          when: new Date(),
          idempotencyKey,
        };

        const task1 = await dataStore.schedule(inputWithIdempotency);
        const task2 = await dataStore.schedule(inputWithIdempotency);

        expect(task1.id).toEqual(task2.id);
        expect(task1.idempotencyKey).toEqual(task2.idempotencyKey);
      });
    });
  });

  describe('claim', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(Date.now() - 1),
    };

    test('should return undefined when no tasks available', async () => {
      const result = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(result).toBeUndefined();
    });

    test('should claim task in PENDING state with scheduledAt in the past', async () => {
      const task = await dataStore.schedule({
        ...input,
        when: new Date(Date.now() - 1000),
      });

      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: 'CLAIMED',
        }),
      );
    });

    test('should claim task in CLAIMED state with claimedAt in the past (stale)', async () => {
      const scheduledTask = await dataStore.schedule(input);

      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      // Trying to claim again should return undefined (no stale tasks)
      const claimedTaskAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      // Fast forward time to make the claim stale
      const fakeTimer = vi.useFakeTimers();
      fakeTimer.setSystemTime(
        new Date((claimedTask?.claimedAt?.getTime() as number) + TEST_CLAIM_STALE_TIMEOUT_MS + 1),
      );

      const claimedTaskAgainAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });
      fakeTimer.useRealTimers();

      expect(scheduledTask).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
        }),
      );
      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
      expect(claimedTaskAgain).toBeUndefined();
      expect(claimedTaskAgainAgain).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
    });

    test('should claim tasks in priority order (higher priority first)', async () => {
      const lowPriorityTask = await dataStore.schedule({
        ...input,
        priority: 1,
      });
      const highPriorityTask = await dataStore.schedule({
        ...input,
        priority: 10,
      });

      const firstClaimed = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(firstClaimed?.id).toEqual(highPriorityTask.id);

      const secondClaimed = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(secondClaimed?.id).toEqual(lowPriorityTask.id);
    });
  });

  describe('complete', () => {
    test('should mark task as completed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const completedTask = await dataStore.complete(task.id);

      expect(completedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );

      // Verify in database
      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows[0]).toEqual(
        expect.objectContaining({
          status: TaskStatus.COMPLETED,
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.complete(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('fail', () => {
    test('should mark task as failed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const failedTask = await dataStore.fail(task.id);

      expect(failedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.FAILED,
        }),
      );

      // Verify in database
      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows[0]).toEqual(
        expect.objectContaining({
          status: TaskStatus.FAILED,
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.fail(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('retry', () => {
    test('should retry task', async () => {
      const firstScheduleDate = faker.date.past();
      const secondScheduleDate = faker.date.future();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: firstScheduleDate,
      });

      expect(task).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
          retryCount: 0,
        }),
      );

      const taskToRetry = await dataStore.retry(task.id, secondScheduleDate);

      expect(taskToRetry).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.PENDING,
          retryCount: 1,
        }),
      );

      // Verify scheduledAt was updated
      expect(taskToRetry.scheduledAt.getTime()).toBeCloseTo(secondScheduleDate.getTime(), -3);
      // Verify originalScheduleDate was preserved
      expect(taskToRetry.originalScheduleDate.getTime()).toBeCloseTo(firstScheduleDate.getTime(), -3);
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.retry(taskId, new Date())).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('delete', () => {
    test('deletes task by id removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete(task.id);

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('deletes task by task kind and idempotency key removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        idempotencyKey: 'test-idempotency-key',
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete({ kind: task.kind, idempotencyKey: task.idempotencyKey ?? 'undefined' });

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('returns deleted task', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      const deletedTask = await dataStore.delete(task.id);

      expect(deletedTask?.id).toEqual(task.id);
      expect(deletedTask?.kind).toEqual(task.kind);
    });

    test('throws when attempting to delete a task that is not PENDING', async () => {
      const when = new Date(Date.now() - 1000);

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await expect(dataStore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} cannot be deleted as it may not exist or it's not in PENDING status.`,
      );
    });

    test('force deletes non-PENDING task removing from datastore', async () => {
      const when = new Date(Date.now() - 1000);

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await dataStore.delete(task.id, { force: true });

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('noops when force deleting a task that does not exist', async () => {
      const result = await dataStore.delete(faker.string.uuid(), { force: true });
      expect(result).toBeUndefined();
    });
  });

  describe('getEntity', () => {
    test('should return the ChronoTaskEntity class', () => {
      const entity = ChronoPostgresDatastore.getEntity();
      expect(entity.name).toBe('ChronoTaskEntity');
    });
  });

  describe('cleanup', () => {
    // Helper to wait for fire-and-forget cleanup to complete
    const waitForCleanup = () => new Promise((resolve) => setTimeout(resolve, 50));

    test('should delete completed tasks older than TTL after claim', async () => {
      const ds = new ChronoPostgresDatastore<TaskMapping>({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
      });
      await ds.initialize(mockDataSource as unknown as Parameters<typeof ds.initialize>[0]);

      // Create a task and complete it
      const task = await ds.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task.id);

      // Backdate completed_at to be older than TTL
      await pglite.exec(
        `UPDATE ${TEST_TABLE_NAME} SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = '${task.id}'`,
      );

      // Trigger cleanup via claim
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('should not delete completed tasks newer than TTL', async () => {
      const ds = new ChronoPostgresDatastore<TaskMapping>({
        completedDocumentTTLSeconds: 3600,
        cleanupIntervalSeconds: 0,
      });
      await ds.initialize(mockDataSource as unknown as Parameters<typeof ds.initialize>[0]);

      const task = await ds.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task.id);

      // Trigger cleanup via claim - task should NOT be deleted (completed just now)
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(1);
    });

    test('should respect cleanup interval', async () => {
      const ds = new ChronoPostgresDatastore<TaskMapping>({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 3600,
      });
      await ds.initialize(mockDataSource as unknown as Parameters<typeof ds.initialize>[0]);

      // Create and complete first task
      const task1 = await ds.schedule({
        kind: 'test',
        data: { test: 'test1' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task1.id);

      // Backdate to be older than TTL
      await pglite.exec(
        `UPDATE ${TEST_TABLE_NAME} SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = '${task1.id}'`,
      );

      // First claim triggers cleanup (interval starts at epoch)
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      const result1 = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task1.id]);
      expect(result1.rows.length).toBe(0);

      // Create and complete second task
      const task2 = await ds.schedule({
        kind: 'test',
        data: { test: 'test2' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task2.id);

      // Backdate to be older than TTL
      await pglite.exec(
        `UPDATE ${TEST_TABLE_NAME} SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = '${task2.id}'`,
      );

      // Second claim should NOT trigger cleanup (interval not passed)
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      // task2 should still exist because cleanup interval hasn't passed
      const result2 = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task2.id]);
      expect(result2.rows.length).toBe(1);
    });

    test('should call onCleanupError when cleanup fails', async () => {
      const onCleanupError = vi.fn();

      // Create a datasource that works for claim but fails during cleanup's SELECT
      const failingCleanupDataSource = {
        ...mockDataSource,
        createQueryBuilder: (...args: unknown[]) => {
          const qb = mockDataSource.createQueryBuilder(...args);
          // If called with entity and alias (cleanup SELECT), make getMany fail
          if (args.length === 2) {
            return {
              ...qb,
              select: () => ({
                where: () => ({
                  andWhere: () => ({
                    limit: () => ({
                      getMany: () => Promise.reject(new Error('Cleanup failed')),
                    }),
                  }),
                }),
              }),
            };
          }
          return qb;
        },
      };

      const ds = new ChronoPostgresDatastore<TaskMapping>({
        cleanupIntervalSeconds: 0,
        onCleanupError,
      });
      await ds.initialize(failingCleanupDataSource as unknown as Parameters<typeof ds.initialize>[0]);

      // Schedule task using the main datastore (shares same pglite)
      await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      // Trigger cleanup via claim
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      expect(onCleanupError).toHaveBeenCalledWith(expect.any(Error));
      expect((onCleanupError.mock.calls[0][0] as Error).message).toBe('Cleanup failed');
    });

    test('should respect cleanup batch size', async () => {
      const ds = new ChronoPostgresDatastore<TaskMapping>({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
        cleanupBatchSize: 2,
      });
      await ds.initialize(mockDataSource as unknown as Parameters<typeof ds.initialize>[0]);

      // Create and complete 3 tasks
      const tasks = await Promise.all(
        [1, 2, 3].map((i) =>
          ds.schedule({
            kind: 'test',
            data: { test: `test${i}` },
            priority: 1,
            when: new Date(Date.now() - 1000),
          }),
        ),
      );
      await Promise.all(tasks.map((t) => ds.complete(t.id)));

      // Backdate all tasks to be older than TTL
      await pglite.exec(
        `UPDATE ${TEST_TABLE_NAME} SET completed_at = NOW() - INTERVAL '2 seconds' WHERE status = '${TaskStatus.COMPLETED}'`,
      );

      // Trigger cleanup - should only delete 2 tasks (batch size)
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });
      await waitForCleanup();

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE status = $1`, [TaskStatus.COMPLETED]);
      expect(result.rows.length).toBe(1);
    });
  });
});
