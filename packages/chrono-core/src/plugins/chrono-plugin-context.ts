import type { EventEmitter } from 'node:events';
import type { Chrono, TaskMappingBase } from '../chrono';
import type { Datastore } from '../datastore';
import type { Processor } from '../processors';
import type { ProcessorEventsMap } from '../processors/events';
import type { PluginLifecycleContext } from './lifecycle-context';
import type { PluginRegistrationContext } from './registration-context';

/**
 * Chrono's internal implementation of PluginRegistrationContext.
 * Provides plugins with access to Chrono methods and manages lifecycle hooks.
 * @internal
 */
export class ChronoPluginContext<TaskMapping extends TaskMappingBase, DatastoreOptions>
  implements PluginRegistrationContext<TaskMapping, DatastoreOptions>
{
  private readonly startHooks: Array<
    (context: PluginLifecycleContext<TaskMapping, DatastoreOptions>) => Promise<void> | void
  > = [];
  private readonly stopHooks: Array<
    (context: PluginLifecycleContext<TaskMapping, DatastoreOptions>) => Promise<void> | void
  > = [];

  readonly hooks = {
    onStart: (
      handler: (context: PluginLifecycleContext<TaskMapping, DatastoreOptions>) => Promise<void> | void,
    ): void => {
      this.startHooks.push(handler);
    },
    onStop: (
      handler: (context: PluginLifecycleContext<TaskMapping, DatastoreOptions>) => Promise<void> | void,
    ): void => {
      this.stopHooks.push(handler);
    },
  };

  public readonly chrono: Pick<
    Chrono<TaskMapping, DatastoreOptions>,
    'registerTaskHandler' | 'use' | 'scheduleTask' | 'deleteTask'
  >;

  constructor(
    chrono: Chrono<TaskMapping, DatastoreOptions>,
    private readonly processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>,
    private readonly datastore: Datastore<TaskMapping, DatastoreOptions>,
  ) {
    this.chrono = {
      registerTaskHandler: chrono.registerTaskHandler.bind(chrono),
      use: chrono.use.bind(chrono),
      scheduleTask: chrono.scheduleTask.bind(chrono),
      deleteTask: chrono.deleteTask.bind(chrono),
    };
  }

  /**
   * Create a lifecycle context for passing to hook handlers.
   */
  private createLifecycleContext(): PluginLifecycleContext<TaskMapping, DatastoreOptions> {
    return {
      getRegisteredTaskKinds: () => Array.from(this.processors.keys()),
      getDatastore: () => this.datastore,
      getProcessorEvents: <TaskKind extends keyof TaskMapping>(
        kind: TaskKind,
      ): EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined => {
        return this.processors.get(kind);
      },
    };
  }

  /**
   * Execute all registered start hooks in order (FIFO).
   * Called by Chrono during start().
   * @internal
   */
  async executeStartHooks(): Promise<void> {
    const context = this.createLifecycleContext();

    for (const hook of this.startHooks) {
      await hook(context);
    }
  }

  /**
   * Execute all registered stop hooks in reverse order (LIFO).
   * Called by Chrono during stop().
   * @internal
   */
  async executeStopHooks(): Promise<void> {
    const context = this.createLifecycleContext();

    for (const hook of [...this.stopHooks].reverse()) {
      await hook(context);
    }
  }
}
