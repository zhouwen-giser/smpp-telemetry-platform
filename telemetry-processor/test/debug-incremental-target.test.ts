import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalStore } from "../src/packages/wal/wal.js";
import { SourceMappings } from "../src/packages/source-mapping/source-mapping.js";
import { TargetManager } from "../src/packages/exporters/target-manager.js";
import { SDAR_TARGET_SCHEMAS } from "../src/packages/projection/sdar-shared-warehouse-projection.js";
import { Metrics } from "../src/packages/metrics/metrics.js";
import { envelope, mapping } from "./helpers.js";

class RecordedTarget {
  rows: Array<[string, Record<string, unknown>[]]> = [];
  async initialize(): Promise<void> {}
  async ping(): Promise<void> {}
  async query(sql: string): Promise<string> {
    if (sql.includes("v_schema_contract_release_current"))
      return JSON.stringify({
        data: [
          {
            release_version: "1.5.1-rc.2",
            migration_range: "00..26",
            schema_contract_hash:
              "sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8",
            release_descriptor_hash:
              "sha256:1610cf2a4cc9450193dd70abf7a516f0ea4792099ed0f34dcf2fad44d094b335",
          },
        ],
      });
    if (sql.includes("system.columns"))
      return JSON.stringify({
        data: Object.entries(SDAR_TARGET_SCHEMAS).flatMap(([target, columns]) =>
          columns.map(([name, type]) => ({ target, name, type })),
        ),
      });
    assert.match(sql, /^SELECT \* FROM sdar_core\.v_\w+ LIMIT 0$/u);
    return JSON.stringify({ data: [] });
  }
  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    this.rows.push([table, rows]);
  }
}

test("new shared route consumes only new mapping snapshots and retains both checkpoints across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "smpp-debug-incremental-"));
  try {
    let wal = new WalStore({ directory: join(root, "wal") });
    await wal.initialize();
    const old = envelope(),
      fresh = envelope({ recordId: "cc784831-5ae6-45a0-b40a-2d6bdb4ca371" });
    await wal.append({
      kind: "accepted",
      sourceSystem: "smpp",
      receivedAt: "2026-08-26T01:00:00Z",
      trustedContext: { deploymentId: "debug", collectorId: "collector" },
      mapping,
      envelope: old,
    });
    const mappingsFile = join(root, "mappings.json");
    await writeFile(
      mappingsFile,
      JSON.stringify({
        version: 4,
        mappings: [
          {
            ...mapping,
            collectorId: "collector",
            trustDomain: "debug",
            deploymentId: "debug",
            providerId: fresh.providerId,
            instanceId: fresh.instanceId,
            status: "active",
            validFrom: "2026-01-01T00:00:00Z",
            policyVersion: 2,
            projectionRouteIds: ["standalone-smpp", "sdar-warehouse-shadow"],
          },
        ],
      }),
    );
    const mappings = new SourceMappings(mappingsFile);
    await mappings.load();
    const current = mappings.resolve({
      collectorId: "collector",
      trustDomain: "debug",
      deploymentId: "debug",
      providerId: fresh.providerId,
      instanceId: fresh.instanceId,
    });
    assert.ok(current);
    assert.equal(current.policyVersion, 2);
    assert.equal(current.mappingVersion, 4);
    await wal.append({
      kind: "accepted",
      sourceSystem: "smpp",
      receivedAt: "2026-08-26T02:00:00Z",
      trustedContext: { deploymentId: "debug", collectorId: "collector" },
      mapping: current,
      envelope: fresh,
    });
    const local = new RecordedTarget(),
      shared = new RecordedTarget();
    const targets = [
      {
        targetId: "standalone-smpp",
        targetType: "standalone",
        enabled: true,
        required: true,
        acceptAllMappings: false,
        writeLayers: ["landing"],
        connection: {},
      },
      {
        targetId: "sdar-warehouse-shadow",
        targetType: "sdar_shared_warehouse",
        enabled: true,
        required: false,
        acceptAllMappings: false,
        writeLayers: ["core", "relation"],
        connection: {},
        tableMap: {},
      },
    ];
    const managerFor = (store: WalStore) => {
      const manager = new TargetManager({
        targets,
        wal: store,
        metrics: new Metrics(),
        clientFactory: (target: { targetId: string }) =>
          target.targetId === "standalone-smpp" ? local : shared,
      });
      return manager;
    };
    let manager = managerFor(wal);
    await manager.initialize();
    await manager.flush();
    assert.equal(local.rows.flatMap(([, rows]) => rows).length, 2);
    assert.ok(shared.rows.length > 0);
    assert.ok(JSON.stringify(shared.rows).includes(fresh.recordId));
    assert.ok(!JSON.stringify(shared.rows).includes(old.recordId));
    const checkpoint = wal.stats().checkpoints;
    const size = [local.rows.length, shared.rows.length];
    wal = new WalStore({ directory: join(root, "wal") });
    await wal.initialize();
    assert.deepEqual(wal.stats().checkpoints, checkpoint);
    assert.deepEqual(wal.entries[0].record.mapping.projectionRouteIds, [
      "standalone-smpp",
    ]);
    manager = managerFor(wal);
    await manager.initialize();
    await manager.flush();
    assert.deepEqual([local.rows.length, shared.rows.length], size);
    assert.ok(
      manager
        .statuses()
        .every((status: { pending: number }) => status.pending === 0),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
