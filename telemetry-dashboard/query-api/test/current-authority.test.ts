import test from "node:test";
import assert from "node:assert/strict";
import {
  currentExecutionMissionSql,
  currentMissionStateSql,
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

test("shared SQL uses Provider observedAt plus recordId and joins only the selected exact record", () => {
  const stateSql = currentMissionStateSql("task-1", "execution-1");
  assert.match(stateSql, /ORDER BY observed_at DESC,record_id DESC/u);
  assert.match(stateSql, /external_provider_fact FINAL/u);
  assert.equal(
    currentExecutionMissionSql({
      relation_status: "unresolved",
      record_id: "unresolved-record",
      external_execution_id: "execution-1",
      device_mission_id: "",
    }),
    null,
  );
  const relationSql = currentExecutionMissionSql({
    relation_status: "exact",
    record_id: "exact-record",
    external_execution_id: "execution-1",
    device_mission_id: "mission-7",
  });
  assert.match(relationSql ?? "", /source_record_id='exact-record'/u);
  assert.match(relationSql ?? "", /target_entity_id='mission-7'/u);
});
