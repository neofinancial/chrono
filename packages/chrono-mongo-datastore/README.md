# @neofinancial/chrono-mongo-datastore

> **Warning** This project is pre-alpha and not ready for production use.

MongoDB datastore implementation for [@neofinancial/chrono](https://www.npmjs.com/package/@neofinancial/chrono) -- a TypeScript task scheduling and processing system.

## Features

- **MongoDB persistence** -- store tasks reliably in MongoDB
- **Type-safe** -- full TypeScript support with generic task types
- **Configurable** -- customize collection names, TTL, and uninitialized behavior
- **Automatic indexes** -- optimized indexes created on initialization
- **Transaction support** -- pass MongoDB sessions for transactional task scheduling
- **Deferred initialization** -- operations can queue until the database connection is ready

## Installation

```bash
npm install @neofinancial/chrono-mongo-datastore
# or
pnpm add @neofinancial/chrono-mongo-datastore
# or
yarn add @neofinancial/chrono-mongo-datastore
```

### Peer Dependencies

This package requires `@neofinancial/chrono` as a peer dependency:

```bash
npm install @neofinancial/chrono
```

### Module Formats

Both CommonJS and ES Modules are supported:

```typescript
// ESM
import { ChronoMongoDatastore } from "@neofinancial/chrono-mongo-datastore";

// CommonJS
const {
  ChronoMongoDatastore,
} = require("@neofinancial/chrono-mongo-datastore");
```

## Requirements

- **Node.js** >= 20.18.3
- **MongoDB** >= 4.4
- **@neofinancial/chrono** (peer dependency, version range as specified in package.json)
- **mongodb** (installed as a dependency, version 6.x or compatible)

## Quick Start

```typescript
import { Chrono } from "@neofinancial/chrono";
import {
  ChronoMongoDatastore,
  type MongoDatastoreOptions,
} from "@neofinancial/chrono-mongo-datastore";
import { MongoClient } from "mongodb";

// Define your task types
type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
  "process-payment": { userId: string; amount: number };
};

// Connect to MongoDB
const client = new MongoClient("mongodb://localhost:27017");
await client.connect();

// Create and initialize the datastore
const datastore = new ChronoMongoDatastore<TaskMapping>();
await datastore.initialize(client.db("my-app"));

// Initialize Chrono with the datastore
const chrono = new Chrono<TaskMapping, MongoDatastoreOptions>(datastore);

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

// Start Chrono (processors begin polling)
await chrono.start();

// Schedule tasks
await chrono.scheduleTask({
  kind: "send-email",
  when: new Date(),
  data: { to: "user@example.com", subject: "Welcome!", body: "Hello!" },
});

await chrono.scheduleTask({
  kind: "process-payment",
  when: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
  data: { userId: "user-123", amount: 99.99 },
  idempotencyKey: "payment-user-123-session-abc",
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await chrono.stop();
  await client.close();
  process.exit(0);
});
```

## Configuration

All configuration is optional. Pass a partial config to the constructor:

```typescript
const datastore = new ChronoMongoDatastore<TaskMapping>({
  collectionName: "background-jobs",
  completedDocumentTTLSeconds: 86400, // 24 hours
  uninitializedDatastoreBehavior: "queue",
  maxQueueSize: 1000,
});
```

### Options

| Option                           | Type                   | Default                 | Description                                                                                                       |
| -------------------------------- | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `collectionName`                 | `string`               | `'chrono-tasks'`        | MongoDB collection name for storing tasks                                                                         |
| `completedDocumentTTLSeconds`    | `number`               | `2592000` (30 days)     | TTL in seconds for completed task documents. MongoDB automatically deletes completed documents after this period. |
| `uninitializedDatastoreBehavior` | `'queue'` \| `'throw'` | `'queue'`               | How to handle operations before `initialize()` is called                                                          |
| `maxQueueSize`                   | `number`               | `undefined` (unlimited) | Maximum number of queued operations when behavior is `'queue'`                                                    |

### Uninitialized Datastore Behavior

The datastore supports a two-phase setup: you can create the datastore and register it with Chrono before your MongoDB connection is ready. The `uninitializedDatastoreBehavior` option controls what happens when operations are performed before `initialize()` is called.

**`'queue'` (default)** -- Operations return promises that resolve once `initialize()` is called. This allows you to start Chrono and even schedule tasks before your database connection is established. All queued operations are flushed in order when the database becomes available. Note that all data will be lost if chrono is shutdown before these queued operations are persisted to disk

```typescript
const datastore = new ChronoMongoDatastore<TaskMapping>({
  uninitializedDatastoreBehavior: "queue",
  maxQueueSize: 500, // Optional: limit the queue to prevent unbounded memory growth
});
```

**`'throw'`** -- Operations throw an error immediately if the datastore has not been initialized. Use this when you want to guarantee the database is connected before any operations are attempted.

```typescript
const datastore = new ChronoMongoDatastore<TaskMapping>({
  uninitializedDatastoreBehavior: "throw",
});
```

## MongoDB Sessions

The datastore supports MongoDB sessions for transactional task scheduling via `MongoDatastoreOptions`:

```typescript
import type { MongoDatastoreOptions } from "@neofinancial/chrono-mongo-datastore";

const session = client.startSession();

await session.withTransaction(async () => {
  // Schedule a task within a transaction
  await chrono.scheduleTask({
    kind: "send-email",
    when: new Date(),
    data: { to: "user@example.com", subject: "Order confirmed", body: "..." },
    datastoreOptions: { session },
  });

  // Other transactional operations...
});
```

## MongoDB Schema

### Indexes

The datastore automatically creates three indexes when `initialize()` is called:

**Claim index** -- compound index for efficient task polling and claiming:

```javascript
{ kind: 1, status: 1, scheduledAt: 1, priority: -1, claimedAt: 1 }
// name: "chrono-claim-document-index"
```

**Idempotency key index** -- unique sparse index for deduplication:

```javascript
{
  idempotencyKey: 1;
}
// name: "chrono-idempotency-key-index", unique: true, sparse: true
```

**Completed document TTL index** -- partial TTL index that automatically removes completed tasks:

```javascript
{
  completedAt: -1;
}
// name: "chrono-completed-document-ttl-index"
// partialFilterExpression: { completedAt: { $exists: true }, status: "COMPLETED" }
// expireAfterSeconds: <completedDocumentTTLSeconds or 2592000>
```

### Document Structure

Tasks are stored with the following structure:

```typescript
interface TaskDocument {
  _id: ObjectId;
  kind: string;
  status: "PENDING" | "CLAIMED" | "COMPLETED" | "FAILED";
  data: unknown;
  priority?: number;
  idempotencyKey?: string;
  originalScheduleDate: Date;
  scheduledAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
  lastExecutedAt?: Date;
  retryCount: number;
}
```

## API Reference

### `ChronoMongoDatastore`

#### `constructor(config?: Partial<ChronoMongoDatastoreConfig>)`

Creates a new datastore instance. All configuration options are optional and have sensible defaults.

#### `initialize(database: Db): Promise<void>`

Sets the MongoDB database connection, creates required indexes, and flushes any queued operations. Must be called exactly once. Throws if called a second time.

#### `getDatabase(): Promise<Db>`

Returns the database connection. If the datastore is not yet initialized, behavior depends on `uninitializedDatastoreBehavior`:

- `'queue'`: returns a promise that resolves when `initialize()` is called
- `'throw'`: throws an error immediately

All other methods (`schedule`, `delete`, `claim`, `retry`, `complete`, `fail`) implement the `Datastore` interface from `@neofinancial/chrono`. See the [chrono documentation](https://www.npmjs.com/package/@neofinancial/chrono) for details.

### Exported Types

- `ChronoMongoDatastoreConfig` -- configuration type
- `MongoDatastoreOptions` -- `{ session?: ClientSession }` for transaction support

## License

MIT

## Contributing

This package is part of the [chrono monorepo](https://github.com/neofinancial/chrono). Please see the main repository for contributing guidelines.

## Related Packages

- [@neofinancial/chrono](https://www.npmjs.com/package/@neofinancial/chrono) -- Core task scheduling and processing
- [@neofinancial/chrono-memory-datastore](https://www.npmjs.com/package/@neofinancial/chrono-memory-datastore) -- In-memory datastore for development and testing
