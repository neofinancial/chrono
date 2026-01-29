# @neofinancial/chrono

⚠️ This project is pre-alpha, and not ready for production use. ⚠️

A TypeScript task scheduling and processing system for reliable background job processing.

## Features

- **Type-safe task processing**: Define strongly typed tasks and handlers
- **Flexible scheduling**: Schedule tasks for immediate or future execution
- **Configurable retry strategies**: Linear and exponential backoff with optional jitter
- **Idempotency support**: Prevent duplicate task processing
- **Event-based architecture**: Track task lifecycle events
- **Datastore agnostic**: Works with any compatible datastore implementation

## Installation

```bash
npm install @neofinancial/chrono
# or
pnpm add @neofinancial/chrono
# or
yarn add @neofinancial/chrono
```

This package supports both **CommonJS** and **ES Modules**:

```typescript
// ESM
import { Chrono } from "@neofinancial/chrono";

// CommonJS
const { Chrono } = require("@neofinancial/chrono");
```

## Basic Usage

```typescript
import { Chrono } from "@neofinancial/chrono";

// Define your task types. Chrono uses a very strict type system and requires upfront definitions of types
type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
  "process-payment": { userId: string; amount: number };
};

// You'll need a datastore implementation
// Datastore is anything that implements the Datastore interface
// See @neofinancial/chrono-memory-datastore or @neofinancial/chrono-mongo-datastore
const datastore = /* your datastore instance */;

// Initialize Chrono with the datastore
const chrono = new Chrono<TaskMapping, undefined>(datastore);

// Register task handlers
chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => {
    // Logic to send an email
    console.log(
      `Sending email to ${task.data.to} with subject "${task.data.subject}"`
    );
  },
  backoffStrategyOptions: {
    type: "linear",
    baseDelayMs: 1000,
    incrementMs: 2000,
  },
});

chrono.registerTaskHandler({
  kind: "process-payment",
  handler: async (task) => {
    // Logic to process payment
    console.log(
      `Processing payment of ${task.data.amount} for user ${task.data.userId}`
    );
  },
  backoffStrategyOptions: {
    type: "exponential",
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    jitter: "full",
  },
});

// Start Chrono
await chrono.start();

// Schedule tasks
await chrono.scheduleTask({
  kind: "send-email",
  when: new Date(), // run immediately
  data: {
    to: "user@example.com",
    subject: "Welcome!",
    body: "Welcome to our application!",
  },
});

// Schedule a task for the future
const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60 * 1000);

await chrono.scheduleTask({
  kind: "process-payment",
  when: thirtyMinutesFromNow, // run 30 minutes from now
  data: {
    userId: "user-123",
    amount: 99.99,
  },
  idempotencyKey: "payment-123", // Prevents duplicate processing
});

// For cleanup when shutting down
process.on("SIGINT", async () => {
  await chrono.stop();
  process.exit(0);
});
```

## Datastore Implementations

Chrono requires a datastore implementation to persist and manage tasks. Available implementations:

