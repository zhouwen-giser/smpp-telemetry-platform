#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

for command_name in git node tar zip unzip sha256sum zstd; do
  command -v "$command_name" >/dev/null 2>&1 \
    || { echo "missing packaging command: $command_name" >&2; exit 1; }
done

source_commit=$(git log -1 --format=%H -- . ':(exclude)reports/smpp-stable-integration/delivery/**')
if ! git diff --quiet "$source_commit" -- . ':(exclude)reports/smpp-stable-integration/delivery/**' \
  || ! git diff --cached --quiet -- . ':(exclude)reports/smpp-stable-integration/delivery/**'; then
  echo 'tracked files are dirty; commit the ARM64 deployment implementation before packaging' >&2
  exit 1
fi

source_epoch=$(git show -s --format=%ct "$source_commit")
source_time=$(git show -s --format=%cI "$source_commit")
package_dir=smpp-telemetry-one-click-arm64
archive_base=smpp-telemetry-one-click-arm64-vendored-clickhouse-source-4318
delivery_dir="$ROOT/reports/smpp-stable-integration/delivery"
archive_path="$delivery_dir/$archive_base.zip"
sidecar_path="$archive_path.sha256"
temporary_dir=$(mktemp -d)
source_archive_name=clickhouse-25.3.14.14-complete-source.tar.zst
source_archive_cache=${CLICKHOUSE_VENDORED_SOURCE_ARCHIVE:-/tmp/smpp-clickhouse-25.3.14.14-complete-source.tar.zst}

cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

mkdir -p "$temporary_dir/$package_dir"

package_paths=(
  .dockerignore
  .env.example
  .gitignore
  README.md
  clickhouse-arm64
  compose.yaml
  config
  contracts
  deploy
  deploy.sh
  docs
  logs.sh
  package.json
  packages
  pnpm-lock.yaml
  pnpm-workspace.yaml
  reset.sh
  secrets
  status.sh
  stop.sh
  telemetry-collector
  telemetry-dashboard
  telemetry-processor
  telemetry-schema
  tools
  tsconfig.json
  一键部署说明.md
)

git archive "$source_commit" "${package_paths[@]}" \
  | tar -x -C "$temporary_dir/$package_dir"

if [ ! -s "$source_archive_cache" ] || [ ! -s "$source_archive_cache.sha256" ]; then
  "$ROOT/tools/prepare-clickhouse-source.sh" "$source_archive_cache"
fi
(
  cd "$(dirname -- "$source_archive_cache")"
  sha256sum --check "$(basename -- "$source_archive_cache").sha256"
)
mkdir -p "$temporary_dir/$package_dir/clickhouse-arm64/vendor"
cp -- "$source_archive_cache" \
  "$temporary_dir/$package_dir/clickhouse-arm64/vendor/$source_archive_name"
(
  cd "$temporary_dir/$package_dir/clickhouse-arm64/vendor"
  sha256sum "$source_archive_name" > "$source_archive_name.sha256"
  sha256sum --check "$source_archive_name.sha256"
)

cat > "$temporary_dir/$package_dir/PACKAGE_INFO.txt" <<EOF
package=$archive_base
source_commit=$source_commit
generated_from_commit_time=$source_time
entrypoint=./deploy.sh
deployment_target=linux/arm64
clickhouse_source_ref=v25.3.14.14-lts
clickhouse_source_commit=84d6b30ad528e77d787ab7a2437406c1e2a5887a
clickhouse_cpu_profile=armv8+crc
precompiled_clickhouse_binary_included=false
complete_clickhouse_source_archive_included=true
target_build_requires_github=false
otlp_http_binding=0.0.0.0:4318
default_other_host_binding=127.0.0.1
runtime_metrics_endpoint=http://192.168.1.7:19100/metrics
EOF

(
  cd "$temporary_dir/$package_dir"
  SOURCE_DATE_EPOCH="$source_epoch" PACKAGE_SOURCE_COMMIT="$source_commit" \
    node tools/create-manifest.ts
  sha256sum --check SHA256SUMS.txt
)

find "$temporary_dir/$package_dir" -exec touch -h -d "@$source_epoch" {} +
(
  cd "$temporary_dir"
  # The large source archive is already compressed with zstd. Storing all
  # entries avoids an expensive and ineffective second compression pass.
  TZ=UTC zip -0 -X -q -r "$archive_base.zip" "$package_dir" -x '*/var/*' '*/secrets/*.txt'
)

mkdir -p "$delivery_dir"
mv -f -- "$temporary_dir/$archive_base.zip" "$archive_path"
(
  cd "$delivery_dir"
  sha256sum "$archive_base.zip" > "$archive_base.zip.sha256"
)

mkdir -p "$temporary_dir/verify"
unzip -q "$archive_path" -d "$temporary_dir/verify"
(
  cd "$temporary_dir/verify/$package_dir"
  sha256sum --check SHA256SUMS.txt >/dev/null
  docker compose config --quiet
)

printf 'created %s\n' "$archive_path"
printf 'created %s\n' "$sidecar_path"
cat "$sidecar_path"
