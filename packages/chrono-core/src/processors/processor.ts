import { EventEmitter } from 'node:stream';

export interface Processor extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type TaskErrorEvent = {
  taskIndex: number;
  error: Error;
  timestamp: Date;
};

/**
 * This class is a wrapper to its task which emits an error event if the task fails.
 */
export class TaskRunner extends EventEmitter {
  private taskIndex: number;
  private task: () => Promise<void>;

  constructor(taskIndex: number, task: () => Promise<void>) {
    super();

    this.taskIndex = taskIndex;
    this.task = task;
  }

  async run(): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      const errorEvent: TaskErrorEvent = {
        taskIndex: this.taskIndex,
        error: error as Error,
        timestamp: new Date(),
      };

      this.emit('error', errorEvent);
    }

    this.emit('exit', this.taskIndex);
  }

  onceExit(handler: () => void): void {
    this.once('exit', () => handler());
  }

  onError(handler: (errorEvent: TaskErrorEvent) => void): void {
    this.on('error', (event: TaskErrorEvent) => handler(event));
  }
}
