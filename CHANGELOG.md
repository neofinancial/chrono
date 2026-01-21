# Changelog

All notable changes to this project will be documented in this file.

## 0.6.0 (2026-01-21)

### ⚠ BREAKING CHANGES
- Update adds implementation of `statistics` to `Datastore` interface. This will be breaking for all code implementing interface as method is required

### Features
Introduced new `statisticsCollected` and `statisticsCollectedError` events for Processors.
- `statisticsCollected` event is emitted once every `statCollectionIntervalMs` with data containing `claimableTaskCount` and `failedTaskCount`. This event is intended to be used for monitoring the processor to ensure the correct configuration was used.
- `statisticsCollectedError` event is emitted if an error occurs attempting to collect the data needed for the `statisticsCollected`.

### Bug Fixes
- `@neofinancial/chrono-mongo-datastore` now has `mongodb` driver as a dependency rather then peerDependency. This comes after issues related npm incorrectly resolving mongodb versions due to devDependencies. Further investigation will be done so it can be moved back as devDependency
