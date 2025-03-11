export interface Task {
  run(): Promise<void>;
}

export class Scheduler {
  #tasks: Task[] = [];

  constructor() {
    this.#tasks = [];
  }

  public schedule(task: Task) {
    this.#tasks.push(task);
  }

  public run() {
    this.#tasks.forEach((task) => task.run());
  }
}
