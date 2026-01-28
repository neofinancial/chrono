import { TaskStatus } from '@neofinancial/chrono';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChronoPostgresDatastore } from '../src/chrono-postgres-datastore';
import { ChronoTaskEntity } from '../src/chrono-task.entity';

const DATABASE_URL = process.env.DATABASE_URL;

type TaskMapping = {
  test: { value: string };
  other: { data: number };
};

describe.skipIf(!DATABASE_URL)('ChronoPostgresDatastore', () => {
  let dataSource: DataSource;
  let dataStore: ChronoPostgresDatastore<TaskMapping>;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL!,
      entities: [ChronoTaskEntity],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    dataStore = new ChronoPostgresDatastore();
    await dataStore.initialize(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(ChronoTaskEntity).clear();
  });

  describe('initialize', () => {
    test('throws if already initialized', async () => {
      const ds = new ChronoPostgresDatastore();
      await ds.initialize(dataSource);

      await expect(ds.initialize(dataSource)).rejects.toThrow('DataSource already initialized');
    });

    test('operations wait for deferred initialization', async () => {
      const ds = new ChronoPostgresDatastore<TaskMapping>();

      // Start scheduling before initialization - it should wait
      const schedulePromise = ds.schedule({
        kind: 'test',
        data: { value: 'deferred' },
        priority: 1,
        when: new Date(),
      });

      // Initialize after a small delay
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ds.initialize(dataSource);

      // The schedule should complete successfully
      const task = await schedulePromise;
      expect(task.id).toBeDefined();
      expect(task.data).toEqual({ value: 'deferred' });
    });
  });

  describe('schedule', () => {
    test('creates task with correct properties', async () => {
      const when = new Date();
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'hello' },
        priority: 5,
        when,
      });

      expect(task).toMatchObject({
        kind: 'test',
        status: TaskStatus.PENDING,
        data: { value: 'hello' },
        priority: 5,
        retryCount: 0,
      });
      expect(task.id).toBeDefined();
      expect(task.scheduledAt).toEqual(when);
      expect(task.originalScheduleDate).toEqual(when);
    });

    test('stores task in database', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'stored' },
        priority: 1,
        when: new Date(),
      });

      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found).not.toBeNull();
      expect(found!.kind).toBe('test');
      expect(found!.data).toEqual({ value: 'stored' });
    });

    test('returns existing task for duplicate idempotency key', async () => {
      const task1 = await dataStore.schedule({
        kind: 'test',
        data: { value: 'first' },
        priority: 1,
        when: new Date(),
        idempotencyKey: 'unique-key',
      });

      const task2 = await dataStore.schedule({
        kind: 'test',
        data: { value: 'second' },
        priority: 1,
        when: new Date(),
        idempotencyKey: 'unique-key',
      });

      expect(task1.id).toBe(task2.id);
      expect(task2.data).toEqual({ value: 'first' });
    });

    test('allows same idempotency key for different task kinds', async () => {
      const task1 = await dataStore.schedule({
        kind: 'test',
        data: { value: 'test-task' },
        priority: 1,
        when: new Date(),
        idempotencyKey: 'shared-key',
      });

      // Different kind but same key - should fail due to unique constraint on idempotencyKey alone
      await expect(
        dataStore.schedule({
          kind: 'other',
          data: { data: 123 },
          priority: 1,
          when: new Date(),
          idempotencyKey: 'shared-key',
        }),
      ).resolves.toMatchObject({ id: task1.id });
    });

    test('uses provided entityManager for transaction participation', async () => {
      let taskId: string | undefined;

      // Start a transaction, schedule a task, then rollback
      await dataSource
        .transaction(async (entityManager) => {
          const task = await dataStore.schedule({
            kind: 'test',
            data: { value: 'transactional' },
            priority: 1,
            when: new Date(),
            datastoreOptions: { entityManager },
          });
          taskId = task.id;

          // Task should be visible within the transaction
          const found = await entityManager.findOne(ChronoTaskEntity, { where: { id: taskId } });
          expect(found).not.toBeNull();

          // Rollback by throwing
          throw new Error('Rollback');
        })
        .catch(() => {});

      // Task should not exist after rollback
      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: taskId! });
      expect(found).toBeNull();
    });
  });

  describe('claim', () => {
    test('returns undefined when no tasks available', async () => {
      const result = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(result).toBeUndefined();
    });

    test('claims pending task with scheduledAt in the past', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'claim-me' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      expect(claimed).toMatchObject({
        id: task.id,
        status: TaskStatus.CLAIMED,
      });
      expect(claimed!.claimedAt).toBeDefined();
    });

    test('does not claim task scheduled in the future', async () => {
      await dataStore.schedule({
        kind: 'test',
        data: { value: 'future' },
        priority: 1,
        when: new Date(Date.now() + 60000),
      });

      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(claimed).toBeUndefined();
    });

    test('claims tasks in priority order (higher first)', async () => {
      const low = await dataStore.schedule({
        kind: 'test',
        data: { value: 'low' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      const high = await dataStore.schedule({
        kind: 'test',
        data: { value: 'high' },
        priority: 10,
        when: new Date(Date.now() - 1000),
      });

      const first = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      const second = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      expect(first!.id).toBe(high.id);
      expect(second!.id).toBe(low.id);
    });

    test('claims tasks in scheduledAt order (earlier first) when same priority', async () => {
      await dataStore.schedule({
        kind: 'test',
        data: { value: 'later' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      const earlier = await dataStore.schedule({
        kind: 'test',
        data: { value: 'earlier' },
        priority: 1,
        when: new Date(Date.now() - 2000),
      });

      const first = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(first!.id).toBe(earlier.id);
    });

    test('reclaims stale claimed task', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'stale' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      // First claim
      await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      // Backdate claimedAt to make it stale
      await dataSource.query(`UPDATE chrono_tasks SET claimed_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`, [
        task.id,
      ]);

      // Should be able to reclaim
      const reclaimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 5000 });
      expect(reclaimed!.id).toBe(task.id);
    });

    test('only claims tasks of specified kind', async () => {
      await dataStore.schedule({
        kind: 'other',
        data: { data: 123 },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(claimed).toBeUndefined();
    });

    test('does not claim completed tasks', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'completed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await dataStore.complete(task.id);

      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(claimed).toBeUndefined();
    });

    test('does not claim failed tasks', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'failed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await dataStore.fail(task.id);

      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      expect(claimed).toBeUndefined();
    });

    test('does not claim non-stale claimed task', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'claimed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      // First claim succeeds
      const first = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 });
      expect(first!.id).toBe(task.id);

      // Second claim should return undefined (task is claimed but not stale)
      const second = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 });
      expect(second).toBeUndefined();
    });

    test('concurrent claims get different tasks (SKIP LOCKED)', async () => {
      // Create multiple tasks
      const tasks = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          dataStore.schedule({
            kind: 'test',
            data: { value: `task-${i}` },
            priority: 1,
            when: new Date(Date.now() - 1000),
          }),
        ),
      );

      // Claim all tasks concurrently
      const claims = await Promise.all([
        dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 }),
        dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 }),
        dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 }),
        dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 }),
        dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 }),
      ]);

      // All claims should succeed
      const claimedIds = claims.map((c) => c!.id);
      expect(claimedIds).toHaveLength(5);

      // All claimed IDs should be unique (no duplicates)
      const uniqueIds = new Set(claimedIds);
      expect(uniqueIds.size).toBe(5);

      // All claimed IDs should be from our created tasks
      const taskIds = new Set(tasks.map((t) => t.id));
      for (const id of claimedIds) {
        expect(taskIds.has(id)).toBe(true);
      }
    });
  });

  describe('complete', () => {
    test('marks task as completed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'complete-me' },
        priority: 1,
        when: new Date(),
      });

      const completed = await dataStore.complete(task.id);

      expect(completed).toMatchObject({
        id: task.id,
        status: TaskStatus.COMPLETED,
      });
      expect(completed.completedAt).toBeDefined();
      expect(completed.lastExecutedAt).toBeDefined();
    });

    test('throws for non-existent task', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await expect(dataStore.complete(fakeId)).rejects.toThrow(`Task with ID ${fakeId} not found`);
    });
  });

  describe('fail', () => {
    test('marks task as failed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'fail-me' },
        priority: 1,
        when: new Date(),
      });

      const failed = await dataStore.fail(task.id);

      expect(failed).toMatchObject({
        id: task.id,
        status: TaskStatus.FAILED,
      });
      expect(failed.lastExecutedAt).toBeDefined();
    });

    test('throws for non-existent task', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await expect(dataStore.fail(fakeId)).rejects.toThrow(`Task with ID ${fakeId} not found`);
    });
  });

  describe('retry', () => {
    test('resets task to pending with new scheduledAt', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'retry-me' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      const retryAt = new Date(Date.now() + 5000);
      const retried = await dataStore.retry(task.id, retryAt);

      expect(retried).toMatchObject({
        id: task.id,
        status: TaskStatus.PENDING,
        retryCount: 1,
      });
      expect(retried.scheduledAt.getTime()).toBeCloseTo(retryAt.getTime(), -2);
      expect(retried.originalScheduleDate).toEqual(task.originalScheduleDate);
    });

    test('increments retryCount on each retry', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'multi-retry' },
        priority: 1,
        when: new Date(),
      });

      await dataStore.retry(task.id, new Date());
      await dataStore.retry(task.id, new Date());
      const retried = await dataStore.retry(task.id, new Date());

      expect(retried.retryCount).toBe(3);
    });

    test('throws for non-existent task', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await expect(dataStore.retry(fakeId, new Date())).rejects.toThrow(`Task with ID ${fakeId} not found`);
    });

    test('clears claimedAt after retry', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'claim-then-retry' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      // Claim the task
      const claimed = await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 60000 });
      expect(claimed!.claimedAt).toBeDefined();

      // Retry should clear claimedAt
      const retried = await dataStore.retry(task.id, new Date(Date.now() + 5000));
      expect(retried.claimedAt).toBeUndefined();

      // Verify in database
      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found!.claimedAt).toBeNull();
    });
  });

  describe('delete', () => {
    test('deletes pending task by id', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'delete-me' },
        priority: 1,
        when: new Date(),
      });

      const deleted = await dataStore.delete(task.id);

      expect(deleted!.id).toBe(task.id);
      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found).toBeNull();
    });

    test('deletes pending task by kind and idempotencyKey', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'delete-by-key' },
        priority: 1,
        when: new Date(),
        idempotencyKey: 'delete-key',
      });

      const deleted = await dataStore.delete({ kind: 'test', idempotencyKey: 'delete-key' });

      expect(deleted!.id).toBe(task.id);
    });

    test('throws when deleting non-pending task without force', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'claimed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      await expect(dataStore.delete(task.id)).rejects.toThrow('cannot be deleted');
    });

    test('deletes non-pending task with force option', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'force-delete' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      const deleted = await dataStore.delete(task.id, { force: true });

      expect(deleted!.id).toBe(task.id);
    });

    test('returns undefined for non-existent task with force option', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await dataStore.delete(fakeId, { force: true });
      expect(result).toBeUndefined();
    });

    test('throws when deleting non-existent task by kind and idempotencyKey', async () => {
      await expect(dataStore.delete({ kind: 'test', idempotencyKey: 'non-existent-key' })).rejects.toThrow(
        'cannot be deleted',
      );
    });

    test('returns undefined for non-existent task by kind and idempotencyKey with force', async () => {
      const result = await dataStore.delete({ kind: 'test', idempotencyKey: 'non-existent-key' }, { force: true });
      expect(result).toBeUndefined();
    });

    test('deletes non-pending task by kind and idempotencyKey with force', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { value: 'force-delete-by-key' },
        priority: 1,
        when: new Date(Date.now() - 1000),
        idempotencyKey: 'force-key',
      });
      await dataStore.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });

      const deleted = await dataStore.delete({ kind: 'test', idempotencyKey: 'force-key' }, { force: true });

      expect(deleted!.id).toBe(task.id);
      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found).toBeNull();
    });
  });

  describe('cleanup', () => {
    const createDataStoreWithConfig = async (config: Parameters<typeof ChronoPostgresDatastore>[0]) => {
      const ds = new ChronoPostgresDatastore<TaskMapping>(config);
      await ds.initialize(dataSource);
      return ds;
    };

    const waitForCleanup = () => new Promise((resolve) => setTimeout(resolve, 50));

    test('deletes completed tasks older than TTL after claim', async () => {
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
      });

      const task = await ds.schedule({
        kind: 'test',
        data: { value: 'old-task' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task.id);

      // Backdate to be older than TTL
      await dataSource.query(`UPDATE chrono_tasks SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = $1`, [
        task.id,
      ]);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found).toBeNull();
    });

    test('preserves completed tasks newer than TTL', async () => {
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 3600,
        cleanupIntervalSeconds: 0,
      });

      const task = await ds.schedule({
        kind: 'test',
        data: { value: 'recent-task' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task.id);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      const found = await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task.id });
      expect(found).not.toBeNull();
    });

    test('respects cleanup interval', async () => {
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 3600, // 1 hour
      });

      // First task - will be cleaned up
      const task1 = await ds.schedule({
        kind: 'test',
        data: { value: 'task1' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task1.id);
      await dataSource.query(`UPDATE chrono_tasks SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = $1`, [
        task1.id,
      ]);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      expect(await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task1.id })).toBeNull();

      // Second task - should NOT be cleaned up (interval not passed)
      const task2 = await ds.schedule({
        kind: 'test',
        data: { value: 'task2' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(task2.id);
      await dataSource.query(`UPDATE chrono_tasks SET completed_at = NOW() - INTERVAL '2 seconds' WHERE id = $1`, [
        task2.id,
      ]);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      expect(await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: task2.id })).not.toBeNull();
    });

    test('respects batch size limit', async () => {
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
        cleanupBatchSize: 2,
      });

      // Create and complete 4 tasks
      const tasks = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          ds.schedule({
            kind: 'test',
            data: { value: `task-${i}` },
            priority: 1,
            when: new Date(Date.now() - 1000),
          }),
        ),
      );
      await Promise.all(tasks.map((t) => ds.complete(t.id)));

      // Backdate all
      await dataSource.query(`UPDATE chrono_tasks SET completed_at = NOW() - INTERVAL '2 seconds' WHERE status = $1`, [
        TaskStatus.COMPLETED,
      ]);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      const remaining = await dataSource.getRepository(ChronoTaskEntity).count();
      expect(remaining).toBe(2); // Only 2 deleted (batch size), 2 remain
    });

    test('calls onCleanupError callback on failure', async () => {
      const onCleanupError = vi.fn();
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
        onCleanupError,
      });

      // Create a task to ensure claim triggers cleanup
      await ds.schedule({
        kind: 'test',
        data: { value: 'error-test' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      // Mock cleanup to throw - this tests that errors are properly passed to onCleanupError
      const cleanupError = new Error('Cleanup failed');
      vi.spyOn(ds as never, 'cleanupCompletedTasks').mockRejectedValue(cleanupError);

      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
    });

    test('preserves pending and failed tasks during cleanup', async () => {
      const ds = await createDataStoreWithConfig({
        completedDocumentTTLSeconds: 1,
        cleanupIntervalSeconds: 0,
      });

      // Create tasks in different states
      const pendingTask = await ds.schedule({
        kind: 'test',
        data: { value: 'pending' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });

      const failedTask = await ds.schedule({
        kind: 'test',
        data: { value: 'failed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.fail(failedTask.id);

      const completedTask = await ds.schedule({
        kind: 'test',
        data: { value: 'completed' },
        priority: 1,
        when: new Date(Date.now() - 1000),
      });
      await ds.complete(completedTask.id);

      // Backdate all tasks to be older than TTL
      await dataSource.query(`UPDATE chrono_tasks SET created_at = NOW() - INTERVAL '2 seconds'`);
      await dataSource.query(`UPDATE chrono_tasks SET completed_at = NOW() - INTERVAL '2 seconds' WHERE status = $1`, [
        TaskStatus.COMPLETED,
      ]);

      // Trigger cleanup
      await ds.claim({ kind: 'test', claimStaleTimeoutMs: 1000 });
      await waitForCleanup();

      // Pending task should still exist
      expect(await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: pendingTask.id })).not.toBeNull();

      // Failed task should still exist
      expect(await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: failedTask.id })).not.toBeNull();

      // Completed task should be deleted
      expect(await dataSource.getRepository(ChronoTaskEntity).findOneBy({ id: completedTask.id })).toBeNull();
    });
  });

  describe('entity metadata', () => {
    test('table name is chrono_tasks', () => {
      const metadata = dataSource.getMetadata(ChronoTaskEntity);
      expect(metadata.tableName).toBe('chrono_tasks');
    });

    test('column mappings are correct', () => {
      const metadata = dataSource.getMetadata(ChronoTaskEntity);

      const columnMappings: Record<string, string> = {
        completedAt: 'completed_at',
        scheduledAt: 'scheduled_at',
        claimedAt: 'claimed_at',
        idempotencyKey: 'idempotency_key',
        originalScheduleDate: 'original_schedule_date',
        lastExecutedAt: 'last_executed_at',
        retryCount: 'retry_count',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      };

      for (const [property, dbColumn] of Object.entries(columnMappings)) {
        const column = metadata.findColumnWithPropertyName(property);
        expect(column?.databaseName, `${property} should map to ${dbColumn}`).toBe(dbColumn);
      }
    });

    test('indexes exist', () => {
      const metadata = dataSource.getMetadata(ChronoTaskEntity);
      const indexNames = metadata.indices.map((i) => i.name);

      expect(indexNames).toContain('idx_chrono_tasks_claim');
      expect(indexNames).toContain('idx_chrono_tasks_cleanup');
      expect(indexNames).toContain('idx_chrono_tasks_idempotency');
    });
  });

  describe('getEntity', () => {
    test('returns ChronoTaskEntity class', () => {
      const entity = ChronoPostgresDatastore.getEntity();
      expect(entity).toBe(ChronoTaskEntity);
    });
  });
});
