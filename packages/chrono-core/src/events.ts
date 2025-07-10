export const ChronoEvents = {
  /** Chrono instance has started processors and begun polling tasks */
  STARTED: 'started',
  /** Chrono instance has failed to gracefully stop */
  FORCIBLY_STOPPED: 'forciblyStopped',
} as const;

export type ChronoEvents = (typeof ChronoEvents)[keyof typeof ChronoEvents];

export type ChronoEventsMap = {
  [ChronoEvents.STARTED]: [{ startedAt: Date }];
  [ChronoEvents.FORCIBLY_STOPPED]: [{ timestamp: Date; error: unknown }];
};
