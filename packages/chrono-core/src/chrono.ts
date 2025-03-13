import { EventEmitter } from 'node:stream';

export type TaskStatus = 'pending' | 'claimed' | 'completed' | 'failed';

export type Task<TaskKind, TaskData> = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  data: TaskData;
  scheduledAt: Date;
};

type ScheduleInput<TaskKind, TaskData, DatastoreOptions> = {
  when: Date;
  kind: TaskKind;
  data: TaskData;
  priority?: 0;
  idempotencyKey?: string;
  datastoreOptions?: DatastoreOptions;
};

export interface Datastore<DatastoreOptions> {
  schedule<TaskKind, TaskData>(
    input: ScheduleInput<TaskKind, TaskData, DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>>;
}

type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<TaskKind, TaskData, DatastoreOptions>;

export class Chrono<TaskKind, DatastoreOptions> extends EventEmitter {
  #datastore: Datastore<DatastoreOptions>;

  constructor(datastore: Datastore<DatastoreOptions>) {
    super();

    this.#datastore = datastore;

    this.emit('instantiated', { timestamp: new Date() });
  }

  public async scheduleTask<TaskData>(
    input: ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>> {
    const task = await this.#datastore.schedule({
      when: input.when,
      kind: input.kind,
      data: input.data,
      datastoreOptions: input.datastoreOptions,
    });

    this.emit('task-scheduled', { task, timestamp: new Date() });

    return task;
  }
}
