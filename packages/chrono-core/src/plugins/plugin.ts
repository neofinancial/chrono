import type { EventEmitter } from 'node:events';
import type { TaskMappingBase } from '../chrono';
import type { Datastore } from '../datastore';
import type { ProcessorEventsMap } from '../processors/events';

/**
 * Plugin interface - all plugins must implement this.
 * @template TaskMapping - The task type mapping for the Chrono instance
 * @template API - The API type returned by the plugin's register function (defaults to void)
 */
export interface ChronoPlugin<TaskMapping extends TaskMappingBase = TaskMappingBase, API = void> {
  /** Unique plugin identifier */
  name: string;

  /**
   * Called when the plugin is registered via chrono.use().
   * Can return an API object for type-safe access to plugin functionality.
   * @param context - The plugin context providing access to Chrono internals
   * @returns The plugin's public API (if any)
   */
  register(context: PluginContext<TaskMapping>): API;
}

/**
 * Context passed to plugins during registration.
 * Provides access to processor events, lifecycle hooks, and read-only Chrono APIs.
 */
export interface PluginContext<TaskMapping extends TaskMappingBase> {
  /**
   * Get the event emitter for a specific processor by task kind.
   * @param kind - The task kind to get processor events for
   * @returns The processor's event emitter, or undefined if not registered
   */
  getProcessorEvents<TaskKind extends keyof TaskMapping>(
    kind: TaskKind,
  ): EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined;

  /** Register lifecycle hooks */
  hooks: {
    /**
     * Register a handler to be called when Chrono starts.
     * Handlers are executed in registration order (FIFO).
     */
    onStart(handler: () => Promise<void> | void): void;

    /**
     * Register a handler to be called when Chrono stops.
     * Handlers are executed in reverse registration order (LIFO).
     */
    onStop(handler: () => Promise<void> | void): void;
  };

  /** Read-only access to Chrono internals */
  chrono: {
    /** Get the list of registered task kinds */
    getRegisteredTaskKinds(): (keyof TaskMapping)[];

    /** Get the datastore instance */
    getDatastore(): Datastore<TaskMapping, unknown>;
  };
}
