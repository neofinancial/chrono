# Changelog

All notable changes to this project will be documented in this file.

## 0.6.0 (2026-01-28)

### Features

- Added ESM and CommonJS dual module support using tsdown
- Added `setDatabaseConnection` and `getDatabaseConnection` methods to `@neofinancial/chrono-mongo-datastore`, allowing datastore instantiation without an immediate database connection
- Added new `StatisticsCollectorDatastore` interface and `StatisticsCollector` interface for extended statistics collection outside of existing `ChronoEvents`
- Added `createStatisticsCollector` factory for generating a `StatisticsCollector` from a `StatisticsCollectorDatastore`. This collector can be used for monitoring additional data not provided by existing Chrono events
- `StatisticsCollector` emits `statisticsCollected` and `statisticsCollectedError` events. The `statisticsCollected` event contains a summary of all tasks in an incomplete state per `kind`

### Bug Fixes

- Fixed EventEmitter import to use `node:events` instead of `node:streams` for correct event type definitions
- `@neofinancial/chrono-mongo-datastore` now has `mongodb` driver as a dependency rather than a peerDependency. This comes after issues with npm incorrectly resolving mongodb versions due to devDependencies. Further investigation will be done so it can be moved back to peerDependency
