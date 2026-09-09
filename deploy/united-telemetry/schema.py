#!/usr/bin/env python3
"""Export offline ClickHouse SQL metadata and restore only the recorded definitions."""
import argparse, hashlib, json, pathlib, re, subprocess, tarfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def export_metadata(source, output):
    objects = []
    with tarfile.open(source) as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or '..' in name.parts or len(name.parts) not in (1, 2) or name.suffix != '.sql':
                raise ValueError('ONLY_SQL_METADATA_ALLOWED')
            database = name.parts[0] if len(name.parts) == 2 else name.stem
            table = name.stem if len(name.parts) == 2 else None
            if not re.fullmatch(r'sdar_[a-z_]+', database) or (table and not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', table)):
                raise ValueError('INVALID_METADATA_NAME')
            raw = archive.extractfile(member).read()
            text = raw.decode()
            kind = 'DATABASE' if table is None else ('VIEW' if text.startswith('ATTACH VIEW ') else 'TABLE')
            qualified = database + ('.' + table if table else '')
            sql, count = re.subn(r"^ATTACH " + kind + r" _ UUID '[0-9a-f-]{36}'", 'CREATE ' + kind + ' ' + qualified, text, count=1)
            if count != 1 or re.search(r'\b(remote|remoteSecure|url|s3|mysql|postgresql|file|dictGet)\s*\(', sql, re.I):
                raise ValueError('UNSUPPORTED_METADATA:' + qualified)
            engines = re.findall(r'ENGINE\s*=\s*(\w+)', sql)
            if (kind == 'VIEW' and engines) or (kind == 'DATABASE' and engines != ['Atomic']) or (kind == 'TABLE' and (len(engines) != 1 or engines[0] not in ('MergeTree', 'ReplacingMergeTree'))):
                raise ValueError('UNSUPPORTED_ENGINE:' + qualified)
            objects.append({'name': qualified, 'kind': kind, 'sql': sql, 'originalSha256': digest(raw)})
    objects.sort(key=lambda o: ({'DATABASE': 0, 'TABLE': 1, 'VIEW': 2}[o['kind']], o['name']))
    if len({o['name'] for o in objects}) != len(objects):
        raise ValueError('DUPLICATE_OBJECT')
    required = {'sdar_core.external_provider_fact', 'sdar_core.external_entity_relation_fact'}
    if not required.issubset({o['name'] for o in objects}):
        raise ValueError('AUTHORITY_TABLES_MISSING')
    result = {'version': 1, 'source': 'smpp-arm64-dev:sdar-clickhouse_clickhouse_data (read-only SQL metadata; HTTP 8123 unavailable)', 'sourceArchiveSha256': digest(source.read_bytes()), 'objects': objects}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'objects': len(objects), 'sha256': digest(output.read_bytes())}))

