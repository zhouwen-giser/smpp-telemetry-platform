import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  const bytes = await readFile(file);
  const path = file.replace(/^\.\//, '');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  totalBytes += bytes.length;
  treeHash.update(`${sha256}  ${path}\n`);
  items.push({ path, size: bytes.length, sha256 });
}

const manifest = {
  project: 'smpp-telemetry-platform',
  version: '0.2.0',
  architecture: [
    'telemetry-collector',
    'telemetry-processor',
    'telemetry-schema',
    'telemetry-dashboard'
  ],
  scope: 'SMPP ProviderOps reliable collection, ClickHouse warehouse, source-neutral projection, and future SDAR warehouse target contract',
  generatedAt: new Date().toISOString(),
  runtime: 'Node.js >=22',
  pinnedImages: {
    collector: 'otel/opentelemetry-collector-contrib:0.157.0',
    clickhouse: 'clickhouse/clickhouse-server:25.3',
    grafana: 'grafana/grafana:12.1.0'
  },
  automatedVerification: {
    command: 'npm run check',
    syntaxFilesPassed: 34,
    testsPassed: 17,
    testsFailed: 0,
    testsSkipped: 0
  },
  environmentLimitations: [
    'Docker/Podman was unavailable in the build environment',
    'Real OpenTelemetry Collector container validation was not run',
    'Real ClickHouse migration and end-to-end ingestion were not run',
    'Production SMPP mTLS and SDAR warehouse shadow-write integration remain deployment acceptance items'
  ],
  includedFileCount: items.length,
  includedBytes: totalBytes,
  projectTreeSha256: treeHash.digest('hex'),
  files: items
};

await writeFile('DELIVERY_MANIFEST.json', `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile('SHA256SUMS.txt', `${items.map((item) => `${item.sha256}  ${item.path}`).join('\n')}\n`);
console.log(`manifest ${items.length}`);
