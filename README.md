# chrono

Monorepo for @neofinancial/chrono packages and supporting libraries.

## Dev setup

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

### Chrono instance events

**Lifecycle related events**
- `ready` - Emits this event when all processors are started as a result of calling `chrono.start()` method.
- `stopped` - Emits this event when all processors are successfully stopped as a result of calling `chrono.stop()` method.
- `stop.failed` - Emits this event if any processor fails to stop within the exit timeout as a result of calling `chrono.stop()` method.
- `close` - Emits this event after stopping all processors regardless successful or not as a result of calling `chrono.stop()` method.

**Task related events**
- `task.scheduled` - Emits this event when the task is successfully scheduled as a result of calling `chrono.scheduleTask()` method.
- `task.schedule.failed` - Emits this event when chrono fails to schedule a task as a result of calling `chrono.scheduleTask()` method.
- `task.deleted` - Emits this event when the task is successfully deleted as a result of calling `chrono.deleteTask()` method.
- `task.delete.failed` - Emits this event when chrono fails to schedule a task as a result of calling `chrono.deleteTask()` method.

### Processor instance events

**Process loop related events**
- `processloop.error` - Emits this event when an error occurs in the process loop (the process of claiming a task and processing it by calling the given handler).

**Task related events**
- `task.claimed` - Emits this event when a task is claimed.
- `task.completed` - Emits this event when a task is successfully processed.
- `task.complete.failed` -  Emits this event when the task fails to mark as completed.
- `task.unclaimed` - Emits this event when the processor receives an error from the given task handler and the task will be retried.
- `task.failed` - Emits this event when the processor receives an error from the given task handler and the max retries is reached.
