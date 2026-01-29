# @neofinancial/chrono-statistics-plugin

Statistics collection plugin for the Chrono task scheduling system.

## Installation

```bash
npm install @neofinancial/chrono-statistics-plugin
# or
pnpm add @neofinancial/chrono-statistics-plugin
```

## Strategies

The plugin supports two strategies for collecting statistics:

### Polling Strategy

Periodically queries the datastore for task counts. Requires your datastore to implement the `StatisticsCollectorDatastore` interface.

```typescript
import { Chrono } from '@neofinancial/chrono';
import { createStatisticsPlugin } from '@neofinancial/chrono-statistics-plugin';

// Your datastore must implement StatisticsCollectorDatastore
const chrono = new Chrono(datastore);

const statistics = chrono.use(
  createStatisticsPlugin({
    type: 'polling',
    datastore: datastore, // Must implement StatisticsCollectorDatastore
    intervalMs: 60_000, // Poll every minute (default: 30 minutes)
  })
);

await chrono.start();

// Subscribe to statistics events
statistics.collector.on('statisticsCollected', ({ statistics, timestamp }) => {
  console.log('Statistics collected at', timestamp);
  console.log(statistics);
});
```

### Event-Collect Strategy (Coming Soon)

Collects statistics by listening to processor events. Does not require any special datastore interface.

```typescript
const statistics = chrono.use(
  createStatisticsPlugin({
    type: 'event-collect',
    intervalMs: 60_000, // Emit stats every minute
  })
);
```

## Configuration

### Polling Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `type` | `'polling'` | Yes | - | Use polling strategy |
| `datastore` | `StatisticsCollectorDatastore` | Yes | - | Datastore to poll for statistics |
| `intervalMs` | `number` | No | `1_800_000` (30 min) | Interval between polls |

### Event-Collect Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `type` | `'event-collect'` | Yes | - | Use event-based collection |
| `intervalMs` | `number` | No | `1_800_000` (30 min) | Interval to emit collected stats |

## API

### `createStatisticsPlugin(config)`

Creates a Chrono plugin for statistics collection.

**Returns:** `ChronoPlugin<TaskMapping, StatisticsPluginAPI<TaskMapping>>`

### `StatisticsPluginAPI`

The API returned when registering the plugin via `chrono.use()`.

```typescript
interface StatisticsPluginAPI<TaskMapping> {
  collector: SimpleStatisticsCollector<TaskMapping>;
}
```

### Events

The `collector` is an EventEmitter that emits:

- `statisticsCollected` - Emitted when statistics are successfully collected
- `statisticsCollectedError` - Emitted when an error occurs during collection

## Type Safety

The plugin uses TypeScript overloads to ensure type safety:

```typescript
// Polling requires a datastore that implements StatisticsCollectorDatastore
createStatisticsPlugin({
  type: 'polling',
  datastore: myDatastore, // ✓ TypeScript ensures this has collectStatistics()
});

// Event-collect doesn't require any special datastore
createStatisticsPlugin({
  type: 'event-collect',
  // No datastore needed! ✓
});
```

## License

MIT
