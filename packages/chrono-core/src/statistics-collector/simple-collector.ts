import EventEmitter from 'node:events';
import timers from 'node:timers/promises';

import type { TaskMappingBase } from '..';
import type { StatisticsCollectorDatastore } from '../datastore';
import { type StatisticsCollector, StatisticsCollectorEvents, type StatisticsCollectorEventsMap } from '.';

const DEFAULT_CONFIG: SimpleStatisticsCollectorConfiguration = {
  statCollectionIntervalMs: 1_800_000,
};

export interface SimpleStatisticsCollectorConfiguration {
  /** The interval at which the statistics collector will collect statistics and emit them as events. @default 1_800_000ms (30 minutes) */
  statCollectionIntervalMs?: number;
}

export interface SimpleStatisticsCollectorInput<TaskMapping extends TaskMappingBase> {
  statisticsCollectorDatastore: StatisticsCollectorDatastore<TaskMapping>;
  taskKinds: (keyof TaskMapping)[];
  configuration?: SimpleStatisticsCollectorConfiguration;
}

export class SimpleStatisticsCollector<TaskMapping extends TaskMappingBase>
  extends EventEmitter<StatisticsCollectorEventsMap<TaskMapping>>
  implements StatisticsCollector<TaskMapping>
{
  private config: SimpleStatisticsCollectorConfiguration;
  private taskKinds: (keyof TaskMapping)[];
  private statisticsCollectorDatastore: StatisticsCollectorDatastore<TaskMapping>;
  private interval: { abortController: AbortController; promise: Promise<void> } | undefined;

  constructor(input: SimpleStatisticsCollectorInput<TaskMapping>) {
    super();

    this.config = {
      ...DEFAULT_CONFIG,
      ...input.configuration,
    };

    this.taskKinds = input.taskKinds;
    this.statisticsCollectorDatastore = input.statisticsCollectorDatastore;
  }
  async start(): Promise<void> {
    if (this.interval) {
      return;
    }

    const abortController = new AbortController();
    const promise = this.runCollectionLoop(abortController);

    this.interval = { abortController, promise };
  }

  async stop(): Promise<void> {
    if (!this.interval) {
      return;
    }

    this.interval.abortController?.abort();
    await this.interval.promise;
    this.interval = undefined;
  }

  private async runCollectionLoop(abortController: AbortController): Promise<void> {
    try {
      for await (const _ of timers.setInterval(this.config.statCollectionIntervalMs, undefined, {
        signal: abortController.signal,
      })) {
        try {
          const statistics = await this.statisticsCollectorDatastore.collectStatistics({ taskKinds: this.taskKinds });
          this.emit(StatisticsCollectorEvents.STATISTICS_COLLECTED, { statistics, timestamp: new Date() });
        } catch (error) {
          this.emit(StatisticsCollectorEvents.STATISTICS_COLLECTED_ERROR, { error, timestamp: new Date() });
        }
      }
    } catch (error) {
      if (abortController.signal.aborted && error instanceof Error && error.name === 'AbortError') {
        return;
      }

      throw error;
    }
  }
}
