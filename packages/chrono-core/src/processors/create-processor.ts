import type { Datastore, Task } from 'datastore';
import type { Processor } from './processor';
import { SimpleProcessor } from './simple-processor';

export type ProcessorConfiguration = {
  maxConcurrency: number;
};

export type CreateProcessorInput<TaskKind, TaskData, DatastoreOptions> = {
  kind: TaskKind;
  datastore: Datastore<TaskKind, TaskData, DatastoreOptions>;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  configuration: ProcessorConfiguration;
};

export function createProcessor<TaskKind, TaskData, DatastoreOptions>(
  input: CreateProcessorInput<TaskKind, TaskData, DatastoreOptions>,
): Processor {
  // add more processors here
  return new SimpleProcessor<TaskKind, TaskData, DatastoreOptions>({
    datastore: input.datastore,
    kind: input.kind,
    handler: input.handler,
    maxConcurrency: input.configuration.maxConcurrency,
  });
}
