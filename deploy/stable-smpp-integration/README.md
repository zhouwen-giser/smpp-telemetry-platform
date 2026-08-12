# Stable SMPP integration deployment

This profile keeps SMPP external and runs ClickHouse, Processor, Collector, Query API, and Grafana.
The root Compose file is the development/plaintext mode. This override is the qualification and
production transport mode: Runtime→Collector and Collector→Processor both require mutual TLS.

Copy `.env.example` to `.env`, set exact identities and an absolute `QUALIFICATION_SECRET_DIR`, then
run `./preflight.sh`, `./up.sh`, `./smoke.sh`, or the restart-inclusive `./qualify.sh`.

Use a qualification-specific `COMPOSE_PROJECT_NAME`. Compose will then create isolated ClickHouse,
WAL, and Grafana volumes without touching operator production volumes. `down.sh` deliberately keeps
those volumes; an operator may remove only that exact project with an explicit Compose `down -v`.

The live smoke is read-only: it probes health, Query API authentication, and the supplied Runtime
Prometheus endpoint. `ALLOW_SMPP_TELEMETRY_SIDE_EFFECT_TESTS` must remain `false`; this lifecycle
does not invoke movement, recon, gimbal, fire, or any Runtime operation.
