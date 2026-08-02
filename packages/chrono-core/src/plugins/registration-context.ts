import type { Chrono, TaskMappingBase } from '../chrono';
import type { Datastore } from '../datastore';
import type { PluginLifecycleContext } from './lifecycle-context';

/**
 * Context passed to plugins during registration.
 * Provides access to Chrono's specific methods and lifecycle hook registration.
 */
export interface PluginRegistrationContext<
  TaskMapping extends TaskMappingBase,
  DatastoreOptions = unknown,
  DatastoreImpl extends Datastore<TaskMapping, DatastoreOptions> = Datastore<TaskMapping, DatastoreOptions>,
> {
  chrono: Pick<
    Chrono<TaskMapping, DatastoreOptions, DatastoreImpl>,
    'use' | 'registerTaskHandler' | 'scheduleTask' | 'deleteTask'
  >;

  /** Register lifecycle hooks */
  hooks: {
    /**
     * Register a handler to be called when Chrono starts.
     * Handlers are executed in registration order (FIFO).
     * @param handler - The handler to call, receiving a lifecycle context
     */
    onStart(
      handler: (context: PluginLifecycleContext<TaskMapping, DatastoreOptions, DatastoreImpl>) => Promise<void> | void,
    ): void;

    /**
     * Register a handler to be called when Chrono stops.
     * Handlers are executed in reverse registration order (LIFO).
     * @param handler - The handler to call, receiving a lifecycle context
     */
    onStop(
      handler: (context: PluginLifecycleContext<TaskMapping, DatastoreOptions, DatastoreImpl>) => Promise<void> | void,
    ): void;
  };
}