def restore(schema, state, compose, release):
    raw = schema.read_bytes()
    objects = json.loads(raw)['objects']
    if any(not re.fullmatch(r'sdar_[a-z_]+(?:\.[A-Za-z_][A-Za-z_0-9]*)?', o['name']) or o['kind'] not in ('DATABASE','TABLE','VIEW') for o in objects):
        raise ValueError('INVALID_SCHEMA_OBJECT')
    ledger = state / 'sdar-schema-state.json'
    saved = json.loads(ledger.read_text()) if ledger.exists() else {'schemaSha256': digest(raw), 'objects': {}}
    if saved['schemaSha256'] != digest(raw):
        raise ValueError('SDAR_SCHEMA_CHANGE_REQUIRES_MIGRATION')
    def query(sql):
        cmd = ['docker', 'compose', '--env-file', '/dev/null', '-p', 'smpp-telemetry', '-f', str(compose), 'exec', '-T', 'sdar-clickhouse', 'sh', '-c', 'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$(cat /run/secrets/shared-password)" --multiquery']
        return subprocess.run(cmd, input=sql, text=True, capture_output=True)
    def fingerprint(obj):
        r = query('SHOW CREATE ' + ('DATABASE' if obj['kind'] == 'DATABASE' else 'TABLE') + ' ' + obj['name'] + ' FORMAT TabSeparatedRaw')
        if r.returncode:
            raise RuntimeError('SDAR_VERIFY_FAILED:' + obj['name'])
        return digest(r.stdout.strip().encode())
    verified = [o for o in objects if o['name'] in saved['objects']]
    if verified:
        result = query(';\n'.join('SHOW CREATE ' + ('DATABASE' if o['kind'] == 'DATABASE' else 'TABLE') + ' ' + o['name'] + ' FORMAT JSONEachRow' for o in verified))
        if result.returncode:
            raise ValueError('SDAR_SCHEMA_VERIFY_FAILED')
        definitions = [json.loads(line)['statement'] for line in result.stdout.splitlines() if line.strip()]
        if len(definitions) != len(verified):
            raise ValueError('SDAR_SCHEMA_VERIFY_COUNT_MISMATCH')
        for obj, definition in zip(verified, definitions):
            if digest(definition.strip().encode()) != saved['objects'][obj['name']]:
                raise ValueError('SDAR_SCHEMA_DRIFT:' + obj['name'])
    pending = [o for o in objects if o['name'] not in saved['objects']]
    while pending:
        next_pending = []
        for obj in pending:
            r = query(obj['sql'])
            if r.returncode:
                # Views may reference views declared later in the export.
                if obj['kind'] == 'VIEW' and re.search(r'Code: (60|81)\.', r.stderr):
                    next_pending.append(obj)
                    continue
                raise RuntimeError('SDAR_CREATE_FAILED:' + obj['name'] + ':' + r.stderr[:1200])
            saved['objects'][obj['name']] = fingerprint(obj)
            tmp = ledger.with_suffix('.tmp')
            tmp.write_text(json.dumps(saved, indent=2) + '\n')
            tmp.chmod(0o600)
            tmp.replace(ledger)
        if len(next_pending) == len(pending):
            raise ValueError('UNRESOLVED_VIEW_DEPENDENCIES:' + ','.join(o['name'] for o in pending))
        pending = next_pending
    seeds = [json.loads(line) for line in release.read_text().splitlines() if line.strip()]
    if len(seeds) != 1 or seeds[0]['release_version'] != '1.5.1-rc.2' or seeds[0]['migration_range'] != '00..26':
        raise ValueError('SDAR_RELEASE_SEED_INVALID')
    for field in ('release_descriptor', 'schema_contract'):
        if seeds[0][field + '_hash'] != 'sha256:' + digest(seeds[0][field + '_json'].encode()):
            raise ValueError('SDAR_RELEASE_CONTENT_HASH_MISMATCH')
    select = 'SELECT * FROM sdar_meta.schema_contract_release FINAL FORMAT JSONEachRow'
    result = query(select)
    if result.returncode:
        raise ValueError('SDAR_RELEASE_READ_FAILED')
    if not result.stdout.strip():
        result = query('INSERT INTO sdar_meta.schema_contract_release FORMAT JSONEachRow\n' + json.dumps(seeds[0]) + '\n')
        if result.returncode:
            raise ValueError('SDAR_RELEASE_INITIALIZE_FAILED')
        result = query(select)
    actual = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    if result.returncode or actual != seeds:
        raise ValueError('SDAR_RELEASE_SEED_DRIFT')
    print(json.dumps({'status': 'SDAR_SCHEMA_PASS', 'objects': len(objects), 'schemaSha256': digest(raw)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    exp = sub.add_parser('export-metadata'); exp.add_argument('source', type=pathlib.Path); exp.add_argument('output', type=pathlib.Path)
    apply = sub.add_parser('restore'); apply.add_argument('schema', type=pathlib.Path); apply.add_argument('state', type=pathlib.Path); apply.add_argument('compose', type=pathlib.Path); apply.add_argument('release', type=pathlib.Path)
    args = parser.parse_args()
    if args.action == 'export-metadata': export_metadata(args.source, args.output)
    else: restore(args.schema, args.state, args.compose, args.release)
