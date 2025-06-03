import type { EventEmitter } from 'node:stream';
import type { Task, TaskMappingBase } from '..';

export type ProcessorEvents<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase> = {
  'task:completed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; timestamp: Date }];
  'task:failed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: Error; timestamp: Date }];
  'task:unclaimed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: Error; timestamp: Date }];
};

export interface Processor<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase>
  extends EventEmitter<ProcessorEvents<TaskKind, TaskMapping>> {
  start(): Promise<void>;
  stop(): Promise<void>;
}
