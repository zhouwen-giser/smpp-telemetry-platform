import { readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

async function walk(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['var', 'node_modules', '.git'].includes(entry.name)) continue;
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath));
    else if (!['DELIVERY_MANIFEST.json', 'SHA256SUMS.txt'].includes(entry.name)) output.push(fullPath);
  }
  return output;
}

const files = (await walk('.')).sort();
const items = [];
let totalBytes = 0;
const treeHash = createHash('sha256');

for (const file of files) {
  const path = file.replace(/^\.\//, '');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const size = (await stat(file)).size;
  totalBytes += size;
  treeHash.update(`${sha256}  ${path}\n`);
  items.push({ path, size, sha256 });
}

const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? '');
const generatedAt = Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0
  ? new Date(sourceDateEpoch * 1000).toISOString()
  : new Date().toISOString();

const manifest = {
  project: 'smpp-telemetry-platform',
  version: '0.3.0',
  packageVariant: 'linux-arm64-source-built-clickhouse',
  sourceCommit: process.env.PACKAGE_SOURCE_COMMIT ?? 'working-tree',
  architecture: [
    'telemetry-collector',
    'telemetry-processor',
    'telemetry-schema',
    'telemetry-dashboard',
    'clickhouse-arm64-source-build'
  ],
  scope: 'SMPP ProviderOps reliable collection, ClickHouse warehouse, source-neutral projection, and future SDAR warehouse target contract',
  generatedAt,
  runtime: 'Node.js >=22',
  pinnedImages: {
    collector: 'otel/opentelemetry-collector-contrib:0.157.0',
    clickhouse: 'locally-built:smpp-telemetry-clickhouse:25.3.14.14-arm64v8-source',
    grafana: 'grafana/grafana:12.1.0'
  },
  clickhouseSourceBuild: {
    repository: 'https://github.com/ClickHouse/ClickHouse.git',
    ref: 'v25.3.14.14-lts',
    commit: '84d6b30ad528e77d787ab7a2437406c1e2a5887a',
    target: 'linux/arm64',
    compatibilityProfile: 'NO_ARMV81_OR_HIGHER=ON (-march=armv8+crc)',
    precompiledClickHouseBinaryIncluded: false,
    completeSourceArchiveIncluded: true,
    targetHostGitHubAccessRequired: false
  },
  automatedVerification: {
    sourceRegressionCommand: 'pnpm test',
    composeValidationCommand: 'docker compose config --quiet',
    targetHostBinaryGate: 'docker compose run --rm --no-deps --entrypoint clickhouse clickhouse --version',
    packageIntegrityCommand: 'sha256sum -c SHA256SUMS.txt'
  },
  environmentLimitations: [
    'The ClickHouse ARM64 image is intentionally built on the target ARM64 host and is not embedded in this ZIP',
    'The verified complete ClickHouse source tree is embedded; target host source builds do not access GitHub',
    'Target host must expose the ARM crc32 feature and provide sufficient build memory, swap, disk, and Debian repository access',
    'Production SMPP mTLS and SDAR warehouse shadow-write integration remain deployment acceptance items'
  ],
  includedFileCount: items.length,
  includedBytes: totalBytes,
  projectTreeSha256: treeHash.digest('hex'),
  files: items
};

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await writeFile('DELIVERY_MANIFEST.json', manifestBytes);
const checksums = [
  ...items,
  {
    path: 'DELIVERY_MANIFEST.json',
    size: manifestBytes.length,
    sha256: createHash('sha256').update(manifestBytes).digest('hex')
  }
].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
await writeFile('SHA256SUMS.txt', `${checksums.map((item) => `${item.sha256}  ${item.path}`).join('\n')}\n`);
console.log(`manifest ${items.length}; checksums ${checksums.length}`);
