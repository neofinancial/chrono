import type { TaskMappingBase } from '../chrono';
import type { PluginRegistrationContext } from './registration-context';

export type { PluginLifecycleContext } from './lifecycle-context';
export type { PluginRegistrationContext } from './registration-context';

/**
 * Plugin interface - all plugins must implement this.
 * @template TaskMapping - The task type mapping for the Chrono instance
 * @template DatastoreOptions - The datastore options type for the Chrono instance
 * @template PluginAPI - The PluginAPI type returned by the plugin's register function (defaults to void)
 */
export interface ChronoPlugin<
  TaskMapping extends TaskMappingBase = TaskMappingBase,
  DatastoreOptions = unknown,
  PluginAPI = void,
> {
  /** Unique plugin identifier */
  name: string;

  /**
   * Called when the plugin is registered via chrono.use().
   * Can return an PluginAPI object for type-safe access to plugin functionality.
   * @param context - The plugin registration context providing access to Chrono methods
   * @returns The plugin's public PluginAPI (if any)
   */
  register(context: PluginRegistrationContext<TaskMapping, DatastoreOptions>): PluginAPI;
}
