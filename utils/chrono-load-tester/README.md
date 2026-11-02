# Chrono load tester

Standalone MongoDB load test for Chrono. Its container starts `mongod`, schedules tasks through Chrono,
and processes them with fake handlers. No external services are required.

Each task gets a seeded random delay. A configurable percentage fails once before succeeding, exercising
claiming, concurrency, retries, and completion. The process exits non-zero if counts or task outcomes do
not match expectations.

It also runs two deterministic regression scenarios:

- repeated schedules with the same idempotency key must create one task and one handler effect
- ready tasks must execute in descending priority order

The scenarios guard the `Chrono.scheduleTask` passthrough of `idempotencyKey` and `priority` to the datastore.

## Scenarios

Pass a scenario name after the image. Omitting it defaults to `all`.

```sh
docker run --rm --network none chrono-load-tester load
docker run --rm --network none chrono-load-tester idempotency
docker run --rm --network none chrono-load-tester priority
docker run --rm --network none chrono-load-tester all
```

- `load` runs the seeded concurrent workload with injected transient failures
- `idempotency` schedules each key repeatedly and verifies one task and one handler effect
- `priority` verifies that ready tasks are claimed in descending priority order
- `all` runs every scenario

## Run in Docker

From the repository root:

```sh
docker build -f utils/chrono-load-tester/Dockerfile -t chrono-load-tester .
docker run --rm chrono-load-tester
```

Capture both the report and container exit status:

```sh
set -o pipefail
docker run --rm chrono-load-tester 2>&1 | tee chrono-load-report.log
```

Larger run:

```sh
docker run --rm \
  -e TASK_COUNT=10000 \
  -e WORKER_COUNT=8 \
  -e CONCURRENCY_PER_WORKER=16 \
  -e MAX_DELAY_MS=50 \
  -e RETRY_PERCENT=10 \
  -e SEED=42 \
  chrono-load-tester load
```

The image contains its MongoDB binary and does not need network access at runtime.

## Report

The final JSON report includes correctness violations, throughput, and latency summaries in milliseconds.
Each latency summary reports `count`, `min`, `mean`, `p50`, `p95`, `p99`, and `max`.

Scenario `latenciesMs` contains database-neutral timings for Chrono datastore operations and fake handlers.
These are the primary metrics for comparing datastore implementations. `mongoLatenciesMs` contains MongoDB
driver command timings, such as `command.findAndModify`, for Mongo-specific diagnosis.

Percentiles use Node's built-in histogram implementation, so no metrics dependency is required. MongoDB's
profiler can provide deeper query analysis when needed; it is intentionally not required for a normal run.

## Configuration

- `TASK_COUNT`: tasks to schedule, default `1000`
- `WORKER_COUNT`: independent Chrono workers, default `4`
- `CONCURRENCY_PER_WORKER`: processor loops per worker, default `8`
- `MAX_DELAY_MS`: maximum seeded handler delay, default `25`
- `RETRY_PERCENT`: percentage of tasks that fail once, default `10`
- `SEED`: repeatable workload seed, default `42`
- `TIMEOUT_MS`: overall completion timeout, default `120000`

## Run without Docker

Start MongoDB, then provide its connection string:

```sh
pnpm install
pnpm --filter @neofinancial/chrono build
pnpm --filter @neofinancial/chrono-mongo-datastore build
pnpm --filter chrono-load-tester build
MONGO_URI=mongodb://127.0.0.1:27017 pnpm --filter chrono-load-tester start -- load
```
