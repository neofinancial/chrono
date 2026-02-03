import EventEmitter from 'node:events';
import timers from 'node:timers/promises';

import type { StatisticsCollectorDatastore, TaskMappingBase } from '@neofinancial/chrono';
import { type StatisticsCollector, StatisticsCollectorEvents, type StatisticsCollectorEventsMap } from '.';

const DEFAULT_CONFIG: PollingStatisticsCollectorConfiguration = {
  statCollectionIntervalMs: 1_800_000,
};

export interface PollingStatisticsCollectorConfiguration {
  /** The interval at which the statistics collector will poll and emit statistics. @default 1_800_000ms (30 minutes) */
  statCollectionIntervalMs?: number;
}

export interface PollingStatisticsCollectorInput<TaskMapping extends TaskMappingBase> {
  /** The datastore to poll for statistics - must implement StatisticsCollectorDatastore */
  statisticsCollectorDatastore: StatisticsCollectorDatastore<TaskMapping>;
  /** Configuration options for the collector */
  configuration?: PollingStatisticsCollectorConfiguration;
}

/**
 * A statistics collector that polls the datastore at regular intervals.
 * Requires a datastore that implements StatisticsCollectorDatastore.
 */
export class PollingStatisticsCollector<TaskMapping extends TaskMappingBase>
  extends EventEmitter<StatisticsCollectorEventsMap<TaskMapping>>
  implements StatisticsCollector<TaskMapping>
{
  private config: PollingStatisticsCollectorConfiguration;
  private statisticsCollectorDatastore: StatisticsCollectorDatastore<TaskMapping>;
  private interval: { abortController: AbortController; promise: Promise<void> } | undefined;

  constructor(input: PollingStatisticsCollectorInput<TaskMapping>) {
    super();

    this.config = {
      ...DEFAULT_CONFIG,
      ...input.configuration,
    };

    this.statisticsCollectorDatastore = input.statisticsCollectorDatastore;
  }

  async start(taskKinds: (keyof TaskMapping)[]): Promise<void> {
    if (this.interval) {
      return;
    }

    const abortController = new AbortController();
    const promise = this.runCollectionLoop(taskKinds, abortController);

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

  private async runCollectionLoop(taskKinds: (keyof TaskMapping)[], abortController: AbortController): Promise<void> {
    try {
      for await (const _ of timers.setInterval(this.config.statCollectionIntervalMs, undefined, {
        signal: abortController.signal,
      })) {
        try {
          const statistics = await this.statisticsCollectorDatastore.collectStatistics({ taskKinds });
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
