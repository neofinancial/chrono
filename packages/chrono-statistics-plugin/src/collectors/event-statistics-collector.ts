import { EventEmitter } from 'node:events';
import timers from 'node:timers/promises';

import { ProcessorEvents, type ProcessorEventsMap, type Statistics, type TaskMappingBase } from '@neofinancial/chrono';
import { type StatisticsCollector, StatisticsCollectorEvents, type StatisticsCollectorEventsMap } from '.';

const DEFAULT_CONFIG: EventStatisticsCollectorConfiguration = {
  eventCollectionIntervalMs: 60_000, // 1 minute
};

export interface EventStatisticsCollectorConfiguration {
  /** The interval at which the statistics collector will emit statistics. @default 60_000ms (1 minute) */
  eventCollectionIntervalMs?: number;
}

/**
 * Function type for getting processor events for a task kind.
 * Returns the processor's EventEmitter or undefined if not registered.
 */
export type GetProcessorEventsFn<TaskMapping extends TaskMappingBase> = <TaskKind extends keyof TaskMapping>(
  kind: TaskKind,
) => EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined;

export interface EventStatisticsCollectorInput<TaskMapping extends TaskMappingBase> {
  /** Function to get processor events for a task kind */
  getProcessorEvents: GetProcessorEventsFn<TaskMapping>;
  /** Configuration options for the collector */
  configuration?: EventStatisticsCollectorConfiguration;
}

interface TaskKindStats {
  claimedCount: number;
  completedCount: number;
  failedCount: number;
}

/**
 * A statistics collector that tracks metrics by listening to processor events.
 * Emits statistics summaries at configured intervals based on observed events.
 *
 * Note: This collector tracks throughput metrics (events observed in the interval),
 * not point-in-time state like the polling collector. The `pendingCount` will always
 * be 0 since pending tasks can't be observed via processor events.
 */
export class EventStatisticsCollector<TaskMapping extends TaskMappingBase>
  extends EventEmitter<StatisticsCollectorEventsMap<TaskMapping>>
  implements StatisticsCollector<TaskMapping>
{
  private config: EventStatisticsCollectorConfiguration;
  private getProcessorEvents: GetProcessorEventsFn<TaskMapping>;
  private abortController: AbortController | undefined;
  private runningPromise: Promise<void> | undefined;
  private statistics: Map<keyof TaskMapping, Partial<TaskKindStats>> = new Map();

  constructor(input: EventStatisticsCollectorInput<TaskMapping>) {
    super();

    this.config = {
      ...DEFAULT_CONFIG,
      ...input.configuration,
    };

    this.getProcessorEvents = input.getProcessorEvents;
  }

  async start(taskKinds: (keyof TaskMapping)[]): Promise<void> {
    if (this.abortController) {
      return;
    }

    this.abortController = new AbortController();
    const { signal: abortSignal } = this.abortController;

    // Subscribe to processor events for each task kind
    for (const taskKind of taskKinds) {
      const processorEvents = this.getProcessorEvents(taskKind);
      if (!processorEvents) {
        continue;
      }

      this.subscribeToProcessor(taskKind, processorEvents, abortSignal);
    }

    this.runningPromise = this.runCollectionLoop(taskKinds, abortSignal);
  }

  async stop(): Promise<void> {
    if (!this.abortController) {
      return;
    }

    this.abortController.abort();
    await this.runningPromise;

    this.abortController = undefined;
    this.runningPromise = undefined;
    this.statistics.clear();
  }

  private subscribeToProcessor(
    taskKind: keyof TaskMapping,
    processorEvents: EventEmitter<ProcessorEventsMap<keyof TaskMapping, TaskMapping>>,
    abortSignal: AbortSignal,
  ): void {
    const claimedHandler = () => {
      const stats = this.statistics.get(taskKind);
      this.statistics.set(taskKind, {
        ...stats,
        claimedCount: (stats?.claimedCount ?? 0) + 1,
      });
    };

    const completedHandler = () => {
      const stats = this.statistics.get(taskKind);
      this.statistics.set(taskKind, {
        ...stats,
        completedCount: (stats?.completedCount ?? 0) + 1,
      });
    };

    const failedHandler = () => {
      const stats = this.statistics.get(taskKind);
      this.statistics.set(taskKind, {
        ...stats,
        failedCount: (stats?.failedCount ?? 0) + 1,
      });
    };

    processorEvents.on(ProcessorEvents.TASK_CLAIMED, claimedHandler);
    processorEvents.on(ProcessorEvents.TASK_COMPLETED, completedHandler);
    processorEvents.on(ProcessorEvents.TASK_FAILED, failedHandler);

    // Clean up listeners when the abort signal is aborted
    abortSignal.addEventListener('abort', () => {
      processorEvents.off(ProcessorEvents.TASK_CLAIMED, claimedHandler);
      processorEvents.off(ProcessorEvents.TASK_COMPLETED, completedHandler);
      processorEvents.off(ProcessorEvents.TASK_FAILED, failedHandler);
    });
  }

  private async runCollectionLoop(taskKinds: (keyof TaskMapping)[], signal: AbortSignal): Promise<void> {
    try {
      for await (const _ of timers.setInterval(this.config.eventCollectionIntervalMs, undefined, { signal })) {
        try {
          const statistics = taskKinds.reduce(
            (acc, taskKind) => {
              const stats = this.statistics.get(taskKind);
              acc[taskKind] = {
                // Note: pendingCount can't be tracked via events - always 0
                pendingCount: 0,
                claimedCount: stats?.claimedCount ?? 0,
                failedCount: stats?.failedCount ?? 0,
              };
              return acc;
            },
            {} as Statistics<TaskMapping>,
          );

          this.emit(StatisticsCollectorEvents.STATISTICS_COLLECTED, {
            statistics,
            timestamp: new Date(),
          });

          // Reset counters for next interval
          for (const taskKind of taskKinds) {
            this.statistics.set(taskKind, { claimedCount: 0, completedCount: 0, failedCount: 0 });
          }
        } catch (error) {
          this.emit(StatisticsCollectorEvents.STATISTICS_COLLECTED_ERROR, { error, timestamp: new Date() });
        }
      }
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === 'AbortError') {
        return;
      }

      throw error;
    }
  }
}
