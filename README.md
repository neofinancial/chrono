# Chrono

⚠️ This project is pre-alpha, and not ready for production use. ⚠️

A TypeScript task scheduling and processing system for reliable background job processing.

Chrono is a monorepo containing `@neofinancial/chrono` built in datastore implementations.

## Features

- **Type-safe task processing**: Define strongly typed tasks and handlers
- **Flexible scheduling**: Schedule tasks for immediate or future execution
- **Multiple datastore options**: In-memory and MongoDB implementations
- **Configurable retry strategies**: Linear and exponential backoff with optional jitter
- **Idempotency support**: Prevent duplicate task processing
- **Event-based architecture**: Track task lifecycle events

## Packages

- **[@neofinancial/chrono](packages/chrono-core)**: Core functionality for task scheduling and processing
- **[@neofinancial/chrono-memory-datastore](packages/chrono-memory-datastore)**: In-memory datastore implementation
- **[@neofinancial/chrono-mongo-datastore](packages/chrono-mongo-datastore)**: MongoDB datastore implementation

## Dev Setup

1. Node version `>=22.14.0`.
1. Install [PNPM](https://pnpm.io/installation#using-corepack).

## Build

```sh
pnpm install
pnpm build
```

## Test

```sh
pnpm test
```

## Usage Example

```typescript
import { Chrono } from "@neofinancial/chrono";
import { ChronoMemoryDatastore } from "@neofinancial/chrono-memory-datastore";

// Define your task types
type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
  "process-payment": { userId: string; amount: number };
};

// Create a datastore instance
const datastore = new ChronoMemoryDatastore<TaskMapping, undefined>();

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
  when: futureDate, // run 30 minutes from now
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

## MongoDB Example

```typescript
import { Chrono } from "@neofinancial/chrono";
import { ChronoMongoDatastore } from "@neofinancial/chrono-mongo-datastore";
import { MongoClient } from "mongodb";

// MongoDB connection
const client = new MongoClient("mongodb://localhost:27017");
await client.connect();
const db = client.db("my-app");

// Create MongoDB datastore
const datastore = new ChronoMongoDatastore<TaskMapping, { collection: string }>(
  {
    db,
    collection: "scheduled-tasks",
  }
);

const chrono = new Chrono<TaskMapping, { collection: string }>(datastore);

// Register handlers and start as in the previous example
// ...
```

### Chrono instance events

- `ready` - Emits this event when all processors are started as a result of calling `chrono.start()` method.
- `stopped` - Emits this event when all processors are successfully stopped as a result of calling `chrono.stop()` method.
- `stop.failed` - Emits this event if any processor fails to stop within the exit timeout as a result of calling `chrono.stop()` method.
- `close` - Emits this event after stopping all processors regardless successful or not as a result of calling `chrono.stop()` method.

### Processor instance events

**Process loop related events**

- `processloop.error` - Emits this event when an error occurs in the process loop (the process of claiming a task and processing it by calling the given handler).

**Task related events**
- `task:claimed` - Emits this event when a task is claimed.
- `task:completed` - Emits this event when a task is successfully processed.
- `task:completion:failed` -  Emits this event when the task fails to mark as completed.
- `task:retry:requested` - Emits this event when the processor receives an error from the given task handler and the task will be retried.
- `task:failed` - Emits this event when the processor receives an error from the given task handler and the max retries is reached.