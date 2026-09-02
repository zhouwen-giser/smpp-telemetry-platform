import test from "node:test";
import assert from "node:assert/strict";
import {
  convergeCurrentExecutionMission,
  currentMissionStateSql,
  currentTaskExecutionSql,
  selectCurrentMissionAuthority,
  type MissionAuthorityObservation,
} from "../src/current-authority.js";

const exact: MissionAuthorityObservation = {
  taskId: "task-1",
  externalExecutionId: "execution-1",
  observedAt: "2026-08-31T12:00:00.000Z",
  recordId: "record-a",
  relationStatus: "exact",
  deviceMissionId: "mission-7",
};

const exactRow = {
  record_id: "record-a",
  source_record_hash: "a".repeat(64),
  fact_id: "11111111-1111-5111-8111-111111111111",
  tenant_id: "qualification",
  source_deployment_id: "smpp-runtime-sync-v0.1",
  task_id: "task-1",
  external_execution_id: "execution-1",
  observed_at: "2026-08-31 12:00:00.000",
  projected_at: "2026-08-31 12:00:01.000",
  relation_status: "exact",
  device_mission_id: "mission-7",
};

const taskExecutionRow = {
  relation_id: "task-execution-1",
  relation_type: "task_execution_binding",
  source_entity_id: "task-1",
  target_entity_id: "execution-1",
  binding_source: "smpp_runtime_reconciliation_found",
  confidence_class: "authoritative",
  source_record_id: "binding-record",
  projected_at: "2026-08-31 12:00:02.000",
};

function state(
  relationStatus: "unresolved" | "conflict",
  observedAt: string,
  recordId: string,
): MissionAuthorityObservation {
  return {
    ...exact,
    observedAt,
    recordId,
    relationStatus,
    deviceMissionId: null,
  };
}

test("newer unresolved invalidates a historical exact binding without inheriting its Mission ID", () => {
  const result = selectCurrentMissionAuthority([
    exact,
    state("unresolved", "2026-08-31T12:01:00.000Z", "record-b"),
  ]);
  assert.equal(result.latestState?.relationStatus, "unresolved");
  assert.equal(result.latestState?.deviceMissionId, null);
  assert.equal(result.currentBinding, null);
});

test("newer conflict invalidates a historical exact binding", () => {
  const result = selectCurrentMissionAuthority([
    exact,
    state("conflict", "2026-08-31T12:01:00.000Z", "record-c"),
  ]);
  assert.equal(result.latestState?.relationStatus, "conflict");
  assert.equal(result.currentBinding, null);
});

test("an out-of-order older unresolved observation cannot invalidate a newer exact binding", () => {
  const result = selectCurrentMissionAuthority([
    exact,
    state("unresolved", "2026-08-31T11:59:00.000Z", "record-z"),
  ]);
  assert.equal(result.latestState?.recordId, exact.recordId);
  assert.equal(result.currentBinding?.deviceMissionId, "mission-7");
});

test("replaying an identical observation is idempotent and divergent reuse fails closed", () => {
  const replayed = selectCurrentMissionAuthority([exact, structuredClone(exact)]);
  assert.equal(replayed.currentBinding?.authorityRecordId, exact.recordId);
  assert.throws(
    () =>
      selectCurrentMissionAuthority([
        exact,
        { ...exact, deviceMissionId: "mission-8" },
      ]),
    /MISSION_AUTHORITY_REPLAY_CONFLICT/u,
  );
});

test("shared SQL selects Provider observedAt plus stable recordId and all convergence evidence", () => {
  const stateSql = currentMissionStateSql("task-1", "execution-1");
  assert.match(stateSql, /ORDER BY observed_at DESC,record_id DESC/u);
  assert.match(stateSql, /external_provider_fact FINAL/u);
  assert.match(stateSql, /source_record_hash/u);
  assert.match(stateSql, /toString\(fact_id\) AS fact_id/u);
  assert.match(stateSql, /source_deployment_id/u);
  assert.match(currentTaskExecutionSql("task-1", "execution-1"), /projected_at/u);
});

test("Mission-first converges after Task→Execution arrives using the selected evidence fact", () => {
  assert.deepEqual(convergeCurrentExecutionMission(exactRow, []), []);
  const converged = convergeCurrentExecutionMission(exactRow, [
    taskExecutionRow,
  ]);
  assert.equal(converged.length, 1);
  assert.equal(converged[0]?.source_record_id, "record-a");
  assert.deepEqual(converged[0]?.evidence_fact_ids, [exactRow.fact_id]);
  assert.equal(converged[0]?.source_entity_id, "execution-1");
  assert.equal(converged[0]?.target_entity_id, "mission-7");
  assert.equal(converged[0]?.projected_at, taskExecutionRow.projected_at);
});

test("Task→Execution-first converges when the exact Mission observation arrives", () => {
  assert.deepEqual(
    convergeCurrentExecutionMission(undefined, [taskExecutionRow]),
    [],
  );
  const converged = convergeCurrentExecutionMission(exactRow, [
    taskExecutionRow,
  ]);
  assert.equal(converged.length, 1);
  assert.equal(
    converged[0]?.relation_id,
    convergeCurrentExecutionMission(exactRow, [taskExecutionRow])[0]
      ?.relation_id,
  );
});

test("latest unresolved or conflict hides old exact authority and cannot synthesize a relation", () => {
  for (const relationStatus of ["unresolved", "conflict"] as const) {
    const latest = {
      ...exactRow,
      record_id: `${relationStatus}-record`,
      relation_status: relationStatus,
      device_mission_id: "",
    };
    assert.deepEqual(
      convergeCurrentExecutionMission(latest, [taskExecutionRow]),
      [],
    );
  }
});

test("convergence fails closed for a mismatched or non-authoritative Task→Execution relation", () => {
  assert.deepEqual(
    convergeCurrentExecutionMission(exactRow, [
      { ...taskExecutionRow, target_entity_id: "execution-other" },
    ]),
    [],
  );
  assert.deepEqual(
    convergeCurrentExecutionMission(exactRow, [
      { ...taskExecutionRow, confidence_class: "inferred" },
    ]),
    [],
  );
});
