#!/usr/bin/env bash
# Run only from an isolated source copy on the actual ARM64 qualification host.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
case "$root" in /tmp/smpp-arm64-*/source) ;; *) echo 'Use a dedicated /tmp/smpp-arm64-*/source copy.' >&2; exit 2 ;; esac
cd "$root"
output="$root/reports/remediation-20260907/arm64"
mkdir -p "$output"
host_arch=$(uname -m)
daemon_arch=$(docker info --format '{{.Architecture}}')
case "$host_arch/$daemon_arch" in aarch64/aarch64|aarch64/arm64|arm64/aarch64|arm64/arm64) ;; *) echo "Native ARM64 required: host=$host_arch daemon=$daemon_arch" >&2; exit 2 ;; esac
test "$(docker info --format '{{.OSType}}')" = linux
{
  date -u +%FT%TZ
  uname -a
  id
  lscpu
  free -m
  df -Pm /tmp
  docker version --format '{{.Server.Version}} {{.Server.Os}} {{.Server.Arch}}'
  docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
} > "$output/host-preflight.txt"
available_mib=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
available_tmp_mib=$(df -Pm /tmp | awk 'NR==2{print $4}')
docker_root=$(docker info --format '{{.DockerRootDir}}')
available_docker_mib=$(df -Pm "$docker_root" | awk 'NR==2{print $4}')
if (( available_mib < 4096 || available_tmp_mib < 6144 || available_docker_mib < 6144 )); then
  echo "Resources insufficient for isolated qualification: availableMemoryMiB=$available_mib tmpMiB=$available_tmp_mib dockerMiB=$available_docker_mib" | tee "$output/resource-stop.txt" >&2
  exit 3
fi
node_image=$(sed -n 's/^[[:space:]]*"nodeImage": "\([^"]*\)".*/\1/p' config/runtime-lock.json)
case "$node_image" in node:22.23.2-bookworm-slim@sha256:*) ;; *) echo 'Expected the reviewed fixed Node 22.23.2 OCI index.' >&2; exit 2 ;; esac
run_id=$(cat /proc/sys/kernel/random/uuid)
npm_container="smpp-arm64-npm-$run_id"
test_container="smpp-arm64-tests-$run_id"
cleanup() {
  docker rm -f "$npm_container" "$test_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# An offline import must provide the byte-exact OCI index and ARM manifest. The
# config ID is derived from that hash chain, never accepted as an arbitrary tag.
if [[ -n ${ARM64_NODE_IMPORT_DIR:-} ]]; then
  import_dir=$(cd "$ARM64_NODE_IMPORT_DIR" && pwd -P)
  case "$import_dir" in "${root%/source}"/node-import) ;; *) echo 'Import proof must be in the isolated node-import directory.' >&2; exit 2 ;; esac
  node_image=$(python3 - "$node_image" "$import_dir" "$output/node-import-proof.json" <<'PY'
import hashlib, json, pathlib, sys
locked, folder, output = sys.argv[1:]
folder = pathlib.Path(folder)
index_bytes = (folder / 'node-index.json').read_bytes()
index_digest = 'sha256:' + hashlib.sha256(index_bytes).hexdigest()
assert index_digest == locked.split('@')[1], 'LOCKED_NODE_INDEX_MISMATCH'
index = json.loads(index_bytes)
arms = [item for item in index['manifests'] if item.get('platform', {}).get('architecture') == 'arm64' and item['platform'].get('os') == 'linux']
assert len(arms) == 1, 'UNIQUE_ARM64_MANIFEST_REQUIRED'
manifest_bytes = (folder / 'node-arm-manifest.json').read_bytes()
manifest_digest = 'sha256:' + hashlib.sha256(manifest_bytes).hexdigest()
assert manifest_digest == arms[0]['digest'], 'ARM64_MANIFEST_MISMATCH'
config_digest = json.loads(manifest_bytes)['config']['digest']
assert len(config_digest) == 71 and config_digest.startswith('sha256:'), 'CONFIG_DIGEST_REQUIRED'
pathlib.Path(output).write_text(json.dumps({'lockedIndex': locked, 'armManifest': manifest_digest, 'configDigest': config_digest, 'mode': 'offline-config-identity'}, indent=2) + '\n')
print(config_digest)
PY
  )
else
  docker pull --platform linux/arm64 "$node_image" > "$output/node-pull.txt" 2>&1
fi
docker image inspect --format '{"id":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}},"repoDigests":{{json .RepoDigests}}}' "$node_image" > "$output/node-image.json"
test "$(docker image inspect --format '{{.Architecture}}' "$node_image")" = arm64
sibling="${root%/source}/sdar-mcp-provider-platform"
for required in deploy/development/server/.env.example schemas/config/runtime.bootstrap.schema.json schemas/config/runtime.observability.schema.json schemas/config/runtime.workerEvents.schema.json schemas/config/provider.ugv.schema.json packages/persistence-postgres/src/tasks.ts; do
  test -f "$sibling/$required" || { echo "Paired source fixture missing: $required" >&2; exit 2; }
done
docker run --rm --name "$npm_container" --platform linux/arm64 --cpus 2 --memory 2g --pids-limit 256 \
  --user "$(id -u):$(id -g)" --workdir /work --mount "type=bind,src=$root,dst=/work" "$node_image" \
  npm ci --include=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache > "$output/npm-ci.txt" 2>&1
docker run --rm --name "$test_container" --platform linux/arm64 --network none --cpus 2 --memory 2g --pids-limit 256 \
  --user "$(id -u):$(id -g)" --workdir /work --mount "type=bind,src=$root,dst=/work" \
  --mount "type=bind,src=$sibling,dst=/sdar-mcp-provider-platform,readonly" "$node_image" sh -eu -c '
    output=reports/remediation-20260907/arm64
    node --input-type=module -e '\''import {DatabaseSync} from "node:sqlite"; if(process.arch!=="arm64"||process.version!=="v22.23.2")throw Error("NATIVE_RUNTIME_MISMATCH"); const db=new DatabaseSync(":memory:"); const sqlite=db.prepare("SELECT sqlite_version() AS version").get().version; if(sqlite!=="3.51.3")throw Error("SQLITE_VERSION_MISMATCH"); console.log(JSON.stringify({arch:process.arch,platform:process.platform,node:process.version,sqlite}));db.close();'\'' > "$output/runtime.json"
    npm run typecheck > "$output/typecheck.txt" 2>&1
    npm run check:deployment:types > "$output/deployment-typecheck.txt" 2>&1
    npm run build > "$output/build.txt" 2>&1
    node --test --test-concurrency=2 dist/telemetry-processor/test/*.test.js dist/telemetry-collector/tests/*.test.js dist/telemetry-dashboard/query-api/test/*.test.js dist/telemetry-schema/tools/*.test.js > "$output/unit-tests.tap" 2>&1
    npm run test:deployment > "$output/deployment-tests.tap" 2>&1
    grep -qF "# Subtest: WAL has independent checkpoints" "$output/unit-tests.tap"
    grep -qF "# fail 0" "$output/unit-tests.tap"
    grep -qF "# fail 0" "$output/deployment-tests.tap"
  ' > "$output/container-test-output.txt" 2>&1
printf '%s\n' 'Native ARM64 Node/SQLite/strict build/unit gates PASS; ClickHouse qualification is a separate required gate.' | tee "$output/node-result.txt"
