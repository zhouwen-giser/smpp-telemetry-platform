#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_REF=v25.3.14.14-lts
SOURCE_COMMIT=84d6b30ad528e77d787ab7a2437406c1e2a5887a
SOURCE_URL=https://github.com/ClickHouse/ClickHouse.git
ARCHIVE_NAME=clickhouse-25.3.14.14-complete-source.tar.zst
OUTPUT=${1:-"$ROOT/clickhouse-arm64/vendor/$ARCHIVE_NAME"}
CACHE_DIR=${CLICKHOUSE_PACKAGING_CACHE_DIR:-/tmp/smpp-clickhouse-25.3.14.14-source-cache}
FETCH_RETRIES=${CLICKHOUSE_SOURCE_FETCH_RETRIES:-12}
FETCH_JOBS=${CLICKHOUSE_SOURCE_FETCH_JOBS:-2}

for command_name in git tar zstd sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 \
    || { echo "missing source packaging command: $command_name" >&2; exit 1; }
done
for value_name in FETCH_RETRIES FETCH_JOBS; do
  value=${!value_name}
  case "$value" in
    ''|*[!0-9]*|0) echo "$value_name must be a positive integer" >&2; exit 2 ;;
  esac
done

mkdir -p "$CACHE_DIR" "$(dirname -- "$OUTPUT")"
if [ ! -d "$CACHE_DIR/.git" ]; then
  # CACHE_DIR is a task-specific download cache, not a user data directory.
  find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  git init "$CACHE_DIR"
  git -C "$CACHE_DIR" remote add origin "$SOURCE_URL"
else
  git -C "$CACHE_DIR" remote set-url origin "$SOURCE_URL"
fi
test "$(git -C "$CACHE_DIR" rev-parse --show-toplevel)" = "$CACHE_DIR"

git_network() {
  git \
    -c http.version=HTTP/1.1 \
    -c http.maxRequests="$FETCH_JOBS" \
    -c submodule.fetchJobs="$FETCH_JOBS" \
    -c http.lowSpeedLimit=1 \
    -c http.lowSpeedTime=60 \
    "$@"
}

retry_git() {
  local description=$1
  shift
  local attempt=1
  local delay
  until "$@"; do
    if [ "$attempt" -ge "$FETCH_RETRIES" ]; then
      echo "$description failed after $attempt attempts" >&2
      return 1
    fi
    delay=$((attempt * 5))
    echo "$description failed (attempt $attempt/$FETCH_RETRIES); retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

retry_git \
  'ClickHouse source fetch' \
  git_network -C "$CACHE_DIR" fetch --force --depth 1 --no-tags origin \
    "refs/tags/$SOURCE_REF:refs/tags/$SOURCE_REF"
git -C "$CACHE_DIR" checkout --force --detach "refs/tags/$SOURCE_REF"
test "$(git -C "$CACHE_DIR" rev-parse HEAD)" = "$SOURCE_COMMIT"

git -C "$CACHE_DIR" submodule sync --recursive
retry_git \
  'ClickHouse recursive submodule fetch' \
  git_network -C "$CACHE_DIR" submodule update --init --recursive --depth 1 --jobs "$FETCH_JOBS"

if git -C "$CACHE_DIR" submodule status --recursive | grep -Eq '^[+-U]'; then
  echo 'one or more ClickHouse submodules are absent or at an unexpected revision' >&2
  exit 1
fi

# An interrupted initial `git submodule update` can leave a submodule HEAD at
# the expected commit while its index/worktree is empty. `submodule status`
# still reports that state as healthy. Materialize every locked tree and then
# fail if any tracked file remains deleted or modified.
git -C "$CACHE_DIR" submodule foreach --quiet --recursive \
  'git reset --hard --quiet HEAD && git diff-index --quiet HEAD --'

required_source_files=(
  contrib/icudata/icudt78l_dat.S
  contrib/rapidjson/include/rapidjson/document.h
  contrib/dragonbox/include/dragonbox/dragonbox.h
  contrib/bzip2/bzlib.c
)
for required_source_file in "${required_source_files[@]}"; do
  if [ ! -s "$CACHE_DIR/$required_source_file" ]; then
    echo "required ClickHouse source file is absent: $required_source_file" >&2
    exit 1
  fi
done

SOURCE_EPOCH=$(git -C "$CACHE_DIR" show -s --format=%ct "$SOURCE_COMMIT")
printf '%s\n' "$SOURCE_COMMIT" > "$CACHE_DIR/.clickhouse-source-revision"
TEMP_ARCHIVE="$OUTPUT.tmp"
rm -f -- "$TEMP_ARCHIVE"

echo "creating complete reproducible source archive: $OUTPUT"
tar \
  --sort=name \
  --mtime="@$SOURCE_EPOCH" \
  --clamp-mtime \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --exclude='.git' \
  --exclude='*/.git' \
  -C "$CACHE_DIR" -cf - . \
  | zstd -T0 -10 --no-progress -o "$TEMP_ARCHIVE"
mv -f -- "$TEMP_ARCHIVE" "$OUTPUT"
(
  cd "$(dirname -- "$OUTPUT")"
  sha256sum "$(basename -- "$OUTPUT")" > "$(basename -- "$OUTPUT").sha256"
)

zstd --test --quiet "$OUTPUT"
printf 'source archive ready: %s\n' "$OUTPUT"
cat "$OUTPUT.sha256"
