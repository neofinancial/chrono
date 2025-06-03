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
  taskHandlerMaxClaimAttempts?: number;
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
  return new SimpleProcessor<TaskKind, TaskMapping, DatastoreOptions>({
    datastore: input.datastore,
    kind: input.kind,
    handler: input.handler,
    maxConcurrency: input.configuration?.maxConcurrency,
    backoffStrategy,
    claimIntervalMs: input.configuration?.claimIntervalMs,
    idleIntervalMs: input.configuration?.idleIntervalMs,
    taskHandlerTimeoutMs: input.configuration?.taskHandlerTimeoutMs,
    claimStaleTimeoutMs: input.configuration?.claimStaleTimeoutMs,
    taskHandlerMaxClaimAttempts: input.configuration?.taskHandlerMaxClaimAttempts,
  });
}
