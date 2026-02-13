# Chrono

> **Warning** This project is pre-alpha and not ready for production use.

A TypeScript task scheduling and processing system for reliable background job processing.

## Packages

This is a monorepo containing the core library and datastore implementations:

| Package | Description |
|---------|-------------|
| [@neofinancial/chrono](packages/chrono-core) | Core task scheduling and processing engine |
| [@neofinancial/chrono-mongo-datastore](packages/chrono-mongo-datastore) | MongoDB datastore for persistent task storage |
| [@neofinancial/chrono-memory-datastore](packages/chrono-memory-datastore) | In-memory datastore for development and testing |

## Highlights

- **Type-safe** -- strongly typed tasks, handlers, and plugin APIs
- **Datastore agnostic** -- bring your own storage backend
- **Configurable retries** -- none, fixed, linear, and exponential backoff with jitter
- **Plugin system** -- extend Chrono with plugins that hook into lifecycle events
- **Event-driven** -- observe task lifecycle at both the instance and processor level

## Quick Example

```typescript
import { Chrono } from "@neofinancial/chrono";
import { ChronoMemoryDatastore } from "@neofinancial/chrono-memory-datastore";

type TaskMapping = {
  "send-email": { to: string; subject: string; body: string };
};

const datastore = new ChronoMemoryDatastore<TaskMapping, undefined>();
const chrono = new Chrono<TaskMapping, undefined>(datastore);

chrono.registerTaskHandler({
  kind: "send-email",
  handler: async (task) => {
    console.log(`Sending email to ${task.data.to}`);
  },
});

await chrono.start();

await chrono.scheduleTask({
  kind: "send-email",
  when: new Date(),
  data: { to: "user@example.com", subject: "Hello!", body: "Welcome!" },
});
```

See the [@neofinancial/chrono README](packages/chrono-core) for the full API, configuration options, events, retry strategies, and plugin system documentation.

For MongoDB usage, see the [@neofinancial/chrono-mongo-datastore README](packages/chrono-mongo-datastore).

## Development

### Prerequisites

- Node.js >= 22.14.0
- [PNPM](https://pnpm.io/installation#using-corepack) (via Corepack)

### Build

```sh
pnpm install
pnpm build
```

### Test

```sh
pnpm test
```

## License

MIT
