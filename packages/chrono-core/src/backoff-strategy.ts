/** Input for calculating the next backoff delay. */
export type BackoffStrategyInput = {
  /** The number of retries already attempted (0 for the first retry). */
  retryAttempt: number;
};

export type DelayMs = number;

/**
 * A function that calculates the backoff delay in milliseconds.
 * @param input - Contains information like the current retry number.
 * @returns The delay duration in milliseconds.
 */
export type BackoffStrategy = (input: BackoffStrategyInput) => DelayMs;

/**
 * Creates a strategy that provides no delay (immediate retry).
 */
export function createNoBackoffStrategy(): BackoffStrategy {
  return (_input: BackoffStrategyInput) => 0;
}

export interface FixedBackoffStrategyConfig {
  /** The constant delay in milliseconds. */
  readonly delayMs: number;
}
/**
 * Creates a strategy that waits a fixed amount of time.
 */
export function createFixedBackoffStrategy(config: FixedBackoffStrategyConfig): BackoffStrategy {
  return (_input: BackoffStrategyInput) => config.delayMs;
}

export interface LinearBackoffStrategyConfig {
  /** The base delay for all retires that will be incremented off of */
  readonly baseDelayMs?: number;
  /** The amount to increase the delay by for each subsequent retry in milliseconds. */
  readonly incrementMs: number;
}

/**
 * Creates a strategy where the delay increases linearly.
 * Delay = (incrementMs * retryAttempt)
 */
export function createLinearBackoffStrategy(config: LinearBackoffStrategyConfig): BackoffStrategy {
  const { incrementMs, baseDelayMs = 0 } = config;
  return (input: BackoffStrategyInput) => {
    return baseDelayMs + input.retryAttempt * incrementMs;
  };
}

export interface ExponentialBackoffStrategyConfig {
  /** The base delay for the first retry (retryAttempt = 0) in milliseconds. */
  readonly baseDelayMs: number;
  /** The maximum delay in milliseconds. Defaults to Infinity. */
  readonly maxDelayMs?: number;
  /** Type of jitter to apply. Defaults to 'none'. */
  readonly jitter?: 'none' | 'full' | 'equal';
}
/**
 * Creates a strategy where the delay increases exponentially, potentially with jitter.
 * Base Delay Formula = baseDelayMs * (2 ** retryAttempt)
 */
export function createExponentialBackoffStrategy(config: ExponentialBackoffStrategyConfig): BackoffStrategy {
  const { baseDelayMs, maxDelayMs = Number.POSITIVE_INFINITY, jitter = 'none' } = config;

  return (input: BackoffStrategyInput) => {
    const exponentialDelay = baseDelayMs * 2 ** input.retryAttempt;
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

    switch (jitter) {
      case 'full':
        // Full Jitter: random_between(0, cappedDelay)
        return Math.floor(Math.random() * cappedDelay);
      case 'equal': {
        // Equal Jitter: (cappedDelay / 2) + random_between(0, cappedDelay / 2)
        const halfDelay = cappedDelay / 2;
        return halfDelay + Math.random() * halfDelay;
      }
      case 'none':
        // No Jitter
        return cappedDelay;
      default: {
        // This should be caught by TypeScript if options type is correct
        const _exhaustiveCheck: never = jitter;
        throw new Error('Unknown jitter type for exponential backoff strategy');
      }
    }
  };
}

export type BackoffStrategyType = 'none' | 'fixed' | 'linear' | 'exponential';

export type BackoffStrategyOptions =
  | { type: 'none' }
  | ({ type: 'fixed' } & FixedBackoffStrategyConfig)
  | ({ type: 'linear' } & LinearBackoffStrategyConfig)
  | ({ type: 'exponential' } & ExponentialBackoffStrategyConfig);

const DEFAULT_BACKOFF_STRATEGY: BackoffStrategyOptions = {
  type: 'linear',
  incrementMs: 2000,
} as const;

/**
 * Factory function to create a backoff strategy based on type and configuration.
 * @param options - Configuration object including the strategy type.
 * @returns A BackoffStrategy function.
 */
export function backoffStrategyFactory(options: BackoffStrategyOptions = DEFAULT_BACKOFF_STRATEGY): BackoffStrategy {
  switch (options.type) {
    case 'none':
      return createNoBackoffStrategy();
    case 'fixed':
      // No need to destructure 'type', pass the rest
      return createFixedBackoffStrategy(options);
    case 'linear':
      return createLinearBackoffStrategy(options);
    case 'exponential':
      return createExponentialBackoffStrategy(options);
    default: {
      // This should be caught by TypeScript if options type is correct
      const _exhaustiveCheck: never = options;
      throw new Error('Unknown backoff strategy type');
    }
  }
}
