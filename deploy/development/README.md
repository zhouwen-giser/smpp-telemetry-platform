# x86_64 development stack

The release path in `compose.yaml` deliberately builds ClickHouse from the pinned
source revision for ARM64. On an x86_64 joint-integration host, layer this
development-only override on top of the root file:

```bash
cp .env.example .env
```

Set the exact joint-integration identities in `.env`. The active SMPP development
Compose project currently publishes its Runtime endpoint on the host, so the
Telemetry Collector must scrape that published port through the host gateway:

```env
TELEMETRY_PUBLIC_HOST=host.docker.internal
SMPP_SERVICES='ugv-runtime|http://host.docker.internal:19100'
SMPP_METRICS_TARGET=host.docker.internal:19100
SMPP_DEPLOYMENT_ID=ugv-test-deployment
COLLECTOR_ID=smpp-ugv-joint-collector-1
TRUST_DOMAIN=local-development
SMPP_PROVIDER_ID=isr.vehicle.ugv.ugv1
SMPP_RUNTIME_INSTANCE_ID=ugv-runtime-test-1
SMPP_SOURCE_ID=smpp.ugv-test-deployment.ugv-runtime-test-1
TELEMETRY_TENANT_ID=tenant-local
TELEMETRY_PROJECT_ID=ugv-joint-integration
TELEMETRY_ENVIRONMENT=development
TELEMETRY_TRANSPORT_MODE=development
```

Replace the Runtime port if the SMPP Compose project publishes a different one.
The Runtime instance value must be identical to `RUNTIME_INSTANCE_ID` and
`OTEL_SERVICE_INSTANCE_ID`. Generate the mapping and
ensure the two local secret files exist before starting the stack:

```bash
mkdir -p secrets
test -s secrets/clickhouse_password.txt || openssl rand -hex -out secrets/clickhouse_password.txt 24
test -s secrets/processor_admin_key.txt || openssl rand -hex -out secrets/processor_admin_key.txt 24
node deploy/bin/generate-config.ts "$PWD" "$PWD/.env"

docker compose \
  --env-file .env \
  -f compose.yaml \
  -f deploy/development/compose.x86_64.override.yaml \
  config --quiet

docker compose \
  --env-file .env \
  -f compose.yaml \
  -f deploy/development/compose.x86_64.override.yaml \
  up -d --build --remove-orphans --wait --wait-timeout 180
```

This profile replaces only the ClickHouse build with the matching official
`25.3.14.14` Linux/amd64 image. Processor, Collector, migrations, Query API,
Grafana, volumes, ports, and health checks continue to come from `compose.yaml`.
It also gives the Collector a Linux host-gateway mapping so it can scrape a
Runtime published by the separate SMPP Compose project. The SMPP Runtime must in
turn resolve `host.docker.internal` and export OTLP to
`http://host.docker.internal:4318`; that host mapping belongs in the SMPP
development Compose project.

This is development-only. Do not use this override for ARM64 release
qualification; the root Compose and ARM64 source-build path remain unchanged.
