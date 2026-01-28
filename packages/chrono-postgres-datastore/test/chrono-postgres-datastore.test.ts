import { TaskStatus } from '@neofinancial/chrono';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChronoPostgresDatastore, testAccessor } from '../src/chrono-postgres-datastore';
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

  describe('query generation', () => {
    const getTestAccessor = (ds: ChronoPostgresDatastore<TaskMapping>) => ds[testAccessor];

    test('cleanup SELECT query uses correct column names', () => {
      const accessor = getTestAccessor(dataStore);
      const qb = accessor.buildCleanupSelectQuery(new Date());
      const sql = qb.getQuery();

      expect(sql).toContain('"task"."id"');
      expect(sql).toContain('"task"."status"');
      expect(sql).toContain('"task"."completed_at"');
    });

    test('cleanup DELETE query targets correct table', () => {
      const accessor = getTestAccessor(dataStore);
      const qb = accessor.buildCleanupDeleteQuery(['id1', 'id2']);
      const sql = qb.getQuery();

      expect(sql).toContain('DELETE');
      expect(sql).toContain('"chrono_tasks"');
    });
  });

  describe('getEntity', () => {
    test('returns ChronoTaskEntity class', () => {
      const entity = ChronoPostgresDatastore.getEntity();
      expect(entity).toBe(ChronoTaskEntity);
    });
  });
});
