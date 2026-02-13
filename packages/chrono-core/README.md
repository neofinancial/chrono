# @neofinancial/chrono

> **Warning** This project is pre-alpha and not ready for production use.

A TypeScript task scheduling and processing system for reliable background job processing.

## Features

- **Type-safe task processing** -- define strongly typed tasks and handlers
- **Flexible scheduling** -- schedule tasks for immediate or future execution
- **Configurable retry strategies** -- none, fixed, linear, and exponential backoff with optional jitter
- **Idempotency support** -- prevent duplicate task processing with idempotency keys
- **Event-based architecture** -- track task lifecycle events at both the Chrono and processor level
- **Plugin system** -- extend Chrono with plugins that can register handlers, schedule tasks, and hook into lifecycle events
- **Datastore agnostic** -- works with any compatible datastore implementation

## Installation

```bash
npm install @neofinancial/chrono
# or
pnpm add @neofinancial/chrono
# or
yarn add @neofinancial/chrono
```

### Module Formats

Both CommonJS and ES Modules are supported:

```typescript
// ESM
import { Chrono } from "@neofinancial/chrono";

// CommonJS
const { Chrono } = require("@neofinancial/chrono");
```

## Requirements

- **Node.js** >= 20.18.3

## Quick Start

```typescript
import { Chrono } from "@neofinancial/chrono";

// Define your task types
type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
  "process-payment": { userId: string; amount: number };
};

// Create a datastore (see Datastore Implementations below)
const datastore = /* your datastore instance */;

// Initialize Chrono
const chrono = new Chrono<TaskMapping, DatastoreOptions>(datastore);

// Register task handlers
chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => {
    console.log(`Sending email to ${task.data.to}: "${task.data.subject}"`);
  },
});

chrono.registerTaskHandler({
  kind: "process-payment",
  handler: async (task) => {
    console.log(`Processing $${task.data.amount} for user ${task.data.userId}`);
  },
});

// Start processing
await chrono.start();

// Schedule a task
await chrono.scheduleTask({
  kind: "send-email",
  when: new Date(),
  data: {
    to: "user@example.com",
    subject: "Welcome!",
    body: "Welcome to our application!",
  },
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await chrono.stop();
  process.exit(0);
});
```

## Scheduling Tasks

Use `chrono.scheduleTask()` to create tasks for processing:

```typescript
await chrono.scheduleTask({
  kind: "send-email",          // Must match a registered task kind
  when: new Date(),            // When to execute (Date object)
  data: {                      // Type-safe payload matching your TaskMapping
    to: "user@example.com",
    subject: "Hello",
    body: "World",
  },
  priority: 10,                // Optional: higher values are processed first
  idempotencyKey: "email-123", // Optional: prevents duplicate tasks
  datastoreOptions: {},        // Optional: datastore-specific options (e.g. MongoDB session)
});
```

## Deleting Tasks

Delete a task by its ID:

```typescript
const deletedTask = await chrono.deleteTask("task-id-here");
```

Only tasks in `PENDING` status can be deleted by default.

## Retry Strategies

Configure retry behavior per task handler via `backoffStrategyOptions`. If not specified, the default strategy is **linear** with a 2000ms increment.

### None

No retries. The task is marked as failed immediately on error.

```typescript
{ type: "none" }
```

### Fixed

Constant delay between retries.

```typescript
{
  type: "fixed",
  delayMs: 1000,         // Delay in milliseconds between retries
}
```

### Linear

Delay increases by a fixed increment each retry.

```typescript
{
  type: "linear",
  baseDelayMs: 1000,     // Optional: initial delay (default: 0)
  incrementMs: 2000,     // Added to the delay on each retry
}
```

### Exponential

Delay doubles each retry with an optional cap and jitter.

```typescript
{
  type: "exponential",
  baseDelayMs: 1000,     // Initial delay
  maxDelayMs: 60000,     // Optional: maximum delay cap
  jitter: "full",        // Optional: "none" | "full" | "equal"
}
```

## Processor Configuration

Each task handler runs on a processor that polls the datastore for tasks. Configure processor behavior via `processorConfiguration`:

