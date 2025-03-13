import type { DataStore, Task } from './datastore';

export interface RegisterTaskHandlerInput<TaskKind, TaskData> {
  kind: TaskKind;
  handler: (task: TaskData) => Promise<void>;
}

export class Chrono<TaskKind, TaskData, DataStoreOptions> {
  private datastore: DataStore<DataStoreOptions>;
  private handler: Map<TaskKind, (task: TaskData) => Promise<void>>;

  constructor(datastore: DataStore<DataStoreOptions>) {
    this.datastore = datastore;

    this.handler = new Map();
  }

  public schedule<TaskData>(frequency: string, grouping: string, taskData: TaskData) {
    // TODO
  }

  public registerTaskHandler(input: RegisterTaskHandlerInput<TaskKind, TaskData>) {
    this.handler.set(input.kind, input.handler);
  }

  public start() {}

  public stop() {}
}
