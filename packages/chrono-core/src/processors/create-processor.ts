import type { Datastore, Task } from 'datastore';
import type { TaskMappingBase } from '..';
import type { Processor } from './processor';
import { SimpleProcessor } from './simple-processor';

export type ProcessorConfiguration = {
  maxConcurrency: number;
};

export type CreateProcessorInput<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
> = {
  kind: TaskKind;
  datastore: Datastore<TaskMapping, DatastoreOptions>;
  handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  configuration: ProcessorConfiguration;
};

export function createProcessor<
  TaskKind extends Extract<keyof TaskMapping, string>,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
>(input: CreateProcessorInput<TaskKind, TaskMapping, DatastoreOptions>): Processor {
  // add more processors here
  return new SimpleProcessor<TaskKind, TaskMapping, DatastoreOptions>({
    datastore: input.datastore,
    kind: input.kind,
    handler: input.handler,
    maxConcurrency: input.configuration.maxConcurrency,
  });
}
