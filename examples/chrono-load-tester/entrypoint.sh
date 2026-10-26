#!/bin/sh

set -eu

mongo_data_path="${MONGO_DATA_PATH:-/tmp/chrono-load-tester-mongo}"
mongo_port="${MONGO_PORT:-27017}"
mongo_log_path="/tmp/chrono-load-tester-mongod.log"

mkdir -p "$mongo_data_path"

mongod \
  --bind_ip 127.0.0.1 \
  --dbpath "$mongo_data_path" \
  --port "$mongo_port" \
  --quiet >"$mongo_log_path" 2>&1 &
mongo_pid=$!

stop_mongo() {
  kill "$mongo_pid" 2>/dev/null || true
  wait "$mongo_pid" 2>/dev/null || true
}

trap stop_mongo EXIT INT TERM

export MONGO_URI="mongodb://127.0.0.1:$mongo_port"
node examples/chrono-load-tester/build/main.js
