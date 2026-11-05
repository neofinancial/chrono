import type { TaskMappingBase } from './chrono';
import type { Datastore, Task } from './datastore';

export type ClaimManyInput<TaskKind> = {
  kind: TaskKind;
  batchSize: number;
  claimStaleTimeoutMs: number;
};

export type RetryManyItem = {
  taskId: string;
  retryAt: Date;
};

export type BulkWriteResult<TaskKind, TaskData> = {
  succeeded: Task<TaskKind, TaskData>[];
  failed: { taskId: string; error: unknown }[];
};

export interface BulkDatastore<TaskMapping extends TaskMappingBase, _DatastoreOptions> {
  claimMany<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimManyInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>[]>;

  completeMany<TaskKind extends keyof TaskMapping>(
    taskIds: string[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>>;

  retryMany<TaskKind extends keyof TaskMapping>(
    items: RetryManyItem[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>>;

  failMany<TaskKind extends keyof TaskMapping>(
    taskIds: string[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>>;
}

/**
 * Runtime guard for {@link BulkDatastore} support on a {@link Datastore} instance.
 */
export function isBulkDatastore<TaskMapping extends TaskMappingBase, DatastoreOptions>(
  datastore: Datastore<TaskMapping, DatastoreOptions>,
): datastore is Datastore<TaskMapping, DatastoreOptions> & BulkDatastore<TaskMapping, DatastoreOptions> {
  return (
    'claimMany' in datastore &&
    typeof datastore.claimMany === 'function' &&
    'completeMany' in datastore &&
    typeof datastore.completeMany === 'function' &&
    'retryMany' in datastore &&
    typeof datastore.retryMany === 'function' &&
    'failMany' in datastore &&
    typeof datastore.failMany === 'function'
  );
}
