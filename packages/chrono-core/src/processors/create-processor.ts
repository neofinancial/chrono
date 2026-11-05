import type { TaskMappingBase } from '..';
import { type BackoffStrategyOptions, backoffStrategyFactory } from '../backoff-strategy';
import { isBulkDatastore } from '../bulk-datastore';
import type { Datastore, Task } from '../datastore';
import { BulkProcessor, type BulkProcessorConfiguration } from './bulk-processor';
import type { Processor } from './processor';
import { SimpleProcessor, type SimpleProcessorConfiguration } from './simple-processor';

/**
 * Configuration for the processor. Default to simple processor.
 * @default { type: 'simple' } if no configuration is provided.
 */
export type ProcessorConfiguration =
  | (Partial<SimpleProcessorConfiguration> & { type?: 'simple' })
  | (Partial<BulkProcessorConfiguration> & { type: 'bulk' });

export type CreateProcessorInput<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
> = {
  kind: TaskKind;
  datastore: Datastore<TaskMapping, DatastoreOptions>;
  handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  configuration?: ProcessorConfiguration;
  backoffStrategyOptions?: BackoffStrategyOptions;
};

export function createProcessor<
  TaskKind extends Extract<keyof TaskMapping, string>,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
>(input: CreateProcessorInput<TaskKind, TaskMapping, DatastoreOptions>): Processor<TaskKind, TaskMapping> {
  const backoffStrategy = backoffStrategyFactory(input.backoffStrategyOptions);
  const processorType = input.configuration?.type ?? 'simple';

  if (processorType === 'simple') {
    return new SimpleProcessor<TaskKind, TaskMapping, DatastoreOptions>(
      input.datastore,
      input.kind,
      input.handler,
      backoffStrategy,
      input.configuration,
    );
  }

  if (processorType === 'bulk') {
    if (!isBulkDatastore(input.datastore)) {
      throw new Error('Bulk processor requires a datastore that implements BulkDatastore');
    }

    return new BulkProcessor<TaskKind, TaskMapping, DatastoreOptions>(
      input.datastore,
      input.kind,
      input.handler,
      backoffStrategy,
      input.configuration,
    );
  }

  const _unreachable: never = processorType;

  throw new Error(`Unknown processor type: ${processorType}`);
}
