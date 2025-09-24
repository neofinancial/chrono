import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  type BackoffStrategyOptions,
  backoffStrategyFactory,
  createExponentialBackoffStrategy,
  createFixedBackoffStrategy,
  createLinearBackoffStrategy,
  createNoBackoffStrategy,
  type LinearBackoffStrategyConfig,
} from '../../src/backoff-strategy';

describe('Backoff Strategies', () => {
  describe('createNoBackoffStrategy', () => {
    const strategy = createNoBackoffStrategy();

    it('should always return 0 delay', () => {
      expect(strategy({ retryAttempt: 0 })).toBe(0);
      expect(strategy({ retryAttempt: 1 })).toBe(0);
      expect(strategy({ retryAttempt: 5 })).toBe(0);
    });
  });

  describe('createFixedBackoffStrategy', () => {
    const config = { delayMs: 500 };
    const strategy = createFixedBackoffStrategy(config);

    it('should return the fixed delay regardless of retry number', () => {
      expect(strategy({ retryAttempt: 0 })).toBe(config.delayMs);
      expect(strategy({ retryAttempt: 1 })).toBe(config.delayMs);
      expect(strategy({ retryAttempt: 10 })).toBe(config.delayMs);
    });
  });

  describe('createLinearBackoffStrategy', () => {
    it('should calculate delay correctly with default increment', () => {
      const config: LinearBackoffStrategyConfig = { incrementMs: 100 };
      const strategy = createLinearBackoffStrategy(config);
      expect(strategy({ retryAttempt: 0 })).toBe(0); // (100 * 0)
      expect(strategy({ retryAttempt: 1 })).toBe(100); // (100 * 1)
      expect(strategy({ retryAttempt: 2 })).toBe(200); // (100 * 2)
      expect(strategy({ retryAttempt: 5 })).toBe(500); // (100 * 5)
    });

    it('should calculate delay correctly with explicit baseDelayMs', () => {
      const config: LinearBackoffStrategyConfig = { baseDelayMs: 100, incrementMs: 50 };
      const strategy = createLinearBackoffStrategy(config);
      expect(strategy({ retryAttempt: 0 })).toBe(100); // 100 + (50 * 0)
      expect(strategy({ retryAttempt: 1 })).toBe(150); // 100 + (50 * 1)
      expect(strategy({ retryAttempt: 2 })).toBe(200); // 100 + (50 * 2)
      expect(strategy({ retryAttempt: 5 })).toBe(350); // 100 + (50 * 5)
    });
  });

  describe('createExponentialBackoffStrategy', () => {
    const baseConfig = { baseDelayMs: 100 };

    // Mock Math.random and crypto.randomInt for jitter tests
    let mathRandomSpy: MockInstance;

    beforeEach(() => {
      // Default mock for Math.random returning predictable value
      mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      mathRandomSpy.mockRestore();
    });

    it('should calculate delay correctly with no jitter', () => {
      const strategy = createExponentialBackoffStrategy({
        ...baseConfig,
        jitter: 'none',
      });
      expect(strategy({ retryAttempt: 0 })).toBe(100); // 100 * 2^0
      expect(strategy({ retryAttempt: 1 })).toBe(200); // 100 * 2^1
      expect(strategy({ retryAttempt: 2 })).toBe(400); // 100 * 2^2
      expect(strategy({ retryAttempt: 3 })).toBe(800); // 100 * 2^3
    });

    it('should cap the delay at maxDelayMs (no jitter)', () => {
      const strategy = createExponentialBackoffStrategy({
        ...baseConfig,
        maxDelayMs: 500,
        jitter: 'none',
      });
      expect(strategy({ retryAttempt: 0 })).toBe(100); // 100
      expect(strategy({ retryAttempt: 1 })).toBe(200); // 200
      expect(strategy({ retryAttempt: 2 })).toBe(400); // 400
      expect(strategy({ retryAttempt: 3 })).toBe(500); // Capped (800 > 500)
      expect(strategy({ retryAttempt: 4 })).toBe(500); // Capped (1600 > 500)
    });

    it('should calculate delay with full jitter', () => {
      mathRandomSpy.mockReturnValue(0.75); // Control randomness
      const strategy = createExponentialBackoffStrategy({
        ...baseConfig,
        jitter: 'full',
      });
      // retryAttempt: 2 -> exponential = 400ms. Full Jitter = random() * 400
      expect(strategy({ retryAttempt: 2 })).toBeCloseTo(400 * 0.75); // Expect 300
      expect(Math.random).toHaveBeenCalled();

      mathRandomSpy.mockReturnValue(0.1);
      // retryAttempt: 3 -> exponential = 800ms. Full Jitter = random() * 800
      expect(strategy({ retryAttempt: 3 })).toBeCloseTo(800 * 0.1); // Expect 80
    });

    it('should calculate delay with equal jitter', () => {
      mathRandomSpy.mockReturnValue(0.6); // Control randomness
      const strategy = createExponentialBackoffStrategy({
        ...baseConfig,
        jitter: 'equal',
      });

      // retryAttempt: 2 -> exponential = 400ms. cap = 400. half = 200.
      // Equal Jitter = half + random() * half = 200 + 0.6 * 200 = 200 + 120 = 320
      expect(strategy({ retryAttempt: 2 })).toBeCloseTo(320);
      expect(Math.random).toHaveBeenCalled();

      mathRandomSpy.mockReturnValue(0.1);
      // retryAttempt: 3 -> exponential = 800ms. cap = 800. half = 400.
      // Equal Jitter = half + random() * half = 400 + 0.1 * 400 = 400 + 40 = 440
      expect(strategy({ retryAttempt: 3 })).toBeCloseTo(440);
    });

    it('should apply maxDelayMs cap *before* applying jitter', () => {
      mathRandomSpy.mockReturnValue(0.8); // Use Math.random for simplicity here
      const strategy = createExponentialBackoffStrategy({
        ...baseConfig,
        maxDelayMs: 500,
        jitter: 'full', // Test with full jitter
      });

      // retryAttempt: 2 -> exp = 400. Capped = 400. Delay = random() * 400
      expect(strategy({ retryAttempt: 2 })).toBeCloseTo(400 * 0.8); // 320

      // retryAttempt: 3 -> exp = 800. Capped = 500. Delay = random() * 500
      expect(strategy({ retryAttempt: 3 })).toBeCloseTo(500 * 0.8); // 400 (NOT random()*800)

      // retryAttempt: 4 -> exp = 1600. Capped = 500. Delay = random() * 500
      expect(strategy({ retryAttempt: 4 })).toBeCloseTo(500 * 0.8); // 400
    });
  });

  describe('backoffStrategyFactory', () => {
    it('should create a NoBackoff strategy for type "none"', () => {
      const strategy = backoffStrategyFactory({ type: 'none' });
      expect(strategy({ retryAttempt: 5 })).toBe(0);
    });

    it('should create a FixedBackoff strategy for type "fixed"', () => {
      const strategy = backoffStrategyFactory({
        type: 'fixed',
        delayMs: 333,
      });
      expect(strategy({ retryAttempt: 0 })).toBe(333);
      expect(strategy({ retryAttempt: 5 })).toBe(333);
    });

    it('should create a LinearBackoff strategy for type "linear"', () => {
      const strategy = backoffStrategyFactory({
        type: 'linear',
        baseDelayMs: 50,
        incrementMs: 25,
      });
      expect(strategy({ retryAttempt: 0 })).toBe(50); // 50 + (25 * 0)
      expect(strategy({ retryAttempt: 3 })).toBe(125); // 50 + (25 * 3)
    });

    it('should create an ExponentialBackoff strategy for type "exponential"', () => {
      // Mock random to check jitter application via factory
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const strategy = backoffStrategyFactory({
        type: 'exponential',
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: 'full', // Use jitter to verify correct creation
      });

      // retryAttempt: 2 -> exp = 400. capped=400. Delay = random()*400 = 0.5 * 400 = 200
      expect(strategy({ retryAttempt: 2 })).toBeCloseTo(200);
      expect(Math.random).toHaveBeenCalled();

      // retryAttempt: 4 -> exp = 1600. capped=1000. Delay = random()*1000 = 0.5 * 1000 = 500
      expect(strategy({ retryAttempt: 4 })).toBeCloseTo(500);

      mathRandomSpy.mockRestore(); // Clean up mock specific to this test
    });

    // Vitest checks for exhaustive switches, but an explicit test is good practice
    it('should throw for an unknown strategy type', () => {
      // Use type assertion to bypass TypeScript check for the test
      const invalidOptions = { type: 'unknown' } as unknown as BackoffStrategyOptions;
      expect(() => backoffStrategyFactory(invalidOptions)).toThrow(/Unknown backoff strategy type/);
    });
  });
});
