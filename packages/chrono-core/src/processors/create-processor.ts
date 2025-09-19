import type { Datastore, Task } from 'datastore';
import type { TaskMappingBase } from '..';
import { type BackoffStrategyOptions, backoffStrategyFactory } from '../backoff-strategy';
import type { Processor } from './processor';
import { SimpleProcessor } from './simple-processor';

/**
 * Configuration for the processor.
 */
export type ProcessorConfiguration = {
  /** The maximum number of concurrent tasks that the processor will use when processing. @default 1 */
  maxConcurrency?: number;
  /** The interval at which the processor will poll for tasks when previous poll returned a task @default 50ms */
  claimIntervalMs?: number;
  /** The maximum time a task can be claimed for processing. Before it will be considered stale and claimed again @default 10000ms */
  claimStaleTimeoutMs?: number;
  /** The interval at which the processor will idle. @default 5000ms */
  idleIntervalMs?: number;
  /** The interval at which the processor will poll for tasks when previous poll does not return task for processing @default 5000ms */
  taskHandlerTimeoutMs?: number;
  /** The maximum number of retries for a task handler, before task is marked as failed. @default 10 */
  taskHandlerMaxRetries?: number;
  /** The interval at which the processor will poll for tasks when an unexpected error occurs. @default 20000ms */
  processLoopRetryIntervalMs?: number;
};

export type CreateProcessorInput<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
> = {
  kind: TaskKind;
  datastore: Datastore<TaskMapping, DatastoreOptions>;
  handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  configuration?: ProcessorConfiguration;
  backoffStrategyOptions?: BackoffStrategyOptions;
};

export function createProcessor<
  TaskKind extends Extract<keyof TaskMapping, string>,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
>(input: CreateProcessorInput<TaskKind, TaskMapping, DatastoreOptions>): Processor<TaskKind, TaskMapping> {
  const backoffStrategy = backoffStrategyFactory(input.backoffStrategyOptions);
  // add more processors here
  return new SimpleProcessor<TaskKind, TaskMapping, DatastoreOptions>(
    input.datastore,
    input.kind,
    input.handler,
    backoffStrategy,
    input.configuration,
  );
}
