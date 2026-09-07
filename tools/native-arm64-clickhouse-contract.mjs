import assert from 'node:assert/strict';

/** @typedef {{mode:'release'|'reuse-25.3.10.19'|'reuse-25.3.14.1',expectedVersion:string,releaseQualification:boolean}} ClickHouseContract */
/** @param {string|undefined} mode @returns {ClickHouseContract} */
export function selectContract(mode) {
  if (mode === undefined || mode === 'release') return {mode:'release',expectedVersion:'25.3.14.14',releaseQualification:true};
  if (mode === 'reuse-25.3.10.19') return {mode,expectedVersion:'25.3.10.19',releaseQualification:false};
  if (mode === 'reuse-25.3.14.1') return {mode,expectedVersion:'25.3.14.1',releaseQualification:false};
  throw Error('UNAUTHORIZED_CLICKHOUSE_QUALIFICATION_MODE');
}

/** @param {{Architecture:string,Os:string,Config?:{Labels?:Record<string,string>}}} info @param {ClickHouseContract} contract */
export function validateImageIdentity(info,contract) {
  assert.equal(info.Architecture,'arm64');assert.equal(info.Os,'linux');
  if (contract.releaseQualification) {
    assert.equal(info.Config?.Labels?.['org.opencontainers.image.revision'],'84d6b30ad528e77d787ab7a2437406c1e2a5887a');
    assert.equal(info.Config?.Labels?.['io.smpp-telemetry.clickhouse.arm-profile'],'armv8+crc');
  }
}

/** @param {string} versionOutput @param {Record<string,string>} options @param {ClickHouseContract} contract */
export function validateBinaryIdentity(versionOutput,options,contract) {
  const version = /^ClickHouse (?:local|server) version (\d+\.\d+\.\d+\.\d+)(?: \(official build\))?\.$/.exec(versionOutput.trim())?.[1];
  assert.equal(version,contract.expectedVersion,'BINARY_VERSION_MISMATCH');
  assert.equal(options.VERSION_FULL,`ClickHouse ${contract.expectedVersion}`);
  assert.equal(options.VERSION_DESCRIBE,`v${contract.expectedVersion}-lts`);
  assert.match(options.VERSION_GITHASH??'',/^[0-9a-f]{40}$/,'BINARY_SOURCE_HASH_REQUIRED');
  if (contract.releaseQualification) assert.equal(options.VERSION_GITHASH,'84d6b30ad528e77d787ab7a2437406c1e2a5887a');
}
