import type { EventEmitter } from 'node:events';
import type { TaskMappingBase } from '../chrono';
import type { Datastore } from '../datastore';
import type { ProcessorEventsMap } from '../processors/events';

/**
 * Context passed to plugin lifecycle hooks (onStart, onStop).
 * Provides read-only access to Chrono runtime state.
 */
export interface PluginLifecycleContext<TaskMapping extends TaskMappingBase> {
  /**
   * Get the list of registered task kinds.
   * @returns An array of all registered task kinds
   */
  getRegisteredTaskKinds(): (keyof TaskMapping)[];

  /**
   * Get the datastore instance.
   * @returns The datastore used by this Chrono instance
   */
  getDatastore(): Datastore<TaskMapping, unknown>;

  /**
   * Get the event emitter for a specific processor by task kind.
   * @param kind - The task kind to get processor events for
   * @returns The processor's event emitter, or undefined if not registered
   */
  getProcessorEvents<TaskKind extends keyof TaskMapping>(
    kind: TaskKind,
  ): EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined;
}
