# Chrono load tester

Standalone MongoDB load test for Chrono. Its container starts `mongod`, schedules tasks through Chrono,
and processes them with fake handlers. No external services are required.

Each task gets a seeded random delay. A configurable percentage fails once before succeeding, exercising
claiming, concurrency, retries, and completion. The process exits non-zero if counts or task outcomes do
not match expectations.

It also runs two deterministic regression scenarios:

- repeated schedules with the same idempotency key must create one task and one handler effect
- ready tasks must execute in descending priority order

Both regression scenarios fail on Chrono `master` until scheduling passes `idempotencyKey` and `priority`
to the datastore.

## Run in Docker

From the repository root:

```sh
docker build -f examples/chrono-load-tester/Dockerfile -t chrono-load-tester .
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
  chrono-load-tester
```

The image contains its MongoDB binary and does not need network access at runtime.

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
MONGO_URI=mongodb://127.0.0.1:27017 pnpm --filter chrono-load-tester start
```
