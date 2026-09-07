/** Uses the existing, contract-verified isolated shared schema without changing DDL. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createQueryServer } from "../src/server.js";
import { QueryStoreError, sqlString, type DiagnosticStore } from "../src/clickhouse.js";
import { scopedEntityUrn, type AuthorityScope } from "../src/scope.js";
import { probeQueryStore } from "../src/readiness.js";
const sharedContainer = process.argv[2], localContainer = process.argv[3];
if (!sharedContainer || !localContainer || ![sharedContainer, localContainer].every((value) => /^[A-Za-z0-9_-]+$/u.test(value))) throw new Error("Pass isolated shared and standalone ClickHouse containers");
const fixture = "query_scope_qa_" + randomBytes(8).toString("hex"), user = fixture + "_reader", password = randomBytes(32).toString("hex");
async function command(sql: string, input = "", role: "admin" | "reader" | "local" = "admin"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", role === "local" ? localContainer! : sharedContainer!, "clickhouse-client", "--date_time_input_format=best_effort", ...(role === "reader" ? ["--user", user, "--password", password] : role === "admin" ? ["--password", "e1-isolated-only"] : []), "--query", sql]);
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { error += chunk; });
    child.once("error", reject); child.stdin.once("error", reject); child.once("close", (code) => code === 0 ? resolve(output) : reject(error.includes("Code: 497") ? new QueryStoreError("ACCESS_DENIED") : new Error(`ClickHouse ${code}: ${error}`))); child.stdin.end(input);
  });
}
async function insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  await command(`INSERT INTO ${table} FORMAT JSONEachRow`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const sourceTime = Date.now() - 60000;
const taskId = fixture + "_task", executionId = fixture + "_execution";
const base: AuthorityScope = { tenantId: fixture + "_tenant", projectId: "simulation-project", environment: "simulation", smppSourceId: fixture + "_source", deploymentId: "simulation-deployment" };
const scopes = [base, ...Object.keys(base).map((key) => ({ ...base, [key]: base[key as keyof AuthorityScope] + "-other" }))];
function mission(scope: AuthorityScope, task: string, execution: string, missionId: string, at = sourceTime): Record<string, unknown> {
  const time = new Date(at).toISOString();
  return { tenant_id: scope.tenantId, project_id: scope.projectId, environment: scope.environment, smpp_source_id: scope.smppSourceId, source_deployment_id: scope.deploymentId, source_runtime_instance_id: "simulation-runtime", fact_id: randomUUID(), fact_hash: "b".repeat(64), fact_type: "provider.execution.progress", fact_version: "1.0", source_system: "smpp", source_product: "simulation-qualification", source_record_id: randomUUID(), source_record_hash: "a".repeat(64), source_schema_name: "sdar.provider.ops.event", source_schema_version: "1.1.0", external_task_id: task, external_execution_id: execution, entity_refs_json: JSON.stringify([{ entityType: "task", localId: task, urn: scopedEntityUrn(scope, "task", task) }, { entityType: "execution", localId: execution, urn: scopedEntityUrn(scope, "execution", execution) }]), payload_json: JSON.stringify({ payload: { relationStatus: "exact", deviceMissionId: missionId } }), provenance_json: "{}", occurred_at: time, observed_at: time, received_at: time, normalized_at: time, projected_at: time, normalizer_id: "qualification", normalizer_version: 1, mapping_version: 4, policy_version: 1, projection_id: fixture, projection_version: 1 };
}
function relation(scope: AuthorityScope, task: string, execution: string, at = sourceTime): Record<string, unknown> {
  const time = new Date(at).toISOString();
  return { tenant_id: scope.tenantId, project_id: scope.projectId, environment: scope.environment, smpp_source_id: scope.smppSourceId, relation_id: randomUUID(), relation_type: "task_execution_binding", relation_version: 1, source_entity_urn: scopedEntityUrn(scope, "task", task), source_entity_type: "task", source_entity_id: task, target_entity_urn: scopedEntityUrn(scope, "execution", execution), target_entity_type: "execution", target_entity_id: execution, source_system: "smpp", target_system: "smpp", valid_from: time, valid_to: null, causation_fact_id: null, attempt_no: null, binding_source: "smpp_runtime_reconciliation_found", confidence_class: "authoritative", source_record_id: randomUUID(), source_record_hash: "c".repeat(64), created_at: time, projected_at: time, projection_id: fixture, projection_version: 1 };
}
let userCreated = false;
const mainRelations = scopes.map((scope) => relation(scope, taskId, executionId));
try {
  await insert("sdar_core.external_provider_fact", scopes.map((scope, index) => mission(scope, taskId, executionId, "mission-" + index)));
  await insert("sdar_core.external_entity_relation_fact", [...mainRelations, mainRelations[0]!]);
  await insert("sdar_core.external_entity_relation_fact", [
    { ...relation(base, taskId, executionId, sourceTime + 1000), source_entity_urn: scopedEntityUrn({ ...base, tenantId: "wrong-tenant" }, "task", taskId) },
    { ...relation(base, taskId, executionId, sourceTime + 2000), target_entity_urn: scopedEntityUrn({ ...base, deploymentId: "wrong-deployment" }, "execution", executionId) },
    { ...relation(base, taskId, executionId, sourceTime + 3000), source_system: "sdar" },
  ]);
  await command(`CREATE USER ${user} IDENTIFIED WITH plaintext_password BY '${password}'`); userCreated = true;
  for (const table of ["system.columns", "sdar_core.external_provider_fact", "sdar_core.external_entity_relation_fact"]) await command(`GRANT SELECT ON ${table} TO ${user}`);
  assert.equal((await command("CHECK GRANT INSERT ON sdar_core.external_provider_fact", "", "reader")).trim(), "0");
  const authority: DiagnosticStore = { queryJson: async (sql) => JSON.parse(await command(sql + " FORMAT JSON", "", "reader")) as { data: Record<string, unknown>[] } };
  const local: DiagnosticStore = { queryJson: async (sql) => JSON.parse(await command(sql + " FORMAT JSON", "", "local")) as { data: Record<string, unknown>[] } };
  assert.equal((await probeQueryStore(authority, "authority", 10000)).status, "ready");
  const server = createQueryServer({ client: local, authorityClient: authority, authorityEnabled: true, readinessTimeoutMs: 10000, readinessCacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string"); const endpoint = `http://127.0.0.1:${address.port}`;
    const path = `/api/v1/tasks/${taskId}/current-authority?externalExecutionId=${executionId}`;
    for (const [index, scope] of scopes.entries()) {
      const response = await fetch(endpoint + path + "&" + new URLSearchParams({ ...scope })), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body)); assert.deepEqual(body.resolvedScope, scope); assert.equal(body.currentTaskExecutionCount, 1); assert.equal(body.currentExecutionMissionCount, 1); assert.equal(body.executionMission[0].target_entity_id, "mission-" + index);
    }
    let response = await fetch(endpoint + path); assert.equal(response.status, 409); assert.equal((await response.json()).error, "AUTHORITY_SCOPE_AMBIGUOUS");
    const uniqueTask = taskId + "_unique", uniqueExecution = executionId + "_unique";
    await insert("sdar_core.external_provider_fact", [mission(base, uniqueTask, uniqueExecution, "unique-mission")]);
    await insert("sdar_core.external_entity_relation_fact", [relation(base, uniqueTask, uniqueExecution)]);
    response = await fetch(`${endpoint}/api/v1/tasks/${uniqueTask}/current-authority?externalExecutionId=${uniqueExecution}`);
    assert.equal(response.status, 200); assert.equal((await response.json()).currentExecutionMissionCount, 1);
    const relationOnlyTask = taskId + "_relation_only", relationOnlyExecution = executionId + "_relation_only";
    await insert("sdar_core.external_entity_relation_fact", [relation(base, relationOnlyTask, relationOnlyExecution)]);
    response = await fetch(`${endpoint}/api/v1/tasks/${relationOnlyTask}/current-authority?externalExecutionId=${relationOnlyExecution}`);
    const relationOnly = await response.json(); assert.equal(response.status, 200, JSON.stringify(relationOnly)); assert.equal(relationOnly.currentTaskExecutionCount, 1); assert.equal(relationOnly.currentExecutionMissionCount, 0);
    // A newer malformed identity cannot inherit the older valid exact binding.
    await insert("sdar_core.external_provider_fact", [{ ...mission(base, uniqueTask, uniqueExecution, "wrong-mission", sourceTime + 4000), entity_refs_json: JSON.stringify([{ entityType: "task", localId: uniqueTask, urn: scopedEntityUrn({ ...base, tenantId: "wrong-tenant" }, "task", uniqueTask) }]) }]);
    response = await fetch(`${endpoint}/api/v1/tasks/${uniqueTask}/current-authority?externalExecutionId=${uniqueExecution}`); assert.equal((await response.json()).currentExecutionMissionCount, 0);
    const unresolved = mission(base, uniqueTask, uniqueExecution, "unused", sourceTime + 5000); unresolved.payload_json = JSON.stringify({ payload: { relationStatus: "unresolved" } });
    await insert("sdar_core.external_provider_fact", [unresolved]);
    response = await fetch(`${endpoint}/api/v1/tasks/${uniqueTask}/current-authority?externalExecutionId=${uniqueExecution}`);
    const masked = await response.json(); assert.equal(masked.currentTaskExecutionCount, 1); assert.equal(masked.currentExecutionMissionCount, 0); assert.equal(masked.missionAuthorityState.relation_status, "unresolved");
    response = await fetch(endpoint + "/health/ready"); assert.equal(response.status, 200, JSON.stringify(await response.json()));
    await command(`REVOKE SELECT ON sdar_core.external_provider_fact FROM ${user}`);
    response = await fetch(endpoint + "/health/ready"); assert.equal(response.status, 503, JSON.stringify(await response.json()));
    assert.equal((await fetch(endpoint + "/health/live")).status, 200);
    await command(`GRANT SELECT ON sdar_core.external_provider_fact TO ${user}`);
    assert.equal((await fetch(endpoint + "/health/ready")).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log(JSON.stringify({ status: "PASS", fixture, scopeCount: scopes.length, cases: ["actual locked shared schema", "five independent scope dimensions", "same task and execution ids", "duplicate relation retry", "forged source/tenant/deployment URNs excluded", "legacy ambiguous 409", "legacy unique scope convergence", "Task→Execution-only discovery", "malformed latest evidence fails closed", "latest unresolved masks old exact", "shared SELECT-only reader", "shared permission revoke => dual-store ready 503", "live 200 and restore ready 200"] }));
} finally {
  if (userCreated) await command(`DROP USER IF EXISTS ${user}`);
  for (const table of ["sdar_core.external_provider_fact", "sdar_core.external_entity_relation_fact"]) await command(`ALTER TABLE ${table} DELETE WHERE projection_id=${sqlString(fixture)} SETTINGS mutations_sync=2`);
}
