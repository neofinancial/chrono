# @neofinancial/chrono-mongo-datastore

⚠️ This project is pre-alpha, and not ready for production use. ⚠️

MongoDB datastore implementation for [@neofinancial/chrono](https://www.npmjs.com/package/@neofinancial/chrono) - a TypeScript task scheduling and processing system.

## Features

- **MongoDB persistence**: Store tasks reliably in MongoDB
- **Production ready**: Designed for production workloads
- **Type-safe**: Full TypeScript support with generic task types
- **Configurable**: Customize collection names and database settings
- **Optimized queries**: Efficient task claiming and processing

## Installation

```bash
npm install @neofinancial/chrono-mongo-datastore
# or
pnpm add @neofinancial/chrono-mongo-datastore
# or
yarn add @neofinancial/chrono-mongo-datastore
```

This package supports both **CommonJS** and **ES Modules**:

```typescript
// ESM
import { ChronoMongoDatastore } from "@neofinancial/chrono-mongo-datastore";

// CommonJS
const {
  ChronoMongoDatastore,
} = require("@neofinancial/chrono-mongo-datastore");
```

## Peer Dependencies

`@neofinancial/chrono` and `mongodb`

```bash
npm install @neofinancial/chrono mongodb
# or
pnpm add @neofinancial/chrono mongodb
# or
yarn add @neofinancial/chrono mongodb
```

## Requirements

- **Node.js**: >= 20.18.3
- **MongoDB**: >= 4.4
- **@neofinancial/chrono**: >= 0.1.1 (peer dependencies)
- **mongodb**: >= 6.15 (peer dependency)

## Basic Usage

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

// MongoDB connection
const client = new MongoClient("mongodb://localhost:27017");
await client.connect();
const db = client.db("my-app");

// Create MongoDB datastore (uses default collection name 'chrono-tasks')
const datastore = await ChronoMongoDatastore.create<TaskMapping>(db);

// Initialize Chrono with the MongoDB datastore
const chrono = new Chrono<TaskMapping, MongoDatastoreOptions>(datastore);

// Register task handlers
chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => {
    console.log(
      `Sending email to ${task.data.to} with subject "${task.data.subject}"`
    );
    // Your email sending logic here
  },
});

chrono.registerTaskHandler({
  kind: "process-payment",
  handler: async (task) => {
    console.log(
      `Processing payment of ${task.data.amount} for user ${task.data.userId}`
    );
    // Your payment processing logic here
  },
});

// Start processing tasks
await chrono.start();

// Schedule tasks
await chrono.scheduleTask({
  kind: "send-email",
  when: new Date(),
  data: {
    to: "user@example.com",
    subject: "Welcome!",
    body: "Welcome to our application!",
  },
});

// Schedule a future task with idempotency
await chrono.scheduleTask({
  kind: "process-payment",
  when: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
  data: {
    userId: "user-123",
    amount: 99.99,
  },
  idempotencyKey: "payment-user-123-session-abc", // Prevents duplicates
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await chrono.stop();
  await client.close();
  process.exit(0);
});
```

## Configuration

### Configuration Options

```typescript
interface ChronoMongoDatastoreConfig {
  collectionName: string; // Collection name for storing tasks
  completedDocumentTTL?: number; // TTL in seconds for completed tasks (optional)
}
```

### Example with Custom Configuration

```typescript
import { MongoClient } from "mongodb";
import { ChronoMongoDatastore } from "@neofinancial/chrono-mongo-datastore";

const client = new MongoClient("mongodb://localhost:27017", {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

await client.connect();
const db = client.db("production-app");

const datastore = await ChronoMongoDatastore.create<TaskMapping>(db, {
  collectionName: "background-jobs", // Custom collection name
  completedDocumentTTL: 86400, // Delete completed tasks after 24 hours
});
```

## MongoDB Schema

The datastore automatically creates the following indexes for optimal performance:

```javascript
// Compound index for efficient task claiming
{ kind: 1, status: 1, scheduledAt: 1, priority: -1, claimedAt: 1 }

// Index for idempotency key lookups
{ idempotencyKey: 1 }

// Partial expression index using TTL to delete COMPLETED documents
{ completedAt: -1 }
```

### Document Structure

Tasks are stored with the following structure:

```typescript
interface TaskDocument {
  _id: ObjectId;
  kind: string;
  status: "pending" | "claimed" | "completed" | "failed";
  data: any;
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

## Production Considerations

### Connection Management

```typescript
// Use connection pooling for production
const client = new MongoClient(connectionString, {
  maxPoolSize: 10,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
});

// Handle connection errors
client.on("error", (error) => {
  console.error("MongoDB connection error:", error);
});
```

### Database Indexes

The datastore will automatically create necessary indexes, but you may want to create them manually for production deployments:

```javascript
// In MongoDB shell or your migration scripts
// Replace 'chrono-tasks' with your custom collection name if different
db.chrono_tasks.createIndex({ completedAt: -1 }, {
  partialFilterExpression: {
    completedAt: { $exists: true },
    status: { $eq: "COMPLETED" }
  },
  expireAfterSeconds: 2592000, // 30 days
  name: "chrono-completed-document-ttl-index"
});

db.chrono_tasks.createIndex({
  kind: 1,
  status: 1,
  scheduledAt: 1,
  priority: -1,
  claimedAt: 1
}, {
  name: "chrono-claim-document-index"
});

db.chrono_tasks.createIndex({
  idempotencyKey: 1
}, {
  name: "chrono-idempotency-key-index",
  unique: true,
  sparse: true
});

### Monitoring

Monitor these key metrics:

- Task processing latency
- Failed task count
- MongoDB connection pool usage
- Collection size and growth

## API Reference

### ChronoMongoDatastore

The main datastore class implementing the Chrono datastore interface.

#### Methods

All methods are implemented from the base Chrono datastore interface. See [@neofinancial/chrono](https://www.npmjs.com/package/@neofinancial/chrono) documentation for the complete API.

## License

MIT

## Contributing

This package is part of the [chrono monorepo](https://github.com/neofinancial/chrono). Please see the main repository for contributing guidelines.

## Related Packages

- **[@neofinancial/chrono](https://www.npmjs.com/package/@neofinancial/chrono)**: Core task scheduling functionality
- **[@neofinancial/chrono-memory-datastore](https://www.npmjs.com/package/@neofinancial/chrono-memory-datastore)**: In-memory datastore for development and testing
```