- **[@neofinancial/chrono-memory-datastore](https://www.npmjs.com/package/@neofinancial/chrono-memory-datastore)**: In-memory datastore for development and testing
- **[@neofinancial/chrono-mongo-datastore](https://www.npmjs.com/package/@neofinancial/chrono-mongo-datastore)**: MongoDB datastore for production use

## Configuration

You can tune processor behavior per task by passing `processorConfiguration` when registering a handler. Each task kind gets its own processor instance, and we currently only support the built-in simple processor.

```typescript
chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => {
    // ...
  },
  processorConfiguration: {
    type: "simple",
    maxConcurrency: 5,
    claimIntervalMs: 50,
    idleIntervalMs: 5000,
    claimStaleTimeoutMs: 10000,
    taskHandlerTimeoutMs: 5000,
    taskHandlerMaxRetries: 5,
    processLoopRetryIntervalMs: 20000,
  },
});
```

### Processor configuration options

- `type` (default: 'simple'): processor type to use. Currently only `simple` available as option
- `maxConcurrency` (default: 1): maximum number of concurrent tasks
- `claimIntervalMs` (default: 50): wait time between polls when a task was claimed
- `idleIntervalMs` (default: 5000): wait time between polls when no tasks are available
- `claimStaleTimeoutMs` (default: 10000): max claim time before a task is considered stale
- `taskHandlerTimeoutMs` (default: 5000): max handler runtime before timeout
- `taskHandlerMaxRetries` (default: 5): max retries before a task is marked failed
- `processLoopRetryIntervalMs` (default: 20000): wait time after unexpected errors

## Events

### Chrono Instance Events

- `started` - Emitted after starting all processors by calling `chrono.start()`
- `stopAborted` - Emitted if any processor fails to stop within the exit timeout, causing shutdown to abort

### Processor Instance Events

- `taskClaimed` - Emitted when a task has been claimed by the running processor for handling
- `taskCompleted` - Emitted when a task has completed processing and successfully marked as completed
- `taskRetryScheduled` - Emitted when a task has failed during processing and is being scheduled for retry
- `taskFailed` - Emitted when a task has been marked as FAILED due to process failures exceeding max retries
- `taskCompletionFailure` - Emitted when a task has been successfully processed but the underlying datastore failed to mark the task as completed (duplicate processing expected)
- `unknownProcessingError` - Emitted when an unknown and uncaught exception occurred in the processor. Processing is paused for `processLoopRetryIntervalMs` before continuing

## Statistics Collector

The `StatisticsCollector` is a separate component for collecting and monitoring task statistics outside of the normal task processing flow. It periodically queries the datastore to gather statistics about tasks in various states.

### Basic Usage

```typescript
import { createStatisticsCollector } from "@neofinancial/chrono";

// Your datastore must implement StatisticsCollectorDatastore interface
const statisticsCollector = createStatisticsCollector<TaskMapping>({
  statisticsCollectorDatastore: datastore,
  taskKinds: ["send-email", "process-payment"],
  configuration: {
    type: "simple",
    statCollectionIntervalMs: 1_800_000, // 30 minutes (default)
  },
});

// Listen for statistics events
statisticsCollector.on("statisticsCollected", ({ statistics, timestamp }) => {
  console.log("Task statistics:", statistics);
});

statisticsCollector.on("statisticsCollectedError", ({ error, timestamp }) => {
  console.error("Failed to collect statistics:", error);
});

// Start collecting statistics
await statisticsCollector.start();

// Stop when done
await statisticsCollector.stop();
```

### Configuration Options

- `statCollectionIntervalMs` (default: 1_800_000): interval in milliseconds between statistics collection

### Statistics Collector Events

- `statisticsCollected` - Emitted when task statistics are collected successfully. Contains a summary of all tasks in an incomplete state per task kind.
- `statisticsCollectedError` - Emitted when an error occurs while attempting to collect statistics

## Retry Strategies

Chrono supports configurable retry strategies:

### No Backoff

```typescript
{
  type: "none";
}
```

### Fixed Backoff

```typescript
{
  type: "fixed",
  delayMs: 1000       // Fixed delay in milliseconds
}
```

### Linear Backoff

```typescript
{
  type: "linear",
  baseDelayMs: 1000,    // Initial delay
  incrementMs: 2000,    // Amount to add each retry
}
```

### Exponential Backoff

```typescript
{
  type: "exponential",
  baseDelayMs: 1000,    // Initial delay
  maxDelayMs: 60000,    // Maximum delay cap
  jitter: "full",       // Optional: "none" | "full" | "equal"
}
```

## TypeScript Support

This package is written in TypeScript and provides full type safety for your task definitions and handlers.

## License

MIT

## Contributing

This package is part of the [chrono monorepo](https://github.com/neofinancial/chrono). Please see the main repository for contributing guidelines.