```typescript
chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => { /* ... */ },
  processorConfiguration: {
    maxConcurrency: 5,
    claimIntervalMs: 100,
    taskHandlerTimeoutMs: 30_000,
    taskHandlerMaxRetries: 10,
  },
});
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxConcurrency` | `number` | `1` | Maximum number of tasks processed concurrently |
| `claimIntervalMs` | `number` | `50` | Interval in ms between task claim attempts when busy |
| `claimStaleTimeoutMs` | `number` | `10000` | Time in ms before a claimed task is considered stale and can be re-claimed |
| `idleIntervalMs` | `number` | `5000` | Interval in ms between claim attempts when no tasks are available |
| `taskHandlerTimeoutMs` | `number` | `5000` | Maximum time in ms a task handler can run before timing out |
| `taskHandlerMaxRetries` | `number` | `5` | Maximum number of retries before a task is marked as failed |
| `processLoopRetryIntervalMs` | `number` | `20000` | Interval in ms before retrying after an unexpected error in the processing loop |

## Events

### Chrono Events

Listen for Chrono-level events on the Chrono instance:

```typescript
import { ChronoEvents } from "@neofinancial/chrono";

chrono.on(ChronoEvents.STARTED, ({ startedAt }) => {
  console.log(`Chrono started at ${startedAt}`);
});

chrono.on(ChronoEvents.STOP_ABORTED, ({ error, timestamp }) => {
  console.error(`Failed to stop gracefully at ${timestamp}:`, error);
});
```

| Event | Constant | Payload |
|-------|----------|---------|
| `started` | `ChronoEvents.STARTED` | `{ startedAt: Date }` |
| `stopAborted` | `ChronoEvents.STOP_ABORTED` | `{ error: unknown; timestamp: Date }` |

### Processor Events

Each call to `registerTaskHandler` returns a processor event emitter. Listen for task-level events:

```typescript
import { ProcessorEvents } from "@neofinancial/chrono";

const processor = chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => { /* ... */ },
});

processor.on(ProcessorEvents.TASK_COMPLETED, ({ task, completedAt, startedAt }) => {
  console.log(`Task ${task.id} completed in ${completedAt.getTime() - startedAt.getTime()}ms`);
});

processor.on(ProcessorEvents.TASK_FAILED, ({ task, error, failedAt }) => {
  console.error(`Task ${task.id} failed:`, error);
});
```

| Event | Constant | Payload |
|-------|----------|---------|
| `taskClaimed` | `ProcessorEvents.TASK_CLAIMED` | `{ task, claimedAt }` |
| `taskCompleted` | `ProcessorEvents.TASK_COMPLETED` | `{ task, completedAt, startedAt }` |
| `taskRetryScheduled` | `ProcessorEvents.TASK_RETRY_SCHEDULED` | `{ task, error, retryScheduledAt, errorAt }` |
| `taskFailed` | `ProcessorEvents.TASK_FAILED` | `{ task, error, failedAt }` |
| `taskCompletionFailure` | `ProcessorEvents.TASK_COMPLETION_FAILURE` | `{ task, error, failedAt }` |
| `unknownProcessingError` | `ProcessorEvents.UNKNOWN_PROCESSING_ERROR` | `{ error, timestamp }` |

## Plugins

Extend Chrono with plugins. Plugins are registered before `start()` and can register task handlers, schedule tasks, add other plugins, and hook into lifecycle events.

### Defining a Plugin

```typescript
import type { ChronoPlugin, PluginRegistrationContext } from "@neofinancial/chrono";

const myPlugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
  name: "my-plugin",
  register(context: PluginRegistrationContext<TaskMapping, DatastoreOptions>) {
    // Access Chrono methods via context.chrono
    context.chrono.registerTaskHandler({
      kind: "cleanup",
      handler: async (task) => { /* ... */ },
    });

    // Register lifecycle hooks
    context.hooks.onStart((lifecycleContext) => {
      const kinds = lifecycleContext.getRegisteredTaskKinds();
      console.log("Chrono started with task kinds:", kinds);
    });

    context.hooks.onStop(() => {
      console.log("Chrono is shutting down");
    });
  },
};
```

### Using a Plugin

```typescript
chrono.use(myPlugin);
```

Plugins can also return a typed API:

```typescript
const api = chrono.use(myPluginWithApi);
api.someMethod(); // Type-safe access to plugin functionality
```

### Plugin Registration Context

During `register()`, the plugin receives a `PluginRegistrationContext` with:

- `context.chrono.registerTaskHandler(input)` -- register a task handler
- `context.chrono.use(plugin)` -- register another plugin
- `context.chrono.scheduleTask(input)` -- schedule a task
- `context.chrono.deleteTask(taskId)` -- delete a task
- `context.hooks.onStart(handler)` -- called when Chrono starts (FIFO order)
- `context.hooks.onStop(handler)` -- called when Chrono stops (LIFO order)

