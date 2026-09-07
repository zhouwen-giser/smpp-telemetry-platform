import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ReplayManager } from "./replay.js";
import type { WalStore, TargetRegistration } from "../wal/wal.js";
import { generationKey, type GenerationLifecycle } from "../exporters/generation-lifecycle.js";
import { outputPlanKey, type OutputPlan } from "../exporters/output-plan.js";
import { createPagination } from "../../../../telemetry-dashboard/query-api/src/pagination.js";
import { probeQueryStore } from "../../../../telemetry-dashboard/query-api/src/readiness.js";
import { sqlString, type DiagnosticStore } from "../../../../telemetry-dashboard/query-api/src/clickhouse.js";
import { validateReaderRegistry, type ReaderConnection, type ReaderRegistry } from "../../../../telemetry-dashboard/query-api/src/reader-registry.js";

interface GenerationTargetContract { targetId: string; generation: string; targetType: string; endpointHash: string; routeIds: string[]; acceptAllMappings: boolean; writeLayers: string[] }
interface ReplayContract { manifestHash: string; targets: GenerationTargetContract[]; liveTargets: GenerationTargetContract[]; targetIdentities: { targetId: string; databaseUuids: string[] }[] }
interface PromotionEvidence { jobId: string; targetId: string; generation: string; walEpoch: string; manifestHash: string; throughSequence: number; publishedRevisionCount: string }
interface SwitchIntent { id: string; status: "prepared" | "committed"; registryPath: string; previousRegistryHash: string; nextRegistry: ReaderRegistry; lifecycles: GenerationLifecycle[]; evidence: PromotionEvidence; createdAt: string }
export interface GenerationAdminOptions {
  wal: WalStore;
  /** The caller must own the offline WAL lock; the CLI opens a separate WalStore and fails if Processor is running. */
  offline: true;
  readerFor(targetId: string): DiagnosticStore;
  publishLifecycle(lifecycle: GenerationLifecycle): Promise<void>;
  now?: () => number;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const metadataTime = (value: unknown): number => typeof value === "string" ? Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z") : NaN;

export async function atomicReaderRegistry(path: string, registry: ReaderRegistry, expectedHash: string): Promise<void> {
  const current = await readFile(path, "utf8");
  if (digest(current) !== expectedHash) throw new Error("GENERATION_REGISTRY_CHANGED");
  const next = JSON.stringify(validateReaderRegistry(registry), null, 2) + "\n";
  const temporary = join(dirname(path), ".reader-registry-" + randomUUID() + ".tmp");
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
  try {
    if (digest(await readFile(path, "utf8")) !== expectedHash) throw new Error("GENERATION_REGISTRY_CHANGED");
    await rename(temporary, path);
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch((error: unknown) => { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }); }
}

/** Offline generation cutover: validate, persist recovery intent, drain the old reader, atomically replace one registry. */
export class GenerationCoordinator {
  readonly wal: WalStore;
  readonly now: () => number;
  constructor(readonly options: GenerationAdminOptions) {
    if (options.offline !== true) throw new Error("OFFLINE_GENERATION_ADMIN_REQUIRED");
    this.wal = options.wal; this.now = options.now ?? Date.now;
  }
  async inspectPromotion(jobId: string, targetId: string): Promise<PromotionEvidence> {
    const replay = new ReplayManager(this.wal), job = replay.get(jobId);
    if (!job || job.status !== "completed") throw new Error("GENERATION_REPLAY_NOT_COMPLETED");
    const request = job.plan.request;
    if (!request.targetIds.includes(targetId) || request.fromSequence !== 1 || request.throughSequence !== this.wal.state.lastSequence() || Object.keys(request.scope ?? {}).length || job.processed !== job.plan.scanned || job.plan.selected !== job.plan.scanned)
      throw new Error("GENERATION_FULL_COVERAGE_REQUIRED");
    if (job.quarantined !== 0 || job.plan.invalidInputs !== 0) throw new Error("GENERATION_UNRESOLVED_QUARANTINE");
    if (replay.plan(request).manifestHash !== job.plan.manifestHash) throw new Error("GENERATION_SOURCE_MANIFEST_CHANGED");
    const contract = this.wal.state.get<ReplayContract>("replay:contracts", jobId);
    if (contract?.manifestHash !== job.plan.manifestHash || !contract.targets.some((target) => target.targetId === targetId && target.generation === request.generation)) throw new Error("GENERATION_TARGET_CONTRACT_REQUIRED");
    const key = generationKey(targetId, request.generation, this.wal.walEpoch);
    if (this.wal.state.scan("outbox:snapshot", { prefix: key + "/", limit: 1 }).length || this.wal.pendingCount(`target:${targetId}`) !== 0) throw new Error("GENERATION_PUBLICATION_PENDING");
    const progress = this.wal.state.get<{ ingestThrough: number; publishedRevisionCount: number; legacyCoverage: number }>("snapshot:progress", key);
    if (!progress || progress.ingestThrough !== request.throughSequence || progress.legacyCoverage !== 0) throw new Error("GENERATION_SNAPSHOT_INCOMPLETE");
    for (let after = 0; after < request.throughSequence;) {
      const entries = this.wal.readEntries(after, 200, request.throughSequence);
      if (!entries.length) throw new Error("GENERATION_SOURCE_MANIFEST_CHANGED");
      for (const entry of entries) {
        const planKey = outputPlanKey(targetId, request.generation, entry), plan = this.wal.state.get<OutputPlan>("plan", planKey);
        if (!plan || plan.completedOutputs !== plan.outputs.length || this.wal.state.get("snapshot:done", planKey) !== true) throw new Error("GENERATION_OUTPUT_EVIDENCE_REQUIRED");
        const disposition = this.wal.state.get("disposition", planKey);
        if (!["projected", "not-routed"].includes(String(disposition))) throw new Error("GENERATION_OUTPUT_EVIDENCE_REQUIRED");
        after = entry.ingestSequence;
      }
    }
    const reader = this.options.readerFor(targetId);
    const databaseIdentity = contract.targetIdentities.find((target) => target.targetId === targetId)?.databaseUuids;
    const identities = await reader.queryJson("SELECT toString(uuid) AS uuid FROM system.databases WHERE name IN ('telemetry_landing','telemetry_normalized','telemetry_core','telemetry_meta')");
    if (!databaseIdentity || databaseIdentity.length !== 4 || JSON.stringify([...databaseIdentity].sort()) !== JSON.stringify(identities.data.map(row => row.uuid).sort())) throw new Error("GENERATION_READER_DATABASE_MISMATCH");
    const readiness = await probeQueryStore(reader, "snapshots", 10000);
    if (readiness.status !== "ready") throw new Error("GENERATION_READER_NOT_READY");
    const snapshot = await createPagination({ client: reader, snapshotEnabled: true, snapshotTargetId: targetId, now: this.now })(new URL("http://query/api/v1/events?consistency=snapshot&limit=1"));
    const boundary = snapshot?.snapshot as Record<string, unknown> | undefined;
    if (boundary?.generation !== request.generation || boundary.walEpoch !== this.wal.walEpoch || boundary.ingestThrough !== String(request.throughSequence) || boundary.publishedRevisionCount !== String(progress.publishedRevisionCount)) throw new Error("GENERATION_READER_BOUNDARY_MISMATCH");
    return { jobId, targetId, generation: request.generation, walEpoch: this.wal.walEpoch, manifestHash: job.plan.manifestHash, throughSequence: request.throughSequence, publishedRevisionCount: String(progress.publishedRevisionCount) };
  }
  private async currentMetadata(targetId: string): Promise<Record<string, unknown>> {
    const rows = await this.options.readerFor(targetId).queryJson(`SELECT * FROM telemetry_query.snapshot_v1 FINAL WHERE target_id=${sqlString(targetId)} AND lifecycle_status IN ('active','draining') ORDER BY snapshot_version DESC LIMIT 2`);
    if (rows.data.length !== 1 || typeof rows.data[0]?.generation !== "string" || rows.data[0].wal_epoch !== this.wal.walEpoch || !Number.isFinite(metadataTime(rows.data[0].readable_until))) throw new Error("GENERATION_OLD_READER_IDENTITY_INVALID");
    return rows.data[0]!;
  }
  async promote({ jobId, targetId, readerConnection, registryPath }: { jobId: string; targetId: string; readerConnection: ReaderConnection; registryPath: string }): Promise<{ switchId: string; registry: ReaderRegistry }> {
    const evidence = await this.inspectPromotion(jobId, targetId);
    const previousText = await readFile(registryPath, "utf8"), registry = validateReaderRegistry(JSON.parse(previousText));
    if (registry.activeTargetId === targetId) throw new Error("GENERATION_ALREADY_ACTIVE");
    const contract = this.wal.state.get<ReplayContract>("replay:contracts", jobId)!;
    const oldContract = contract.liveTargets.find(target => target.targetId === registry.activeTargetId), nextContract = contract.targets.find(target => target.targetId === targetId);
    if (!oldContract || !nextContract || oldContract.targetType !== nextContract.targetType || !oldContract.writeLayers.every(layer => nextContract.writeLayers.includes(layer)) || !(nextContract.acceptAllMappings || (!oldContract.acceptAllMappings && oldContract.routeIds.every(route => nextContract.routeIds.includes(route))))) throw new Error("GENERATION_TARGET_COVERAGE_MISMATCH");
    const oldMetadata = await this.currentMetadata(registry.activeTargetId);
    if (oldMetadata.generation !== oldContract.generation) throw new Error("GENERATION_OLD_READER_IDENTITY_INVALID");
    const oldKey = generationKey(registry.activeTargetId, String(oldMetadata.generation), this.wal.walEpoch), newKey = generationKey(targetId, evidence.generation, this.wal.walEpoch);
    const oldState = this.wal.state.get<GenerationLifecycle>("generation:lifecycle", oldKey), newState = this.wal.state.get<GenerationLifecycle>("generation:lifecycle", newKey);
    if (oldState?.status === "retired" || (newState && newState.status !== "active")) throw new Error("GENERATION_RETIRED");
    if (this.wal.state.scan("outbox:snapshot", { prefix: oldKey + "/", limit: 1 }).length) throw new Error("GENERATION_OLD_PUBLICATION_PENDING");
    const now = this.now(), timestamp = new Date(now).toISOString();
    const oldLifecycle: GenerationLifecycle = { targetId: registry.activeTargetId, generation: String(oldMetadata.generation), walEpoch: this.wal.walEpoch, status: "draining", readableUntil: new Date(Math.max(now + 600000, metadataTime(oldMetadata.readable_until), Date.parse(oldState?.readableUntil ?? timestamp))).toISOString(), updatedAt: timestamp };
    const newLifecycle: GenerationLifecycle = { targetId, generation: evidence.generation, walEpoch: this.wal.walEpoch, status: "active", readableUntil: new Date(now + 600000).toISOString(), updatedAt: timestamp, replayJobId: jobId };
    const nextRegistry = validateReaderRegistry({ ...registry, revision: registry.revision + 1, activeTargetId: targetId, readers: { ...registry.readers, [targetId]: readerConnection } });
    const id = digest(`${this.wal.walEpoch}/${jobId}/${targetId}/${registry.revision}`);
    const intent: SwitchIntent = { id, status: "prepared", registryPath, previousRegistryHash: digest(previousText), nextRegistry, lifecycles: [oldLifecycle, newLifecycle], evidence, createdAt: timestamp };
    if (this.wal.state.lastSequence() !== evidence.throughSequence) throw new Error("GENERATION_SOURCE_ADVANCED");
    await this.wal.state.transaction([
      { type: "check", namespace: "generation:lifecycle", key: oldKey, expected: oldState ?? null }, { type: "check", namespace: "generation:lifecycle", key: newKey, expected: newState ?? null },
      { type: "check", namespace: "generation:switch", key: id, expected: null },
      { type: "put", namespace: "generation:lifecycle", key: oldKey, value: oldLifecycle }, { type: "put", namespace: "generation:lifecycle", key: newKey, value: newLifecycle }, { type: "put", namespace: "generation:switch", key: id, value: intent },
    ]);
    return this.resume(id);
  }
  async resume(id: string): Promise<{ switchId: string; registry: ReaderRegistry }> {
    const intent = this.wal.state.get<SwitchIntent>("generation:switch", id);
    if (!intent) throw new Error("GENERATION_SWITCH_NOT_FOUND");
    if (intent.status === "committed") return { switchId: id, registry: intent.nextRegistry };
    const current = await readFile(intent.registryPath, "utf8"), nextText = JSON.stringify(intent.nextRegistry, null, 2) + "\n";
    if (digest(current) !== digest(nextText)) {
      if (digest(current) !== intent.previousRegistryHash) throw new Error("GENERATION_REGISTRY_CHANGED");
      for (const lifecycle of intent.lifecycles) await this.options.publishLifecycle(lifecycle);
      await atomicReaderRegistry(intent.registryPath, intent.nextRegistry, intent.previousRegistryHash);
    }
    await this.wal.state.transaction([{ type: "check", namespace: "generation:switch", key: id, expected: intent }, { type: "put", namespace: "generation:switch", key: id, value: { ...intent, status: "committed" } }]);
    return { switchId: id, registry: intent.nextRegistry };
  }
  async rollback(switchId: string): Promise<{ switchId: string; registry: ReaderRegistry }> {
    const forward = this.wal.state.get<SwitchIntent>("generation:switch", switchId);
    if (!forward || forward.status !== "committed") throw new Error("GENERATION_SWITCH_NOT_COMMITTED");
    const registryText = await readFile(forward.registryPath, "utf8"), registry = validateReaderRegistry(JSON.parse(registryText));
    if (registry.activeTargetId !== forward.nextRegistry.activeTargetId || registry.revision !== forward.nextRegistry.revision) throw new Error("GENERATION_ROLLBACK_REGISTRY_CHANGED");
    const from = forward.lifecycles.find(value => value.status === "active")!, to = forward.lifecycles.find(value => value.status === "draining")!;
    const through = this.wal.state.lastSequence(), states: GenerationLifecycle[] = [];
    for (const identity of [from, to]) {
      const key = generationKey(identity.targetId, identity.generation, this.wal.walEpoch), state = this.wal.state.get<GenerationLifecycle>("generation:lifecycle", key);
      if (!state || state.status === "retired") throw new Error("GENERATION_ROLLBACK_RETIRED");
      if (state.status !== identity.status) throw new Error("GENERATION_ROLLBACK_LIFECYCLE_CHANGED");
      const progress = this.wal.state.get<{ ingestThrough: number; legacyCoverage: number; publishedRevisionCount: number }>("snapshot:progress", key);
      if (!progress || progress.legacyCoverage !== 0 || progress.ingestThrough !== through || this.wal.checkpointSequence(`target:${identity.targetId}`) !== through || this.wal.state.scan("outbox:snapshot", { prefix: key + "/", limit: 1 }).length) throw new Error("GENERATION_ROLLBACK_INPUT_BARRIER");
      const reader = this.options.readerFor(identity.targetId), ready = await probeQueryStore(reader, "snapshots", 10000);
      if (ready.status !== "ready") throw new Error("GENERATION_READER_NOT_READY");
      const inspected = await createPagination({ client: reader, snapshotEnabled: true, snapshotTargetId: identity.targetId, initialSnapshotStatus: state.status, progressMaxAgeMs: 600000, now: this.now })(new URL("http://query/api/v1/events?consistency=snapshot&limit=1"));
      const snapshot = inspected?.snapshot as Record<string, unknown> | undefined;
      if (snapshot?.generation !== identity.generation || snapshot.walEpoch !== this.wal.walEpoch || snapshot.ingestThrough !== String(through) || snapshot.publishedRevisionCount !== String(progress.publishedRevisionCount)) throw new Error("GENERATION_READER_BOUNDARY_MISMATCH");
      states.push(state);
    }
    const now = this.now(), updatedAt = new Date(now).toISOString();
    const lifecycles = states.map(value => ({ ...value, status: value.targetId === to.targetId ? "active" as const : "draining" as const, readableUntil: new Date(Math.max(now + 600000, Date.parse(value.readableUntil))).toISOString(), updatedAt }));
    const nextRegistry = validateReaderRegistry({ ...registry, revision: registry.revision + 1, activeTargetId: to.targetId });
    const id = digest(`rollback/${switchId}/${registry.revision}`), intent: SwitchIntent = { id, status: "prepared", registryPath: forward.registryPath, previousRegistryHash: digest(registryText), nextRegistry, lifecycles,
      evidence: { ...forward.evidence, targetId: to.targetId, generation: to.generation, throughSequence: through, publishedRevisionCount: String(this.wal.state.get<{publishedRevisionCount:number}>("snapshot:progress", generationKey(to.targetId, to.generation, this.wal.walEpoch))!.publishedRevisionCount) }, createdAt: updatedAt };
    if (this.wal.state.lastSequence() !== through) throw new Error("GENERATION_SOURCE_ADVANCED");
    await this.wal.state.transaction([
      ...states.map(value => ({ type: "check" as const, namespace: "generation:lifecycle", key: generationKey(value.targetId, value.generation, this.wal.walEpoch), expected: value })),
      { type: "check", namespace: "generation:switch", key: id, expected: null },
      ...lifecycles.map(value => ({ type: "put" as const, namespace: "generation:lifecycle", key: generationKey(value.targetId, value.generation, this.wal.walEpoch), value })),
      { type: "put", namespace: "generation:switch", key: id, value: intent },
    ]);
    return this.resume(id);
  }
  async retire(targetId: string, generation: string): Promise<GenerationLifecycle> {
    const key = generationKey(targetId, generation, this.wal.walEpoch), current = this.wal.state.get<GenerationLifecycle>("generation:lifecycle", key);
    if (!current || current.status === "active") throw new Error("GENERATION_NOT_DRAINING");
    if (!Number.isFinite(Date.parse(current.readableUntil)) || Date.parse(current.readableUntil) > this.now()) throw new Error("GENERATION_READ_LEASE_ACTIVE");
    if (this.wal.state.scan("outbox:snapshot", { prefix: key + "/", limit: 1 }).length) throw new Error("GENERATION_PUBLICATION_PENDING");
    const targetIdKey = `target:${targetId}`, registration = this.wal.state.get<TargetRegistration>("target", targetIdKey);
    if (registration && registration.generation !== generation) throw new Error("GENERATION_WAL_TARGET_MISMATCH");
    const retired: GenerationLifecycle = { ...current, status: "retired", updatedAt: new Date(this.now()).toISOString() };
    await this.wal.state.transaction([{ type: "check", namespace: "generation:lifecycle", key, expected: current }, { type: "put", namespace: "generation:lifecycle", key, value: retired }]);
    // The replaced WAL consumer must also retire, otherwise future inputs pin source segments forever.
    if (registration && registration.status !== "retired") {
      await this.wal.retireTarget(targetIdKey, `Generation ${generation} retired after its read lease expired`);
    }
    await this.options.publishLifecycle(retired); return retired;
  }
  gcDryRun(targetId: string, generation: string): { eligible: boolean; reason: string; statements: string[] } {
    const key = generationKey(targetId, generation, this.wal.walEpoch), state = this.wal.state.get<GenerationLifecycle>("generation:lifecycle", key);
    if (!state || state.status !== "retired") return { eligible: false, reason: "GENERATION_NOT_RETIRED", statements: [] };
    if (!Number.isFinite(Date.parse(state.readableUntil)) || Date.parse(state.readableUntil) > this.now()) return { eligible: false, reason: "GENERATION_READ_LEASE_ACTIVE", statements: [] };
    if (this.wal.state.scan("outbox:snapshot", { prefix: key + "/", limit: 1 }).length) return { eligible: false, reason: "GENERATION_PUBLICATION_PENDING", statements: [] };
    const where = `target_id=${sqlString(targetId)} AND generation=${sqlString(generation)} AND wal_epoch=${sqlString(this.wal.walEpoch)}`;
    return { eligible: true, reason: "RETIRED_AND_READ_LEASE_EXPIRED", statements: ["output_revision_v1", "publication_v1", "progress_v1", "snapshot_v1"].map((table) => `ALTER TABLE telemetry_query.${table} DELETE WHERE ${where}`) };
  }
}
