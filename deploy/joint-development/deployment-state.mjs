import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(id);
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export const registryPath = (envPath) => resolve(dirname(resolve(envPath)), '.joint-state');
const descriptorPath = (registry, id) => resolve(registry, id, 'deployment.json');
function readDescriptor(path) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  if (d.version !== 1 || !validId(d.deploymentId) || !validId(d.project) || !isAbsolute(d.composePath) || !isAbsolute(d.envPath)) throw Error('DEPLOYMENT_DESCRIPTOR_INVALID');
  return d;
}
export function saveDeployment(registry, descriptor) {
  if (!validId(descriptor.deploymentId) || !validId(descriptor.project)) throw Error('DEPLOYMENT_ID_INVALID');
  atomicJson(descriptorPath(registry, descriptor.deploymentId), { version: 1, ...descriptor, updatedAt: new Date().toISOString() });
  // Index is a cache. Recovery scans descriptors, so a crash between the two commits is safe.
  const index = {};
  for (const entry of readdirSync(registry, { withFileTypes: true })) {
    const path = descriptorPath(registry, entry.name);
    if (entry.isDirectory() && existsSync(path)) {
      const d = readDescriptor(path);
      (index[d.envPath] ??= []).push(d.deploymentId);
    }
  }
  atomicJson(resolve(registry, 'env-index.json'), { version: 1, deploymentsByEnvPath: index });
}
/** @param {{registry:string,envPath:string,deploymentId?:string}} options */
export function resolveDeployment({ registry, envPath, deploymentId }) {
  if (deploymentId && !validId(deploymentId)) throw Error('DEPLOYMENT_ID_INVALID');
  const descriptors = existsSync(registry) ? readdirSync(registry, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
    const path = descriptorPath(registry, e.name);
    return existsSync(path) ? [readDescriptor(path)] : [];
  }) : [];
  const candidates = descriptors.filter(d => deploymentId ? d.deploymentId === deploymentId : d.envPath === resolve(envPath));
  if (candidates.length > 1) throw Error('DEPLOYMENT_AMBIGUOUS: use --deployment <id>');
  if (candidates.length === 1) return candidates[0];
  // Legacy releases had only <project>/compose.json. Adopt only one explicit candidate.
  const legacy = existsSync(registry) ? readdirSync(registry, { withFileTypes: true }).filter(e => e.isDirectory() && (!deploymentId || e.name === deploymentId)).flatMap(e => {
    const composePath = resolve(registry, e.name, 'compose.json');
    if (!existsSync(composePath) || existsSync(descriptorPath(registry, e.name))) return [];
    const compose = JSON.parse(readFileSync(composePath, 'utf8'));
    if (!validId(compose.name) || compose.name !== e.name) return [];
    return [{ version: 1, deploymentId: e.name, project: compose.name, envPath: resolve(envPath), composePath, configRevision: createHash('sha256').update(readFileSync(composePath)).digest('hex'), phase: 'legacy', lastSuccessfulRevision: null }];
  }) : [];
  if (legacy.length > 1) throw Error('DEPLOYMENT_AMBIGUOUS: use --deployment <id>');
  if (!legacy.length) throw Error('NO_GENERATED_DEPLOYMENT');
  saveDeployment(registry, legacy[0]);
  return legacy[0];
}
export function operationalArgs(descriptor, action) {
  if (!['status', 'logs', 'down'].includes(action)) throw Error('OPERATION_INVALID');
  return ['compose', '--env-file', '/dev/null', '-p', descriptor.project, '-f', descriptor.composePath, ...(action === 'status' ? ['ps'] : action === 'logs' ? ['logs', '--tail', '100'] : ['down'])];
}
