import test from "node:test";
import assert from "node:assert/strict";
import {
  convergeCurrentExecutionMission,
  currentMissionStateSql,
  currentTaskExecutionSql,
  selectCurrentMissionAuthority,
  type MissionAuthorityObservation,
} from "../src/current-authority.js";
import { authorityScope, exactRow, taskExecutionRow } from "./query-fixtures.js";
import { scopedEntityUrn, parseEntityUrn, scopeFromRow } from "../src/scope.js";

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

test("shared SQL selects Provider observedAt plus stable recordId and all convergence evidence", () => {
  const stateSql = currentMissionStateSql("task-1", "execution-1", authorityScope);
  assert.match(stateSql, /ORDER BY observed_at DESC,record_id DESC/u);
  assert.match(stateSql, /external_provider_fact FINAL/u);
  assert.match(stateSql, /source_record_hash/u);
  assert.match(stateSql, /toString\(fact_id\) AS fact_id/u);
  assert.match(stateSql, /source_deployment_id/u);
  assert.match(currentTaskExecutionSql("task-1", "execution-1", authorityScope), /projected_at/u);
});

test("each tenant, project, environment, source and deployment boundary rejects cross-scope joins", () => {
  for (const column of ["tenant_id", "project_id", "environment", "smpp_source_id"] as const) {
    assert.deepEqual(convergeCurrentExecutionMission(exactRow, [{ ...taskExecutionRow, [column]: "other" }]), [], column);
    assert.deepEqual(convergeCurrentExecutionMission({ ...exactRow, [column]: "" }, [taskExecutionRow]), [], column);
  }
  for (const field of ["tenantId", "deploymentId"] as const) {
    const other = { ...authorityScope, [field]: "other" };
    assert.deepEqual(convergeCurrentExecutionMission(exactRow, [{ ...taskExecutionRow, source_entity_urn: scopedEntityUrn(other, "task", "task-1"), target_entity_urn: scopedEntityUrn(other, "execution", "execution-1") }]), []);
  }
  assert.deepEqual(convergeCurrentExecutionMission(exactRow, [taskExecutionRow], { ...authorityScope, projectId: "other" }), []);
});

test("URN scope, entity type, system and canonical encoding must agree with row identities", () => {
  for (const source_entity_urn of [
    taskExecutionRow.source_entity_urn.replace(":smpp:", ":sdar:"),
    taskExecutionRow.source_entity_urn.replace(":task:", ":execution:"),
    taskExecutionRow.source_entity_urn.replace("task-1", "task-2"),
    taskExecutionRow.source_entity_urn.replace("task-1", "%74ask-1"),
    taskExecutionRow.source_entity_urn + "%ZZ",
  ]) assert.deepEqual(convergeCurrentExecutionMission(exactRow, [{ ...taskExecutionRow, source_entity_urn }]), []);
  for (const field of ["source_system", "target_system"]) assert.deepEqual(convergeCurrentExecutionMission(exactRow, [{ ...taskExecutionRow, [field]: "sdar" }]), []);
  assert.deepEqual(convergeCurrentExecutionMission({ ...exactRow, entity_refs_json: "[]" }, [taskExecutionRow]), []);
  assert.deepEqual(convergeCurrentExecutionMission({ ...exactRow, entity_refs_json: exactRow.entity_refs_json.replace("task-1", "task-2") }, [taskExecutionRow]), []);
  assert.deepEqual(convergeCurrentExecutionMission(exactRow, [taskExecutionRow, taskExecutionRow]), []);
});

test("scoped SQL fixes five Mission dimensions and exact relation URNs without a nonexistent deployment column", () => {
  const missionSql = currentMissionStateSql("task-1", "execution-1", authorityScope);
  const relationSql = currentTaskExecutionSql("task-1", "execution-1", authorityScope);
  for (const [column, value] of Object.entries({ tenant_id: authorityScope.tenantId, project_id: authorityScope.projectId, environment: authorityScope.environment, smpp_source_id: authorityScope.smppSourceId })) {
    assert.ok(missionSql.includes(`${column}='${value}'`)); assert.ok(relationSql.includes(`${column}='${value}'`));
  }
  assert.ok(missionSql.includes(`source_deployment_id='${authorityScope.deploymentId}'`));
  assert.ok(!relationSql.includes("source_deployment_id"));
  assert.ok(relationSql.includes(`source_entity_urn='${taskExecutionRow.source_entity_urn}'`));
  assert.ok(relationSql.includes(`target_entity_urn='${taskExecutionRow.target_entity_urn}'`));
  assert.ok(!relationSql.includes("runtime_instance_id"));
  assert.deepEqual(scopeFromRow(exactRow), authorityScope);
  const encoded = scopedEntityUrn({ ...authorityScope, tenantId: "租户:一" }, "task", "模拟/任务:1");
  assert.equal(parseEntityUrn(encoded).entityId, "模拟/任务:1");
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
