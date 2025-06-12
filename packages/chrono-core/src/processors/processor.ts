import type { EventEmitter } from 'node:stream';
import type { Task, TaskMappingBase } from '..';

export type ProcessorEvents<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase> = {
  'task:claimed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; timestamp: Date }];
  'task:completed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; timestamp: Date }];
  'task:failed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: Error; timestamp: Date }];
  'task:retry:requested': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: Error; timestamp: Date }];
  'task:completion:failed': [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: Error; timestamp: Date }];
  'processloop:error': [{ error: Error; timestamp: Date }];
};

export interface Processor<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase>
  extends EventEmitter<ProcessorEvents<TaskKind, TaskMapping>> {
  start(): Promise<void>;
  stop(): Promise<void>;
}
