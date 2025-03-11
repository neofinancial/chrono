export interface Task<T> {
  run(): Promise<T>;
}

export class Scheduler<T> {
  #tasks: Task<T>[] = [];

  constructor() {
    this.#tasks = [];
  }

  public async schedule(task: Task<T>) {
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
