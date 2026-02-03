import type { EventEmitter } from 'node:events';
import type { TaskMappingBase } from '../chrono';
import type { Datastore } from '../datastore';
import type { Processor } from '../processors';
import type { ProcessorEventsMap } from '../processors/events';
import type { PluginContext } from './plugin';

/**
 * Chrono's internal implementation of PluginContext.
 * Provides plugins with access to Chrono internals and manages lifecycle hooks.
 * @internal
 */
export class ChronoPluginContext<TaskMapping extends TaskMappingBase, DatastoreOptions>
  implements PluginContext<TaskMapping>
{
  private readonly startHooks: Array<() => Promise<void> | void> = [];
  private readonly stopHooks: Array<() => Promise<void> | void> = [];

  readonly hooks = {
    onStart: (handler: () => Promise<void> | void): void => {
      this.startHooks.push(handler);
    },
    onStop: (handler: () => Promise<void> | void): void => {
      this.stopHooks.push(handler);
    },
  };

  readonly chrono: PluginContext<TaskMapping>['chrono'];

  constructor(
    private readonly processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>,
    private readonly datastore: Datastore<TaskMapping, DatastoreOptions>,
  ) {
    this.chrono = {
      getRegisteredTaskKinds: () => Array.from(this.processors.keys()),
      getDatastore: () => this.datastore,
    };
  }

  getProcessorEvents<TaskKind extends keyof TaskMapping>(
    kind: TaskKind,
  ): EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined {
    return this.processors.get(kind);
  }

  /**
   * Execute all registered start hooks in order (FIFO).
   * Called by Chrono during start().
   * @internal
   */
  async executeStartHooks(): Promise<void> {
    for (const hook of this.startHooks) {
      await hook();
    }
  }

  /**
   * Execute all registered stop hooks in reverse order (LIFO).
   * Called by Chrono during stop().
   * @internal
   */
  async executeStopHooks(): Promise<void> {
    for (const hook of [...this.stopHooks].reverse()) {
      await hook();
    }
  }
}
