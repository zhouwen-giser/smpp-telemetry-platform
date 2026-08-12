# Qualification secrets

Do not place secrets in this repository. Set `QUALIFICATION_SECRET_DIR` to an absolute directory
owned by the operator with mode `0700`; private keys and tokens should be mode `0600`.
Set `TELEMETRY_SECRET_UID`/`TELEMETRY_SECRET_GID` to that owner so the non-root Collector can read
Compose file-backed secrets without making private keys world-readable.

Required files:

- `runtime-client-ca.pem`: CA dedicated to the authorized SMPP Runtime client certificate.
- `collector-server.pem` / `collector-server-key.pem`: Collector server identity. The certificate
  must cover the hostname or IP configured as the Runtime OTLP endpoint.
- `processor-server-ca.pem`, `processor-server.pem`, `processor-server-key.pem`: Processor server
  CA and identity; the certificate must contain DNS SAN `telemetry-processor`.
- `collector-client-ca.pem`, `collector-client.pem`, `collector-client-key.pem`: Collector client
  CA and identity accepted by Processor.
- `query-api-key.txt`: Query API bearer secret.

Runtime itself receives a client certificate issued by `runtime-client-ca.pem`; bind that CA to this
one Runtime deployment only. Never use `insecure_skip_verify`, a shared public CA, or a wildcard
source mapping for qualification.
