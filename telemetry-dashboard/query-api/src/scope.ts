import { encodeEntityUrn as encodeSharedUrn, parseEntityUrn as parseSharedUrn, type TelemetryEntityUrn } from "../../../packages/telemetry-types/src/urn.js";
export type { TelemetryEntityUrn } from "../../../packages/telemetry-types/src/urn.js";
import { sqlString, type DiagnosticStore } from "./clickhouse.js";

export interface AuthorityScope {
  tenantId: string;
  projectId: string;
  environment: string;
  smppSourceId: string;
  deploymentId: string;
}

export class AuthorityRequestError extends Error {
  constructor(readonly code: string, readonly statusCode: 400 | 409 = 400) {
    super(code);
  }
}

export const SCOPE_COLUMNS = {
  tenantId: "tenant_id",
  projectId: "project_id",
  environment: "environment",
  smppSourceId: "smpp_source_id",
  deploymentId: "source_deployment_id",
} as const;
const scopeKeys = Object.keys(SCOPE_COLUMNS) as (keyof AuthorityScope)[];

export function authorityIdentity(value: unknown, code = "AUTHORITY_ID_INVALID"): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new AuthorityRequestError(code);
  // Also reject lone UTF-16 surrogates, which cannot form a canonical URI.
  try { encodeURIComponent(value); } catch { throw new AuthorityRequestError(code); }
  return value;
}

export function validateAuthorityScope(value: unknown): AuthorityScope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthorityRequestError("AUTHORITY_SCOPE_INVALID");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !Object.hasOwn(SCOPE_COLUMNS, key)))
    throw new AuthorityRequestError("AUTHORITY_SCOPE_INVALID");
  return {
    tenantId: authorityIdentity(input.tenantId, "AUTHORITY_SCOPE_INVALID"),
    projectId: authorityIdentity(input.projectId, "AUTHORITY_SCOPE_INVALID"),
    environment: authorityIdentity(input.environment, "AUTHORITY_SCOPE_INVALID"),
    smppSourceId: authorityIdentity(input.smppSourceId, "AUTHORITY_SCOPE_INVALID"),
    deploymentId: authorityIdentity(input.deploymentId, "AUTHORITY_SCOPE_INVALID"),
  };
}

export function sameScope(left: AuthorityScope, right: AuthorityScope): boolean {
  return scopeKeys.every((key) => left[key] === right[key]);
}

export function scopeFromRow(row: Record<string, unknown>): AuthorityScope {
  return validateAuthorityScope(Object.fromEntries(scopeKeys.map((key) => [key, row[SCOPE_COLUMNS[key]]])));
}

export function requestedAuthorityScope(parameters: URLSearchParams, defaultScope?: AuthorityScope): AuthorityScope | undefined {
  const supplied = scopeKeys.filter((key) => parameters.has(key));
  if (supplied.length === 0) return defaultScope;
  if (supplied.length !== scopeKeys.length || supplied.some((key) => parameters.getAll(key).length !== 1))
    throw new AuthorityRequestError("AUTHORITY_SCOPE_INCOMPLETE");
  const scope = validateAuthorityScope(Object.fromEntries(scopeKeys.map((key) => [key, parameters.get(key)])));
  if (defaultScope && !sameScope(scope, defaultScope))
    throw new AuthorityRequestError("AUTHORITY_SCOPE_DEFAULT_CONFLICT");
  return scope;
}

export function scopeSql(scope: AuthorityScope, includeDeployment = true): string {
  validateAuthorityScope(scope);
  return scopeKeys.filter((key) => includeDeployment || key !== "deploymentId")
    .map((key) => `${SCOPE_COLUMNS[key]}=${sqlString(scope[key])}`).join(" AND ");
}

export function encodeEntityUrn(identity: TelemetryEntityUrn): string {
  try { return encodeSharedUrn(identity); } catch { throw new AuthorityRequestError("AUTHORITY_URN_INVALID"); }
}

export function parseEntityUrn(value: unknown): TelemetryEntityUrn {
  try { return parseSharedUrn(value); } catch { throw new AuthorityRequestError("AUTHORITY_URN_INVALID"); }
}

export function scopedEntityUrn(scope: AuthorityScope, entityType: string, entityId: string): string {
  return encodeEntityUrn({ tenantId: scope.tenantId, sourceSystem: "smpp", deploymentId: scope.deploymentId, entityType, entityId });
}

/** Legacy discovery is bounded and includes Task→Execution-only deliveries. */
export async function resolveLegacyAuthorityScope(store: DiagnosticStore, taskId: string, executionId: string): Promise<AuthorityScope | undefined> {
  authorityIdentity(taskId); authorityIdentity(executionId);
  const result = await store.queryJson(`SELECT DISTINCT * FROM (
SELECT DISTINCT tenant_id,project_id,environment,smpp_source_id,source_deployment_id,'' AS source_entity_urn,'' AS target_entity_urn FROM sdar_core.external_provider_fact FINAL WHERE source_system='smpp' AND external_task_id=${sqlString(taskId)} AND external_execution_id=${sqlString(executionId)}
UNION ALL
SELECT DISTINCT tenant_id,project_id,environment,smpp_source_id,'' AS source_deployment_id,source_entity_urn,target_entity_urn FROM sdar_core.external_entity_relation_fact FINAL WHERE relation_type='task_execution_binding' AND source_entity_id=${sqlString(taskId)} AND target_entity_id=${sqlString(executionId)} AND source_system='smpp' AND target_system='smpp' AND binding_source='smpp_runtime_reconciliation_found' AND confidence_class='authoritative'
) LIMIT 257`);
  if (result.data.length >= 257) throw new AuthorityRequestError("AUTHORITY_SCOPE_AMBIGUOUS", 409);
  const scopes: AuthorityScope[] = [];
  for (const row of result.data) {
    let scope: AuthorityScope;
    try {
      if (row.source_entity_urn !== "" && row.source_entity_urn !== undefined) {
        const source = parseEntityUrn(row.source_entity_urn), target = parseEntityUrn(row.target_entity_urn);
        scope = scopeFromRow({ ...row, source_deployment_id: target.deploymentId });
        if (row.source_entity_urn !== scopedEntityUrn(scope, "task", taskId) || row.target_entity_urn !== scopedEntityUrn(scope, "execution", executionId) || source.sourceSystem !== "smpp")
          throw new Error();
      } else scope = scopeFromRow(row);
    } catch { throw new Error("AUTHORITY_STORED_SCOPE_INVALID"); }
    if (!scopes.some((candidate) => sameScope(candidate, scope))) scopes.push(scope);
    if (scopes.length > 1) throw new AuthorityRequestError("AUTHORITY_SCOPE_AMBIGUOUS", 409);
  }
  return scopes[0];
}
