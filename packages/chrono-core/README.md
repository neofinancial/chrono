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

// Define your task types
type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
  "process-payment": { userId: string; amount: number };
};

// You'll need a datastore implementation
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
    maxConcurrency: 5,
    claimIntervalMs: 50,
    idleIntervalMs: 5000,
    claimStaleTimeoutMs: 10000,
    taskHandlerTimeoutMs: 5000,
    taskHandlerMaxRetries: 5,
    processLoopRetryIntervalMs: 20000,
    statCollectionIntervalMs: 1_800_000,
  },
});
```

### Processor configuration options

- `maxConcurrency` (default: 1): maximum number of concurrent tasks
- `claimIntervalMs` (default: 50): wait time between polls when a task was claimed
- `idleIntervalMs` (default: 5000): wait time between polls when no tasks are available
- `claimStaleTimeoutMs` (default: 10000): max claim time before a task is considered stale
- `taskHandlerTimeoutMs` (default: 5000): max handler runtime before timeout
- `taskHandlerMaxRetries` (default: 5): max retries before a task is marked failed
- `processLoopRetryIntervalMs` (default: 20000): wait time after unexpected errors
- `statCollectionIntervalMs` (default: 1_800_000): interval for statistics events

## Events

### Chrono Instance Events

- `ready` - Emitted when all processors are started as a result of calling `chrono.start()`
- `close` - Emitted after stopping all processors as a result of calling `chrono.stop()`
- `stop:failed` - Emitted if any processor fails to stop within the exit timeout

### Processor Instance Events

**Task related events**

- `taskClaimed` - Emitted when a task is claimed
- `taskCompleted` - Emitted when a task is successfully processed
- `taskCompletionFailed` - Emitted when the task fails to mark as completed
- `taskRetryScheduled` - Emitted when a task will be retried after an error
- `taskFailed` - Emitted when max retries is reached after errors and task moves to FAILED state
- `unknownProcessingError` - Emitted when an unknown exception occurs in processor.
- `statisticsCollected` - Emitted when task statistics are collected
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