### Plugin Lifecycle Context

The `onStart` and `onStop` hook handlers receive a `PluginLifecycleContext` with:

- `getRegisteredTaskKinds()` -- returns all registered task kinds
- `getDatastore()` -- returns the datastore instance
- `getProcessorEvents(kind)` -- returns the event emitter for a processor

## Datastore Interface

Chrono is datastore-agnostic. To implement a custom datastore, implement the `Datastore` interface:

```typescript
import type { Datastore } from "@neofinancial/chrono";

interface Datastore<TaskMapping, DatastoreOptions> {
  schedule(input): Promise<Task>;     // Create a new task
  delete(key, options?): Promise<Task | undefined>; // Delete by ID or idempotency key
  claim(input): Promise<Task | undefined>;  // Claim the next available task for processing
  retry(taskId, retryAt): Promise<Task>;    // Reschedule a failed task for retry
  complete(taskId): Promise<Task>;          // Mark a task as completed
  fail(taskId): Promise<Task>;             // Mark a task as permanently failed
}
```

See the existing implementations for reference:

- [@neofinancial/chrono-mongo-datastore](https://www.npmjs.com/package/@neofinancial/chrono-mongo-datastore) -- MongoDB
- [@neofinancial/chrono-memory-datastore](https://www.npmjs.com/package/@neofinancial/chrono-memory-datastore) -- In-memory (development/testing)

## API Reference

### Chrono Class

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `new Chrono(datastore)` | Create a new Chrono instance with a datastore |
| `use` | `use(plugin): API` | Register a plugin (must be called before `start()`) |
| `start` | `start(): Promise<void>` | Start all processors and execute plugin start hooks |
| `stop` | `stop(): Promise<void>` | Execute plugin stop hooks and stop all processors |
| `registerTaskHandler` | `registerTaskHandler(input): EventEmitter` | Register a handler for a task kind; returns the processor event emitter |
| `scheduleTask` | `scheduleTask(input): Promise<Task>` | Schedule a task for processing |
| `deleteTask` | `deleteTask(taskId): Promise<Task \| undefined>` | Delete a task by ID |

### Exported Types

| Export | Kind | Description |
|--------|------|-------------|
| `Chrono` | Class | Main Chrono class |
| `ChronoEvents` | Enum-like object | Chrono event name constants |
| `ProcessorEvents` | Enum-like object | Processor event name constants |
| `TaskStatus` | Enum-like object | Task status constants (`PENDING`, `CLAIMED`, `COMPLETED`, `FAILED`) |
| `ChronoPlugin` | Interface | Plugin interface |
| `PluginRegistrationContext` | Interface | Context given to plugins during `register()` |
| `PluginLifecycleContext` | Interface | Context given to lifecycle hook handlers |
| `Datastore` | Interface | Datastore interface for custom implementations |
| `Task` | Type | Task document type |
| `TaskMappingBase` | Type | Base type constraint for task mappings |
| `ScheduleTaskInput` | Type | Input type for `scheduleTask()` |
| `RegisterTaskHandlerInput` | Type | Input type for `registerTaskHandler()` |
| `RegisterTaskHandlerResponse` | Type | Return type of `registerTaskHandler()` |
| `ScheduleInput` | Type | Datastore-level schedule input |
| `ClaimTaskInput` | Type | Datastore-level claim input |
| `DeleteInput` | Type | Datastore-level delete input |
| `DeleteOptions` | Type | Datastore-level delete options |
| `DeleteByIdempotencyKeyInput` | Type | Datastore-level delete by idempotency key input |
| `ProcessorEventsMap` | Type | Typed event map for processor events |

## Datastore Implementations

Chrono requires a datastore implementation to persist and manage tasks:

- [@neofinancial/chrono-mongo-datastore](https://www.npmjs.com/package/@neofinancial/chrono-mongo-datastore) -- MongoDB datastore for persistent task storage
- [@neofinancial/chrono-memory-datastore](https://www.npmjs.com/package/@neofinancial/chrono-memory-datastore) -- In-memory datastore for development and testing

## License

MIT

## Contributing

This package is part of the [chrono monorepo](https://github.com/neofinancial/chrono). Please see the main repository for contributing guidelines.
