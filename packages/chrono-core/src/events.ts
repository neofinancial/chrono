export const ChronoEvents = {
  /** Chrono instance has started processors and begun polling tasks */
  STARTED: 'started',
  /** Chrono instance has failed to gracefully stop so shutdown has been aborted */
  STOP_ABORTED: 'stopAborted',
} as const;

export type ChronoEvents = (typeof ChronoEvents)[keyof typeof ChronoEvents];

export type ChronoEventsMap = {
  [ChronoEvents.STARTED]: [{ startedAt: Date }];
  [ChronoEvents.STOP_ABORTED]: [{ timestamp: Date; error: unknown }];
};
