import type { Datastore, Task } from '../datastore';
import { SimpleProcessor } from './simple-processor';

export interface Processor {
  start(): void;
  stop(): Promise<void>;
}

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
  return new SimpleProcessor<TaskKind, TaskData, DatastoreOptions>(input);
}
