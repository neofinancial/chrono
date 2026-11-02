import { performance } from 'node:perf_hooks';
import type {
  ClaimTaskInput,
  Datastore,
  DeleteInput,
  DeleteOptions,
  ScheduleInput,
  Task,
  TaskMappingBase,
} from '@neofinancial/chrono';

import type { LatencyMetrics } from './latency-metrics.js';

export class TimedDatastore<TaskMapping extends TaskMappingBase, DatastoreOptions>
  implements Datastore<TaskMapping, DatastoreOptions>
{
  constructor(
    private readonly delegate: Datastore<TaskMapping, DatastoreOptions>,
    private readonly metrics: LatencyMetrics,
  ) {}

  schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    return this.metrics.measure('datastore.schedule', () => this.delegate.schedule(input));
  }

  delete<TaskKind extends keyof TaskMapping>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    return this.metrics.measure('datastore.delete', () =>
      typeof key === 'string'
        ? this.delegate.delete<TaskKind>(key, options)
        : this.delegate.delete<TaskKind>(key, options),
    );
  }

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const startedAt = performance.now();
    try {
      const task = await this.delegate.claim(input);
      this.metrics.record(task ? 'datastore.claim.hit' : 'datastore.claim.miss', performance.now() - startedAt);
      return task;
    } catch (error) {
      this.metrics.record('datastore.claim.error', performance.now() - startedAt);
      throw error;
    }
  }

  retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    return this.metrics.measure('datastore.retry', () => this.delegate.retry<TaskKind>(taskId, retryAt));
  }

  complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    return this.metrics.measure('datastore.complete', () => this.delegate.complete<TaskKind>(taskId));
  }

  fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    return this.metrics.measure('datastore.fail', () => this.delegate.fail<TaskKind>(taskId));
  }
}
