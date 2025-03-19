import { EventEmitter } from 'node:stream';

export interface Processor {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type TaskErrorEvent = {
  taskIndex: number;
  error: Error;
  timestamp: Date;
};

/**
 * Emits 'error' event when a task exits because of an error.
 */
export class TaskErrorChannel extends EventEmitter {
  emitError(taskIndex: number, error: Error): void {
    this.emit('error', { taskIndex, error, timestamp: new Date() } as TaskErrorEvent);
  }

  onError(handler: (errorEvent: TaskErrorEvent) => void): void {
    this.on('error', (event: TaskErrorEvent) => handler(event));
  }
}

/**
 * This class is a wrapper to its task which emits an error event if the task fails.
 */
export class TaskRunner {
  private taskIndex: number;
  private task: () => Promise<void>;
  private errorChannel: TaskErrorChannel;

  constructor(taskIndex: number, errorChannel: TaskErrorChannel, task: () => Promise<void>) {
    this.taskIndex = taskIndex;
    this.task = task;
    this.errorChannel = errorChannel;
  }

  async run(): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.errorChannel.emitError(this.taskIndex, error as Error);
    }
  }
}
