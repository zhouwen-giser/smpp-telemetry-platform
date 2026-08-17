# Stable SMPP integration deployment

This profile keeps SMPP external and runs ClickHouse, Processor, Collector, Query API, and Grafana.
The root Compose file is the development/plaintext mode. This override is the qualification and
production transport mode: Runtime→Collector and Collector→Processor both require mutual TLS.

This ARM64 delivery builds ClickHouse 25.3.14.14 from the pinned upstream source commit with
ClickHouse's `NO_ARMV81_OR_HIGHER` compatibility profile. Run it only on a native ARM64 Docker
host exposing the `crc32` CPU feature. The first build can take hours; 32 GiB RAM and 80 GiB free
disk are recommended, or set `CLICKHOUSE_BUILD_JOBS=1` and provide swap.

The complete verified ClickHouse source tree, including recursive submodules,
is bundled as a local archive. Target-host builds do not access GitHub.

Copy `.env.example` to `.env`, set exact identities and an absolute `QUALIFICATION_SECRET_DIR`, then
run `./preflight.sh`, `./up.sh`, `./smoke.sh`, or the restart-inclusive `./qualify.sh`.
`TELEMETRY_BIND_ADDRESS` remains an exact loopback or private interface for management/query ports.
Per deployment requirement, `OTLP_HTTP_BIND_ADDRESS=0.0.0.0` publishes only OTLP/HTTP on every
IPv4 interface at port `4318`. Qualification mode protects that listener with Runtime client mTLS.

Use a qualification-specific `COMPOSE_PROJECT_NAME`. Compose will then create isolated ClickHouse,
WAL, and Grafana volumes without touching operator production volumes. `down.sh` deliberately keeps
those volumes; an operator may remove only that exact project with an explicit Compose `down -v`.

The live smoke is read-only: it probes health, Query API authentication, and the supplied Runtime
Prometheus endpoint. `ALLOW_SMPP_TELEMETRY_SIDE_EFFECT_TESTS` must remain `false`; this lifecycle
does not invoke movement, recon, gimbal, fire, or any Runtime operation.
