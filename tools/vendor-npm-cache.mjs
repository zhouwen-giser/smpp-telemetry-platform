#!/usr/bin/env node

import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CACHE_FORMAT = Object.freeze({ content: "content-v2", index: "index-v5" });
const EXPECTED_EXTERNAL_PACKAGES = 3;
const NPM_CONSUMER_VERSION = "10.9.8";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const NODE_IMAGE = "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const DOCKERFILES = Object.freeze([
  "telemetry-processor/Dockerfile",
  "telemetry-dashboard/query-api/Dockerfile",
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function digest(algorithm, value, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    assert(option.startsWith("--"), `unexpected argument: ${option}`);
    if (option === "--self-test") {
      options.selfTest = true;
      continue;
    }
    const value = rest[index + 1];
    assert(value && !value.startsWith("--"), `missing value for ${option}`);
    const name = option.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert(options[name] === undefined, `duplicate option: ${option}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function requirePath(options, name) {
  const value = options[name];
  const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  assert(typeof value === "string" && value.length > 0, `--${flag} is required`);
  return resolve(value);
}

function relativeCachePath(...segments) {
  return ["_cacache", ...segments].join("/");
}

function contentDescriptor(integrity) {
  assert(typeof integrity === "string" && integrity.startsWith("sha512-"), `unsupported integrity: ${integrity}`);
  const encoded = integrity.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  assert(bytes.length === 64 && bytes.toString("base64") === encoded, `non-canonical sha512 integrity: ${integrity}`);
  const sha512Hex = bytes.toString("hex");
  return {
    sha512Hex,
    relativePath: relativeCachePath(
      CACHE_FORMAT.content,
      "sha512",
      sha512Hex.slice(0, 2),
      sha512Hex.slice(2, 4),
      sha512Hex.slice(4),
    ),
  };
}

function indexDescriptor(resolved) {
  const key = `make-fetch-happen:request-cache:${resolved}`;
  const keySha256 = digest("sha256", key);
  return {
    key,
    relativePath: relativeCachePath(
      CACHE_FORMAT.index,
      keySha256.slice(0, 2),
      keySha256.slice(2, 4),
      keySha256.slice(4),
    ),
  };
}

function safeJoin(root, relativePath) {
  assert(!isAbsolute(relativePath), `cache path must be relative: ${relativePath}`);
  const target = resolve(root, relativePath);
  assert(target === root || target.startsWith(`${root}${sep}`), `cache path escapes root: ${relativePath}`);
  return target;
}

function packageIdentity(name, version) {
  return `${name}@${version}`;
}

function splitPnpmIdentity(pnpmKey) {
  const separator = pnpmKey.lastIndexOf("@");
  assert(separator > 0 && separator < pnpmKey.length - 1, `invalid pnpm package identity: ${pnpmKey}`);
  return { name: pnpmKey.slice(0, separator), version: pnpmKey.slice(separator + 1) };
}

async function loadPnpmLock(pnpmLockPath) {
  const raw = await readFile(pnpmLockPath);
  const lines = raw.toString("utf8").split("\n");
  assert(lines.some((line) => line === "lockfileVersion: '9.0'"), "pnpm-lock.yaml must use lockfileVersion 9.0");

  let inPackages = false;
  let current;
  const packages = [];
  const finishCurrent = () => {
    if (!current) return;
    assert(current.integrity, `pnpm package integrity is missing: ${current.pnpmKey}`);
    const identity = splitPnpmIdentity(current.pnpmKey);
    packages.push({ ...identity, ...current });
  };

  for (const line of lines) {
    if (line === "packages:") {
      assert(!inPackages, "pnpm-lock.yaml contains duplicate packages sections");
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line === "snapshots:") {
      finishCurrent();
      current = undefined;
      inPackages = false;
      break;
    }
    const header = /^  (?:'([^']+)'|([^:]+)):$/.exec(line);
    if (header) {
      finishCurrent();
      current = { pnpmKey: header[1] ?? header[2] };
      continue;
    }
    if (current) {
      const integrity = /integrity:\s*(sha512-[A-Za-z0-9+/=]+)/.exec(line);
      if (integrity) current.integrity = integrity[1];
    }
  }

  assert(!inPackages, "pnpm-lock.yaml snapshots section is missing");
  packages.sort((left, right) => packageIdentity(left.name, left.version).localeCompare(packageIdentity(right.name, right.version)));
  assert(packages.length === EXPECTED_EXTERNAL_PACKAGES, `pnpm external closure must contain exactly ${EXPECTED_EXTERNAL_PACKAGES} packages`);
  assert(new Set(packages.map(({ name, version }) => packageIdentity(name, version))).size === packages.length, "pnpm lock contains duplicate package identities");
  return { raw, packages };
}

async function loadNpmLock(npmLockPath) {
  const raw = await readFile(npmLockPath);
  const lock = JSON.parse(raw.toString("utf8"));
  assert(lock.lockfileVersion === 3, "package-lock.json must use lockfileVersion 3");
  assert(lock.packages && typeof lock.packages === "object", "package-lock.json packages graph is missing");

  const packages = Object.entries(lock.packages)
    .filter(([lockPath, entry]) => lockPath.startsWith("node_modules/") && !entry.link)
    .map(([lockPath, entry]) => {
      const name = lockPath.split("node_modules/").at(-1);
      assert(name && typeof entry.version === "string", `locked package identity is incomplete: ${lockPath}`);
      assert(typeof entry.resolved === "string" && typeof entry.integrity === "string", `locked resolution is incomplete: ${lockPath}`);
      const resolved = new URL(entry.resolved);
      assert(resolved.origin === REGISTRY_ORIGIN && resolved.protocol === "https:", `locked package must use exact HTTPS npm registry origin: ${entry.resolved}`);
      assert(!resolved.username && !resolved.password && !resolved.search && !resolved.hash, `locked package URL must not contain credentials, query, or fragment: ${entry.resolved}`);
      const content = contentDescriptor(entry.integrity);
      const index = indexDescriptor(entry.resolved);
      return {
        lockPath,
        name,
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        licenseObservation: typeof entry.license === "string" ? entry.license : "UNDECLARED",
        contentPath: content.relativePath,
        sha512: content.sha512Hex,
        indexPath: index.relativePath,
        indexKey: index.key,
      };
    })
    .sort((left, right) => packageIdentity(left.name, left.version).localeCompare(packageIdentity(right.name, right.version)));

  assert(packages.length === EXPECTED_EXTERNAL_PACKAGES, `npm external closure must contain exactly ${EXPECTED_EXTERNAL_PACKAGES} packages`);
  assert(new Set(packages.map(({ contentPath }) => contentPath)).size === packages.length, "package lock contains duplicate content objects");
  assert(new Set(packages.map(({ indexPath }) => indexPath)).size === packages.length, "package lock contains duplicate request-cache keys");
  return { raw, packages };
}

async function loadEquivalentLocks(npmLockPath, pnpmLockPath) {
  const npm = await loadNpmLock(npmLockPath);
  const pnpm = await loadPnpmLock(pnpmLockPath);
  const npmClosure = npm.packages.map(({ name, version, integrity }) => ({ name, version, integrity }));
  const pnpmClosure = pnpm.packages.map(({ name, version, integrity }) => ({ name, version, integrity }));
  assert(JSON.stringify(npmClosure) === JSON.stringify(pnpmClosure), "npm and pnpm external package versions/integrities differ");
  return { npm, pnpm };
}

function parseIndexRecords(raw, sourcePath) {
  const records = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    assert(separator > 0, `malformed cacache index record: ${sourcePath}`);
    const recordHash = line.slice(0, separator);
    const serialized = line.slice(separator + 1);
    assert(recordHash === digest("sha1", serialized), `cacache index record hash mismatch: ${sourcePath}`);
    records.push(JSON.parse(serialized));
  }
  return records;
}

function canonicalIndexBytes(packageEntry, size) {
  const entry = {
    key: packageEntry.indexKey,
    integrity: packageEntry.integrity,
    time: 1,
    size,
    metadata: {
      time: 1,
      url: packageEntry.resolved,
      options: { compress: true },
    },
  };
  const serialized = JSON.stringify(entry);
  return Buffer.from(`\n${digest("sha1", serialized)}\t${serialized}`);
}

async function inspectContent(path, expectedSha512) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `cache content is not a regular file: ${path}`);
  const bytes = await readFile(path);
  const actualSha512 = digest("sha512", bytes);
  assert(actualSha512 === expectedSha512, `cache content SHA-512 mismatch: ${path}`);
  return { bytes, size: bytes.length };
}

function aggregateContentSha256(packages, contentByPath) {
  const aggregate = createHash("sha256");
  for (const packageEntry of packages) {
    const content = contentByPath.get(packageEntry.contentPath);
    aggregate.update(`${packageEntry.integrity}\0${content.length}\0`);
    aggregate.update(content);
  }
  return aggregate.digest("hex");
}

function licenseSummary(packages) {
  const counts = {};
  for (const packageEntry of packages) {
    counts[packageEntry.licenseObservation] = (counts[packageEntry.licenseObservation] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildManifest(npmRaw, pnpmRaw, packages, contentByPath, indexByPath) {
  const rows = packages.map((packageEntry) => ({
    name: packageEntry.name,
    version: packageEntry.version,
    resolved: packageEntry.resolved,
    integrity: packageEntry.integrity,
    licenseObservation: packageEntry.licenseObservation,
    contentPath: packageEntry.contentPath,
    sha512: packageEntry.sha512,
    size: contentByPath.get(packageEntry.contentPath).length,
    indexPath: packageEntry.indexPath,
  }));
  const contentBytes = rows.reduce((sum, row) => sum + row.size, 0);
  const indexBytes = [...indexByPath.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  return {
    schemaVersion: 1,
    source: {
      npmLockfile: "package-lock.json",
      npmLockfileSha256: digest("sha256", npmRaw),
      pnpmLockfile: "pnpm-lock.yaml",
      pnpmLockfileSha256: digest("sha256", pnpmRaw),
      equivalencePolicy: "exact external package name, version, and SHA-512 integrity",
      registryOrigin: REGISTRY_ORIGIN,
    },
    cacheFormat: {
      content: CACHE_FORMAT.content,
      index: CACHE_FORMAT.index,
      npmConsumerVersion: NPM_CONSUMER_VERSION,
      indexMetadataPolicy: "deterministic URL and compression only; no copied host headers, credentials, tokens, logs, or wall-clock timestamps",
    },
    licenseObservationScope: "Values are package-lock metadata observations, not legal review or clearance.",
    licenseObservations: licenseSummary(packages),
    totals: {
      packages: rows.length,
      contentObjects: contentByPath.size,
      indexEntries: indexByPath.size,
      contentBytes,
      indexBytes,
      cacheBytes: contentBytes + indexBytes,
    },
    aggregateContentSha256: aggregateContentSha256(packages, contentByPath),
    packages: rows,
  };
}

async function collectTree(root) {
  const files = [];
  const directories = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      assert(!entry.isSymbolicLink(), `vendor cache must not contain symlinks: ${rel}`);
      if (entry.isDirectory()) {
        directories.push(rel);
        await visit(absolute);
      } else {
        assert(entry.isFile(), `vendor cache contains a non-regular entry: ${rel}`);
        files.push(rel);
      }
    }
  }
  await visit(root);
  return { files: files.sort(), directories: directories.sort() };
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let current = dirname(file);
    while (current !== ".") {
      directories.add(current.split(sep).join("/"));
      current = dirname(current);
    }
  }
  return [...directories].sort();
}

async function verifyCache(npmLockPath, pnpmLockPath, cacheRoot) {
  const { npm, pnpm } = await loadEquivalentLocks(npmLockPath, pnpmLockPath);
  const contentByPath = new Map();
  const indexByPath = new Map();

  for (const packageEntry of npm.packages) {
    const contentPath = safeJoin(cacheRoot, packageEntry.contentPath);
    const content = await inspectContent(contentPath, packageEntry.sha512);
    contentByPath.set(packageEntry.contentPath, content.bytes);

    const indexPath = safeJoin(cacheRoot, packageEntry.indexPath);
    const actualIndex = await readFile(indexPath);
    const expectedIndex = canonicalIndexBytes(packageEntry, content.size);
    assert(actualIndex.equals(expectedIndex), `canonical cache index mismatch: ${packageEntry.indexPath}`);
    indexByPath.set(packageEntry.indexPath, actualIndex);
  }

  const expectedManifest = buildManifest(npm.raw, pnpm.raw, npm.packages, contentByPath, indexByPath);
  const actualManifest = JSON.parse(await readFile(join(cacheRoot, "manifest.json"), "utf8"));
  assert(JSON.stringify(actualManifest) === JSON.stringify(expectedManifest), "vendor cache manifest does not exactly match both locks and cache content");

  const expectedFiles = [
    "manifest.json",
    ...npm.packages.flatMap(({ contentPath, indexPath }) => [contentPath, indexPath]),
  ].sort();
  const tree = await collectTree(cacheRoot);
  assert(JSON.stringify(tree.files) === JSON.stringify(expectedFiles), "vendor cache contains missing or extra files");
  assert(JSON.stringify(tree.directories) === JSON.stringify(expectedDirectories(expectedFiles)), "vendor cache contains missing or extra directories");
  return expectedManifest;
}

async function materialize(npmLockPath, pnpmLockPath, sourceCache, outputRoot) {
  const { npm, pnpm } = await loadEquivalentLocks(npmLockPath, pnpmLockPath);
  assert(sourceCache !== outputRoot, "source cache and output must differ");
  assert(!sourceCache.startsWith(`${outputRoot}${sep}`) && !outputRoot.startsWith(`${sourceCache}${sep}`), "source cache and output must not contain one another");

  const temporaryOutput = `${outputRoot}.tmp-${process.pid}`;
  await rm(temporaryOutput, { recursive: true, force: true });
  await mkdir(temporaryOutput, { recursive: true });
  const contentByPath = new Map();
  const indexByPath = new Map();

  try {
    for (const packageEntry of npm.packages) {
      const sourceContentPath = safeJoin(sourceCache, packageEntry.contentPath.replace(/^_cacache\//, ""));
      const content = await inspectContent(sourceContentPath, packageEntry.sha512);
      contentByPath.set(packageEntry.contentPath, content.bytes);

      const sourceIndexPath = safeJoin(sourceCache, packageEntry.indexPath.replace(/^_cacache\//, ""));
      const records = parseIndexRecords(await readFile(sourceIndexPath), sourceIndexPath);
      const matching = records.filter((record) => record.key === packageEntry.indexKey).at(-1);
      assert(matching, `source cache index key is missing: ${packageEntry.resolved}`);
      assert(matching.integrity === packageEntry.integrity, `source cache index integrity mismatch: ${packageEntry.resolved}`);
      assert(matching.size === content.size, `source cache index size mismatch: ${packageEntry.resolved}`);
      assert(matching.metadata?.url === packageEntry.resolved, `source cache index URL mismatch: ${packageEntry.resolved}`);

      const outputContentPath = safeJoin(temporaryOutput, packageEntry.contentPath);
      await mkdir(dirname(outputContentPath), { recursive: true });
      await copyFile(sourceContentPath, outputContentPath);

      const outputIndexPath = safeJoin(temporaryOutput, packageEntry.indexPath);
      const canonicalIndex = canonicalIndexBytes(packageEntry, content.size);
      await mkdir(dirname(outputIndexPath), { recursive: true });
      await writeFile(outputIndexPath, canonicalIndex);
      indexByPath.set(packageEntry.indexPath, canonicalIndex);
    }

    const manifest = buildManifest(npm.raw, pnpm.raw, npm.packages, contentByPath, indexByPath);
    await writeFile(join(temporaryOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyCache(npmLockPath, pnpmLockPath, temporaryOutput);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(temporaryOutput, outputRoot);
    return manifest;
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

async function expectVerificationFailure(npmLockPath, pnpmLockPath, cacheRoot, label, mutate) {
  const fixture = join(cacheRoot, label);
  const source = join(cacheRoot, "source");
  await cp(source, fixture, { recursive: true });
  await mutate(fixture);
  try {
    await verifyCache(npmLockPath, pnpmLockPath, fixture);
  } catch {
    return;
  }
  fail(`negative verifier fixture unexpectedly passed: ${label}`);
}

async function runNegativeSelfTests(npmLockPath, pnpmLockPath, sourceCache) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "smpp-telemetry-vendor-cache-"));
  const fixtureSource = join(temporaryRoot, "source");
  await cp(sourceCache, fixtureSource, { recursive: true });
  const manifest = JSON.parse(await readFile(join(sourceCache, "manifest.json"), "utf8"));
  const first = manifest.packages[0];
  try {
    await expectVerificationFailure(npmLockPath, pnpmLockPath, temporaryRoot, "missing-content", async (fixture) => {
      await rm(safeJoin(fixture, first.contentPath));
    });
    await expectVerificationFailure(npmLockPath, pnpmLockPath, temporaryRoot, "tampered-content", async (fixture) => {
      const path = safeJoin(fixture, first.contentPath);
      const bytes = await readFile(path);
      bytes[0] ^= 0xff;
      await writeFile(path, bytes);
    });
    await expectVerificationFailure(npmLockPath, pnpmLockPath, temporaryRoot, "extra-content", async (fixture) => {
      const path = safeJoin(fixture, relativeCachePath(CACHE_FORMAT.content, "sha512", "ff", "ff", "0".repeat(124)));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "extra");
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizedDockerfile(value) {
  return value.replace(/\\\r?\n\s*/g, " ").replace(/[ \t]+/g, " ");
}

async function verifyDockerfiles(root) {
  const values = await Promise.all(DOCKERFILES.map(async (path) => ({ path, value: await readFile(join(root, path), "utf8") })));
  const builderStages = [];
  const requiredRun = "RUN node tools/vendor-npm-cache.mjs verify --npm-lock package-lock.json --pnpm-lock pnpm-lock.yaml --cache /app/vendor/npm-cache && npm ci --offline --include=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --cache=/app/vendor/npm-cache && npm run build";

  for (const { path, value } of values) {
    const normalized = normalizedDockerfile(value);
    assert((value.match(new RegExp(`FROM ${NODE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g")) ?? []).length === 2, `${path} must retain both exact Node digest pins`);
    assert(normalized.includes("COPY package.json package-lock.json pnpm-lock.yaml tsconfig.json pnpm-workspace.yaml ./"), `${path} must copy both authoritative locks`);
    assert(normalized.includes("COPY vendor/npm-cache ./vendor/npm-cache"), `${path} must copy the product-owned npm cache`);
    assert(normalized.includes(requiredRun), `${path} must verify the closure and use the exact offline npm ci/build command`);
    assert(!/(^|[;&|]\s*)npm\s+install\b/m.test(normalized), `${path} contains executable npm install`);
    assert(!normalized.includes("--prefer-offline"), `${path} contains a mutable-network fallback`);
    assert(!normalized.includes("--mount=type=cache"), `${path} contains a mutable BuildKit cache mount`);
    const secondFrom = value.indexOf(`\nFROM ${NODE_IMAGE}`, 1);
    assert(secondFrom > 0, `${path} runtime stage is missing`);
    builderStages.push(value.slice(0, secondFrom));
  }
  assert(builderStages[0] === builderStages[1], "processor and query Dockerfile builder stages differ");
  return { dockerfiles: DOCKERFILES.length, nodeDigestPins: DOCKERFILES.length * 2 };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "verify-dockerfiles") {
    const root = requirePath(options, "root");
    const result = await verifyDockerfiles(root);
    console.log(JSON.stringify({ status: "PASS", mode: command, ...result }));
    return;
  }

  const npmLockPath = requirePath(options, "npmLock");
  const pnpmLockPath = requirePath(options, "pnpmLock");
  if (command === "materialize") {
    assert(!options.selfTest, "--self-test is only valid with verify");
    const sourceCache = requirePath(options, "sourceCache");
    const outputRoot = requirePath(options, "output");
    const manifest = await materialize(npmLockPath, pnpmLockPath, sourceCache, outputRoot);
    console.log(JSON.stringify({ status: "PASS", mode: command, ...manifest.totals, aggregateContentSha256: manifest.aggregateContentSha256 }));
    return;
  }
  if (command === "verify") {
    const cacheRoot = requirePath(options, "cache");
    const manifest = await verifyCache(npmLockPath, pnpmLockPath, cacheRoot);
    if (options.selfTest) await runNegativeSelfTests(npmLockPath, pnpmLockPath, cacheRoot);
    console.log(JSON.stringify({ status: "PASS", mode: command, negativeFixtures: options.selfTest ? 3 : 0, ...manifest.totals, aggregateContentSha256: manifest.aggregateContentSha256 }));
    return;
  }
  fail(`usage: ${basename(process.argv[1])} materialize --npm-lock <package-lock> --pnpm-lock <pnpm-lock> --source-cache <_cacache> --output <vendor-cache> | verify --npm-lock <package-lock> --pnpm-lock <pnpm-lock> --cache <vendor-cache> [--self-test] | verify-dockerfiles --root <repo>`);
}

main().catch((error) => {
  console.error(`vendor-npm-cache: FAIL: ${error.message}`);
  process.exitCode = 1;
});
