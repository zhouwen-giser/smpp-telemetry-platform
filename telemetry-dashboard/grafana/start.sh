#!/bin/sh
set -eu
# Grafana deliberately does not expand environment variables in alert query models.
# Render only validated numeric thresholds into a private runtime provisioning copy.
provisioning="${GF_PATHS_PROVISIONING_RENDERED:-/tmp/smpp-grafana-provisioning}"
mkdir -p "$provisioning"
cp -R /etc/grafana/provisioning/. "$provisioning/"
render_threshold() {
  name="$1"
  value="$2"
  case "$value" in ''|*[!0-9]*) echo "Invalid numeric alert threshold: $name" >&2; exit 1;; esac
  pattern='${'"$name"'}'
  sed -i "s/$pattern/$value/g" "$provisioning/alerting/telemetry.json"
}
render_threshold ALERT_WAL_BYTES "${ALERT_WAL_BYTES:-912680550}"
render_threshold ALERT_STATE_BYTES "${ALERT_STATE_BYTES:-1073741824}"
render_threshold ALERT_ARCHIVE_BYTES "${ALERT_ARCHIVE_BYTES:-10737418240}"
render_threshold ALERT_DLQ_BYTES "${ALERT_DLQ_BYTES:-268435456}"
render_threshold ALERT_PENDING_AGE_MS "${ALERT_PENDING_AGE_MS:-300000}"
export GF_PATHS_PROVISIONING="$provisioning"
exec /run.sh
