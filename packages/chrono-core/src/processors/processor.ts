import type { EventEmitter } from 'node:stream';

export interface Processor extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
}
