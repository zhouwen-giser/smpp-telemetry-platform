// The same injected behavior is used in tests and inside each real service container.
export async function preflightWriters({ loadConfig, loadProjectionTargets, createClient, assertShared, assertStandalone, standaloneTargetTables }) {
  const config = await loadConfig();
  const targets = (await loadProjectionTargets(config.projectionTargetsFile)).filter(t => t.enabled);
  if (!targets.length) throw Error('NO_ENABLED_WRITER_TARGETS');
  for (const target of targets) {
    const client = createClient(target.connection);
    await client.initialize();
    let tables;
    if (target.targetType === 'sdar_shared_warehouse') {
      await assertShared(client);
      tables = [
        ...(target.writeLayers.includes('core') ? ['sdar_core.external_provider_fact'] : []),
        ...(target.writeLayers.includes('relation') ? ['sdar_core.external_entity_relation_fact'] : []),
      ];
    } else if (target.targetType === 'standalone_smpp_clickhouse') {
      await assertStandalone(client, target);
      tables = standaloneTargetTables(target);
    } else throw Error('WRITER_TARGET_TYPE_INVALID');
    for (const table of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw Error('WRITER_TABLE_INVALID');
      if ((await client.query(`CHECK GRANT INSERT ON ${table}`)).trim() !== '1') throw Error(`WRITER_INSERT_DENIED:${target.targetId}`);
    }
  }
}
export async function preflightReaders({ env, createClient, probeQueryStore }) {
  const options = prefix => ({ url: env[`${prefix}_URL`], user: env[`${prefix}_USER`] ?? 'default', password: env[`${prefix}_PASSWORD`] ?? '', passwordFile: env[`${prefix}_PASSWORD_FILE`] ?? '' });
  const standalone = createClient(options('CLICKHOUSE'));
  await standalone.initialize();
  const stores = [[standalone, 'standalone']];
  if (['true','1'].includes(env.QUERY_SNAPSHOTS_ENABLED)) stores.push([standalone, 'snapshots']);
  const authorityEnabled = env.AUTHORITY_ENABLED === undefined ? Boolean(env.AUTHORITY_CLICKHOUSE_URL) : ['true', '1'].includes(env.AUTHORITY_ENABLED);
  if (authorityEnabled) {
    const authority = env.AUTHORITY_CLICKHOUSE_URL ? createClient(options('AUTHORITY_CLICKHOUSE')) : standalone;
    if (authority !== standalone) await authority.initialize();
    stores.push([authority, 'authority']);
  }
  for (const [store, kind] of stores) {
    const result = await probeQueryStore(store, kind, Number(env.QUERY_READINESS_TIMEOUT_MS ?? 2000));
    if (result.status !== 'ready') throw Error(`READER_${kind.toUpperCase()}_UNAVAILABLE`);
  }
}
export const writerProgram = `
import {loadConfig} from './dist/telemetry-processor/src/packages/config/config.js';
import {loadProjectionTargets} from './dist/telemetry-processor/src/packages/exporters/target-manager.js';
import {ClickHouseClient} from './dist/telemetry-processor/src/packages/exporters/clickhouse.js';
import {SdarWarehouseSchemaPreflight} from './dist/telemetry-processor/src/packages/projection/sdar-shared-warehouse-projection.js';
import {StandaloneSchemaPreflight,standaloneTargetTables} from './dist/telemetry-processor/src/packages/exporters/standalone-schema.js';
try { await (${preflightWriters.toString()})({loadConfig,loadProjectionTargets,createClient:c=>new ClickHouseClient(c),assertShared:c=>new SdarWarehouseSchemaPreflight().assert(c),assertStandalone:(c,t)=>new StandaloneSchemaPreflight().assert(c,t),standaloneTargetTables}); console.log('WRITER_PREFLIGHT_PASS'); } catch { console.error('WRITER_PREFLIGHT_FAILED: actual Processor target endpoint, schema or INSERT grants'); process.exit(1); }
`;
export const readerProgram = `
import {QueryClient} from './dist/telemetry-dashboard/query-api/src/clickhouse.js';
import {probeQueryStore} from './dist/telemetry-dashboard/query-api/src/readiness.js';
try { await (${preflightReaders.toString()})({env:process.env,createClient:c=>new QueryClient(c),probeQueryStore});console.log('READER_PREFLIGHT_PASS'); } catch {console.error('READER_PREFLIGHT_FAILED: actual Query endpoint, schema or SELECT grants');process.exit(1);}
`;
