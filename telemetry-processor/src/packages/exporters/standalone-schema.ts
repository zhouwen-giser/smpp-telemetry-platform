import { STANDALONE_SCHEMA } from './standalone-contract.js';
export { STANDALONE_SCHEMA } from './standalone-contract.js';

export interface StandaloneTarget {
  writeLayers: readonly string[];
  snapshotEnabled?:boolean;
  tableMap?: Readonly<Record<string, string>>;
}
export interface SchemaQueryClient { query(sql: string): Promise<string> }
export function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('PROJECTION_TABLE_INVALID');
  return value;
}
function contractTables(target: StandaloneTarget): string[] {
  return Object.keys(STANDALONE_SCHEMA).filter(table => {
    if (table.startsWith('telemetry_meta.'))return table.endsWith('provider_quality_observation_v1');
    if (table.startsWith('telemetry_query.'))return target.snapshotEnabled===true;
    if (table.startsWith('telemetry_landing.')) return target.writeLayers.includes('landing');
    if (table.startsWith('telemetry_normalized.')) return target.writeLayers.includes('normalized');
    if (table.endsWith('.entity_relation_fact')) return target.writeLayers.includes('relation');
    return target.writeLayers.includes('core');
  });
}
export function standaloneTargetTables(target: StandaloneTarget): string[] {
  return contractTables(target).map(table => sqlIdentifier(target.tableMap?.[table] ?? table));
}

const normalizeType = (type: string) => type.replaceAll(/\s+/g, '');
export class StandaloneSchemaPreflight {
  async assert(client: SchemaQueryClient, target: StandaloneTarget): Promise<void> {
    for (const table of contractTables(target)) {
      const actualTable = sqlIdentifier(target.tableMap?.[table] ?? table);
      const result: unknown = JSON.parse(await client.query(`DESCRIBE TABLE ${actualTable} FORMAT JSON`));
      if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data))
        throw new Error('STANDALONE_SCHEMA_RESPONSE_INVALID');
      const columns = new Map<string, string>();
      for (const column of result.data as unknown[]) {
        if (!column || typeof column !== 'object' || !('name' in column) || !('type' in column)
          || typeof column.name !== 'string' || typeof column.type !== 'string') throw new Error('STANDALONE_SCHEMA_RESPONSE_INVALID');
        columns.set(column.name, normalizeType(column.type));
      }
      for (const [name, type] of Object.entries(STANDALONE_SCHEMA[table]!)) {
        if (columns.get(name) !== normalizeType(type)) throw new Error(`STANDALONE_SCHEMA_DRIFT:${actualTable}:${name}`);
      }
    }
  }
}
