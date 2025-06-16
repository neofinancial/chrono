import type { Datastore, Task } from 'datastore';
import type { TaskMappingBase } from '..';
import { type BackoffStrategyOptions, backoffStrategyFactory } from '../backoff-strategy';
import type { Processor } from './processor';
import { SimpleProcessor } from './simple-processor';

export type ProcessorConfiguration = {
  maxConcurrency?: number;
  claimIntervalMs?: number;
  claimStaleTimeoutMs?: number;
  idleIntervalMs?: number;
  taskHandlerTimeoutMs?: number;
  taskHandlerMaxRetries?: number;
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
