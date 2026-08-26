# OpenTelemetry ClickHouse exporter intake

- Repository: https://github.com/open-telemetry/opentelemetry-collector-contrib
- Pin: v0.157.0 / 89e43555904cd97c2d36605347c5d5237b1bdc8c.
- License/NOTICE: exact upstream texts retained here and reviewed before adaptation.
- Use: existing unmodified Collector image; metric/trace SQL templates adapted in migration 008.
- Need: Processor only implements ProviderOps facts; do not duplicate OTLP parsing.
- Boundary: diagnostic ClickHouse data, never SDAR/SMPP business authority.
- Changes: fixed identifiers/engine, seven-day TTL; create_schema=false.
- Upgrade: pin image and DDL together; validate all five metric table contracts and real source metrics/spans. Never claim an absent metric kind was exercised live.
- Findings: metric exporter alpha; persistent at-least-once queue is not an audit transaction.
- Decision: accepted development integration; SDAR ADR-142. No new Node dependency.
