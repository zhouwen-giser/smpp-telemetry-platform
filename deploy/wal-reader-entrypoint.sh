#!/bin/sh
set -eu
node /run/telemetry/wal-reader-guard.mjs
exec "$@"
