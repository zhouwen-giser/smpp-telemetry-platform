-- Additive compatibility migration. Historical defaults are estimates, not observed export times.
ALTER TABLE telemetry_core.entity_relation_fact
    ADD COLUMN IF NOT EXISTS projected_at DateTime64(3,'UTC') DEFAULT created_at AFTER created_at;
