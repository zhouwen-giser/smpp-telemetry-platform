import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WalStore } from '../wal/wal.js';
import { ClickHouseClient } from '../exporters/clickhouse.js';
import { loadProjectionTargets } from '../exporters/target-manager.js';
import { SnapshotPublisher } from '../exporters/snapshot-publisher.js';
import { GenerationCoordinator } from './generation.js';
import { loadReaderRegistry, validateReaderRegistry, type ReaderConnection } from '../../../../telemetry-dashboard/query-api/src/reader-registry.js';
import { QueryClient } from '../../../../telemetry-dashboard/query-api/src/clickhouse.js';

/** Offline only: separate WAL ownership excludes the running Processor during validation and cutover. */
export async function generationCli(args: string[], write: (value: unknown) => void = value => console.log(JSON.stringify(value))): Promise<void> {
  const [action, subject, ...rest] = args;
  if (!action || !subject || !['inspect','promote','resume','rollback','retire','gc-dry-run'].includes(action)) throw new Error('Usage: generation inspect|promote <replay-id> --target <target-id> --wal <directory> --registry <readers.json> --targets <writers.json> [--next-reader <reader.json>]; generation resume|rollback <switch-id> ...; generation retire|gc-dry-run <target-id> --generation <generation> ...');
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    if (!name || !value || !['--target','--wal','--registry','--targets','--next-reader','--generation'].includes(name) || options[name] !== undefined) throw new Error('GENERATION_CLI_ARGUMENT_INVALID');
    options[name] = value;
  }
  if (!options['--wal'] || !options['--registry'] || !options['--targets']) throw new Error('GENERATION_CLI_FILES_REQUIRED');
  if (['inspect','promote'].includes(action) && !options['--target']) throw new Error('GENERATION_CLI_TARGET_REQUIRED');
  if (['retire','gc-dry-run'].includes(action) && !options['--generation']) throw new Error('GENERATION_CLI_GENERATION_REQUIRED');
  const wal = new WalStore({ directory: options['--wal'], gcEnabled: false });
  await wal.initialize();
  try {
    const { registry, clients } = await loadReaderRegistry(options['--registry']);
    const targetId = options['--target'];
    let nextReader: ReaderConnection | undefined = targetId ? registry.readers[targetId] : undefined;
    if (options['--next-reader']) {
      if (!targetId || !['inspect','promote'].includes(action)) throw new Error('GENERATION_CLI_NEXT_READER_INVALID');
      nextReader = JSON.parse(await readFile(options['--next-reader'], 'utf8')) as ReaderConnection;
      validateReaderRegistry({ ...registry, readers: { ...registry.readers, [targetId]: nextReader } });
      clients[targetId] = new QueryClient(nextReader); await clients[targetId]!.initialize();
    }
    const targets = await loadProjectionTargets(options['--targets']);
    const coordinator = new GenerationCoordinator({ wal, offline: true,
      readerFor: id => { const client = clients[id]; if (!client) throw new Error('GENERATION_READER_NOT_CONFIGURED'); return client; },
      publishLifecycle: async lifecycle => {
        const target = targets.find(item => item.targetId === lifecycle.targetId && item.generation === lifecycle.generation);
        if (!target || !target.snapshotEnabled || target.targetType !== 'standalone_smpp_clickhouse' || !target.connection.url) throw new Error('GENERATION_WRITER_CONTRACT_REQUIRED');
        const client = new ClickHouseClient({ ...target.connection, url: target.connection.url }); await client.initialize();
        const reader = clients[lifecycle.targetId]; if (!reader) throw new Error('GENERATION_READER_NOT_CONFIGURED');
        const identitySql = "SELECT toString(uuid) AS uuid FROM system.databases WHERE name='telemetry_query'";
        const writerIdentity = JSON.parse(await client.query(identitySql + ' FORMAT JSON')) as { data: { uuid: string }[] }, readerIdentity = await reader.queryJson(identitySql);
        if (writerIdentity.data.length !== 1 || readerIdentity.data.length !== 1 || writerIdentity.data[0]!.uuid !== readerIdentity.data[0]!.uuid) throw new Error('GENERATION_WRITER_READER_DATABASE_MISMATCH');
        await client.preflightWritePermissions(['telemetry_query.snapshot_v1','telemetry_query.progress_v1']);
        const publisher = new SnapshotPublisher(wal, client, target.targetId, lifecycle.generation, target.snapshotRetentionDays ?? 7);
        await publisher.refresh(new Date().toISOString());
      },
    });
    if (action === 'inspect') write(await coordinator.inspectPromotion(subject, targetId!));
    else if (action === 'promote') {
      if (!nextReader) throw new Error('GENERATION_READER_NOT_CONFIGURED');
      const result = await coordinator.promote({ jobId: subject, targetId: targetId!, readerConnection: nextReader, registryPath: resolve(options['--registry']) });
      write({ switchId: result.switchId, status: 'committed', activeTargetId: result.registry.activeTargetId, registryRevision: result.registry.revision, restartRequired: true });
    } else if (action === 'resume' || action === 'rollback') {
      const result = action === 'resume' ? await coordinator.resume(subject) : await coordinator.rollback(subject); write({ switchId: result.switchId, status: 'committed', activeTargetId: result.registry.activeTargetId, registryRevision: result.registry.revision, restartRequired: true });
    } else if (action === 'retire') write(await coordinator.retire(subject, options['--generation']!));
    else write(coordinator.gcDryRun(subject, options['--generation']!));
  } finally { await wal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) generationCli(process.argv.slice(2)).catch((error: unknown) => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'GENERATION_ADMIN_FAILED' })); process.exitCode = 1; });
