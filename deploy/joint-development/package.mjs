import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  copyFileSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { catalog, template } from "./catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url)),
  telemetry = resolve(here, "../..");
const smpp = resolve(
  process.argv[2] ?? resolve(telemetry, "../sdar-mcp-provider-platform"),
);
const output = resolve(
  process.argv[3] ?? resolve(telemetry, "artifacts/joint-development"),
);
mkdirSync(output, { recursive: true });
// npm ci is the sole Telemetry install path; a bundle without its lock is incomplete.
if (!readFileSync(resolve(telemetry, "package-lock.json"), "utf8").includes('"lockfileVersion"')) throw Error("TELEMETRY_NPM_LOCK_REQUIRED");
const stage = mkdtempSync(resolve(output, "bundle-"));
const reviewedReports = new Set([
  "reports/smpp-stable-integration/SMPP_TELEMETRY_SOURCE_CAPTURE.json",
  "reports/remediation-20260907/IMPLEMENTATION_STATUS.md",
  "reports/remediation-20260907/DEPLOYMENT_G6_G8_G9_EVIDENCE.md",
  "reports/remediation-20260907/QUERY_API_G4_G7_G10.md",
  "reports/remediation-20260907/arm64/README.md",
  "reports/remediation-20260907/simulation-chain/SUMMARY.md",
  "reports/remediation-20260907/EVIDENCE_INDEX.json",
]);
const repositories = {};
const tree = createHash("sha256");
for (const [name, root] of Object.entries({ smpp, telemetry })) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const files = [
    ...new Set(
      [...git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean), ...(name === "telemetry" ? reviewedReports : [])],
    ),
  ]
    .sort()
    .filter(
      (p) =>
        (!/(^|\/)(artifacts|reports|node_modules|dist|\.git|\.codex|\.agents|\.joint-state|state|secrets|vendor|coverage)(\/|$)/.test(
          p,
        ) || (name === "telemetry" && reviewedReports.has(p))) &&
        !/(^|\/)\.env($|\.(?!example$))/.test(p) &&
        !/\.(pem|key|token|pfx|p12|log|tar|gz|zip|db|sqlite)$/.test(p) &&
        p !== "SOURCE_REVISION",
    );
  let copiedFiles = 0;
  for (const p of files) {
    const source = resolve(root, p);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) continue; // A tracked file deleted in the current worktree stays deleted.
    if (!stat.isFile()) throw Error(`NON_REGULAR_SOURCE_FILE:${name}/${p}`);
    const bytes = readFileSync(source);
    if (
      p.endsWith(".npmrc") &&
      /(?:_authToken|_password|_auth)\s*=\s*[^$\s]/.test(bytes.toString())
    )
      throw Error("NPMRC_CREDENTIAL_REFUSED");
    const target = resolve(stage, "sources", name, p);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    tree.update(name + "/" + p + "\0").update(bytes);
    copiedFiles++;
  }
  repositories[name] = {
    revision: git(["rev-parse", "HEAD"]).trim(),
    worktreeStatus: git(["status", "--porcelain"]),
    files: copiedFiles,
  };
}
// Tests use the saved checkout name; this generated relative alias stays inside sources.
symlinkSync("smpp", resolve(stage, "sources/sdar-mcp-provider-platform"));
for (const name of [
  "deploy.sh",
  "cli.mjs",
  "catalog.mjs",
  "compose.mjs",
  "deployment-state.mjs",
  "preflight.mjs",
  "README.md",
  "ACCEPTANCE.md",
])
  copyFileSync(resolve(here, name), resolve(stage, name));
writeFileSync(resolve(stage, ".env.example"), template(catalog(smpp)));
const buildIdentity = `worktree-${tree.digest("hex").slice(0, 24)}`;
writeFileSync(
  resolve(stage, "release.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      buildIdentity,
      repositories,
      evidencePolicy: "Only the static test fixture and reviewed summary/index reports are included; full qualification evidence is supplied separately.",
      generatedAliases: { "sources/sdar-mcp-provider-platform": "smpp" },
      sourcePolicy:
        "current repositories including non-ignored working-tree changes; no previous package pin",
    },
    null,
    2,
  ),
);
const archive = resolve(
  output,
  `smpp-telemetry-development-${buildIdentity}.tar.gz`,
);
execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${archive.split("/").pop()}\n`);
console.log(JSON.stringify({ archive, sha256: digest, stage }));
