export interface Task {
  run(): Promise<void>;
}

export class Scheduler {
  #tasks: Task[] = [];

  constructor() {
    this.#tasks = [];
  }

  public async schedule(task: Task) {
    this.#tasks.push(task);

    return true;
  }

  public async run() {
    for (const task of this.#tasks) {
      task.run();
    }

    return true;
  }
}
