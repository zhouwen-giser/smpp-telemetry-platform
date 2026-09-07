# Runtime audit delivery acknowledgement remediation

## Verified cause

The installed `@opentelemetry/sdk-logs` 0.220.0 `SimpleLogRecordProcessor` invokes normal-resource exports with `void doExport()`. Its `forceFlush()` waits only for unresolved asynchronous resource attributes, not normal exporter callbacks. Exporter failures are sent to the SDK global error handler and do not reject that flush. Consequently `ProviderTelemetry.exportAudit()` returned successfully before HTTP delivery completed, and `DurableProviderOpsPublisher` marked those records `DELIVERED`.

The independent in-memory reproduction submitted 307 records. `forceFlush()` resolved with **zero completed exporter callbacks**. After all 307 callbacks reported failure, another `forceFlush()` still resolved. See `audit-sdk-false-ack-reproduction.json`. This reproduced the code defect without submitting any game task or changing the outbox.

The OTLP exporter in the installed dependency also has a default concurrency limit of 30 and returns `FAILED` when that limit is reached. Returning prematurely from the otherwise sequential publisher allowed exports to accumulate past that limit. This explains how exporter failures could coexist with delivery attempt count 1 and a `DELIVERED` state; the actual E1 row reconciliation is recorded separately by the integration owner.

## Changes

- `exportAudit()` still uses the official `Logger` to construct SDK records, preserving resource attributes, instrumentation scope, occurrence timestamp, and log attributes. An explicit context associates each emitted record with its own call's batch.
- A dedicated audit processor exports each batch once and resolves only after that batch's successful callback. Failed callbacks, synchronous exceptions, and missing-callback deadlines reject the call for the existing durable outbox retry path. Concurrent calls and late callbacks cannot complete each other's batch. Shutdown waits for pending audit exports and rejects new ones.
- The default audit transport uses the official JSON log request serializer with a strict HTTP acknowledgement check. Only HTTP 200 with a valid OTLP JSON response and zero rejected records succeeds. HTTP 202/503, nonzero `partialSuccess.rejectedLogRecords`, malformed or empty responses, and incomplete responses fail with fixed error codes. A zero rejection count with an error message is accepted as a protocol warning.
- The transport retains configured headers and HTTPS CA/client certificate/private key verification. Responses are bounded to 1 MiB. Failed HTTP deliveries are retried by the durable outbox; this transport does not add another internal retry loop.
- The already installed serializer `@opentelemetry/otlp-transformer` 0.220.0 is now an exact direct dependency. `pnpm add --offline --lockfile-only --ignore-scripts --workspace-root` completed without downloads; the lockfile change adds the direct importer entry only.
- The optional injected `LogRecordExporter` API remains available; an injected exporter's callback contract must truthfully report complete delivery. Production's default audit exporter performs the explicit HTTP and partial-success checks itself.

Trace and ordinary operational log transport implementations were not changed by this fix. No existing outbox rows were modified by this code task.

## Validation

`tsc --noEmit -p tsconfig.json` passed for the complete sibling repository with zero diagnostics.

Five test files passed, **37/37 tests**:

- Seven new callback/outbox cases: delayed acknowledgement with full SDK record checks, concurrent out-of-order mixed results, synchronous exceptions, deadline and late callbacks, actual durable publisher retry/delivery transitions with a controlled repository, shutdown draining, and actual HTTP rejection followed by acknowledged retry.
- Eighteen strict transport cases: complete/warning acknowledgements, partial rejection, malformed response shapes, HTTP 202/503, the default transport selection, and a real local HTTPS receiver requiring mTLS (configured client succeeds; missing credentials fails).
- Twelve existing telemetry initialization, failure isolation, and provider metrics regressions.

Logs: `audit-export-ack-tests.log`, `audit-export-ack-typecheck.log`, `audit-export-dependency.log`.

Only the two changed runtime modules were compiled for the isolated integration instance; no whole-image rebuild was needed. Exact source, JavaScript, package, and lockfile hashes and the serializer directory are in `audit-export-ack-artifact.json`.
