import test from 'node:test';
import assert from 'node:assert/strict';
import {selectContract,validateImageIdentity,validateBinaryIdentity} from './native-arm64-clickhouse-contract.mjs';

const originalCommit='84d6b30ad528e77d787ab7a2437406c1e2a5887a';
const options=(version,commit=originalCommit)=>({VERSION_FULL:`ClickHouse ${version}`,VERSION_DESCRIBE:`v${version}-lts`,VERSION_GITHASH:commit});
test('default release keeps fixed version, source identity and ARM profile gates',()=>{
  const contract=selectContract(undefined);
  assert.equal(contract.releaseQualification,true);
  assert.throws(()=>validateImageIdentity({Architecture:'arm64',Os:'linux'},contract));
  validateImageIdentity({Architecture:'arm64',Os:'linux',Config:{Labels:{'org.opencontainers.image.revision':originalCommit,'io.smpp-telemetry.clickhouse.arm-profile':'armv8+crc'}}},contract);
  validateBinaryIdentity('ClickHouse local version 25.3.14.14.',options('25.3.14.14'),contract);
  assert.throws(()=>validateBinaryIdentity('ClickHouse local version 25.3.14.14.',options('25.3.14.14','1'.repeat(40)),contract));
});
test('explicit reuse validates the authorized native binary without inventing source labels',()=>{
  for (const version of ['25.3.10.19','25.3.14.1']) {
    const contract=selectContract(`reuse-${version}`);
    assert.equal(contract.releaseQualification,false);
    validateImageIdentity({Architecture:'arm64',Os:'linux'},contract);
    validateBinaryIdentity(`ClickHouse local version ${version} (official build).`,options(version,'1'.repeat(40)),contract);
  }
});
test('reuse rejects emulation, wrong binary versions and absent compiled source identity',()=>{
  const contract=selectContract('reuse-25.3.10.19');
  assert.throws(()=>validateImageIdentity({Architecture:'amd64',Os:'linux'},contract));
  assert.throws(()=>validateBinaryIdentity('ClickHouse local version 25.3.14.14.',options('25.3.14.14'),contract));
  assert.throws(()=>validateBinaryIdentity('ClickHouse local version 25.3.10.19.',options('25.3.10.19',''),contract));
});
test('an existing image tag or unapproved version cannot silently select reuse mode',()=>{
  assert.throws(()=>selectContract('reuse-25.3.11.1'));
  assert.throws(()=>selectContract('clickhouse/clickhouse-server:25.3.10.19'));
  assert.throws(()=>validateBinaryIdentity('ClickHouse local version 25.3.10.19.',options('25.3.10.19'),selectContract(undefined)));
});
