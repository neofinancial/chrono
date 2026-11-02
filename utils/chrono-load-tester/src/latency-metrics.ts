import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks';

type LatencySummary = {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function milliseconds(nanoseconds: number): number {
  return Number((nanoseconds / NANOSECONDS_PER_MILLISECOND).toFixed(3));
}

export class LatencyMetrics {
  private readonly histograms = new Map<string, RecordableHistogram>();

  record(name: string, durationMs: number): void {
    const histogram = this.histograms.get(name) ?? createHistogram();
    if (!this.histograms.has(name)) {
      this.histograms.set(name, histogram);
    }

    histogram.record(Math.max(1, Math.round(durationMs * NANOSECONDS_PER_MILLISECOND)));
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  summarize(): Record<string, LatencySummary> {
    return Object.fromEntries(
      [...this.histograms.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, histogram]) => [
          name,
          {
            count: histogram.count,
            min: milliseconds(histogram.min),
            mean: milliseconds(histogram.mean),
            p50: milliseconds(histogram.percentile(50)),
            p95: milliseconds(histogram.percentile(95)),
            p99: milliseconds(histogram.percentile(99)),
            max: milliseconds(histogram.max),
          },
        ]),
    );
  }
}
