import type { EventEmitter } from 'node:stream';
import type { TaskMappingBase } from '..';
import type { ProcessorEventsMap } from './events';

export interface Processor<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase>
  extends EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> {
  start(): Promise<void>;
  stop(): Promise<void>;
}
