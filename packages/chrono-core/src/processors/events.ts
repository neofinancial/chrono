import type { Task, TaskMappingBase } from '..';

export const ProcessorEvents = {
  /** A task has been claimed by the running processor for handling */
  TASK_CLAIMED: 'taskClaimed',
  /** A task has completed processing and successfully marked as completed */
  TASK_COMPLETED: 'taskCompleted',
  /** A task has failed during processing and being scheduled for retry */
  TASK_RETRY_SCHEDULED: 'taskRetryScheduled',
  /** A task has been marked as FAILED due to process failures exceeding max retries */
  TASK_FAILED: 'taskFailed',
  /** A task has been successfully processed but underlying data store failed to mark task as completed. Duplicate processing expected */
  TASK_COMPLETION_FAILURE: 'taskCompletionFailure',
  /** An unknown and uncaught exception occurred in processor. Processing paused for processLoopRetryIntervalMs before continuing */
  UNKNOWN_PROCESSING_ERROR: 'unknownProcessingError',
  /** A statistics event has been emitted */
  STATISTICS_COLLECTED: 'statisticsCollected',
  /** An error occurred while collecting statistics */
  STATISTICS_COLLECTED_ERROR: 'statisticsCollectedError',
} as const;

export type ProcessorEvents = (typeof ProcessorEvents)[keyof typeof ProcessorEvents];

export type Statistics = {
  claimableTaskCount: number;
  failedTaskCount: number;
};

export type ProcessorEventsMap<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase> = {
  [ProcessorEvents.TASK_CLAIMED]: [{ task: Task<TaskKind, TaskMapping[TaskKind]>; claimedAt: Date }];
  [ProcessorEvents.TASK_COMPLETED]: [
    { task: Task<TaskKind, TaskMapping[TaskKind]>; completedAt: Date; startedAt: Date },
  ];
  [ProcessorEvents.TASK_RETRY_SCHEDULED]: [
    { task: Task<TaskKind, TaskMapping[TaskKind]>; error: unknown; retryScheduledAt: Date; errorAt: Date },
  ];
  [ProcessorEvents.TASK_FAILED]: [{ task: Task<TaskKind, TaskMapping[TaskKind]>; error: unknown; failedAt: Date }];
  [ProcessorEvents.TASK_COMPLETION_FAILURE]: [
    { task: Task<TaskKind, TaskMapping[TaskKind]>; error: unknown; failedAt: Date },
  ];
  [ProcessorEvents.UNKNOWN_PROCESSING_ERROR]: [{ error: unknown; timestamp: Date }];
  [ProcessorEvents.STATISTICS_COLLECTED]: [{ statistics: Statistics; timestamp: Date }];
  [ProcessorEvents.STATISTICS_COLLECTED_ERROR]: [{ error: unknown; timestamp: Date }];
};
