#!/usr/bin/env python3
"""Disposable native OTLP -> ClickHouse -> Parquet -> fresh-server restore proof.

Requires the two explicit, checksum-pinned downloads below. It only listens on
loopback, emits synthetic telemetry, and removes its own temporary data. It does
not contact R2, Kubernetes, Lobu, or a production collector. Successful output is
a local proof, never an authorization to route live logs or expire source data.
"""

import argparse
import collections
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


CLICKHOUSE_VERSION = "26.8.34.13"
CLICKHOUSE_SHA256 = "d1666bb409243aee970c6ea76d8b97e18cbcb6351d61d52dd3d88baab14d26db"
COLLECTOR_VERSION = "0.164.0"
COLLECTOR_ARCHIVE_SHA256 = "af6a0c56886e3cc36ccebe849fa167bad2bc47a97a48fd8497a0d6f93d0cf73a"
DATABASE = "otel_proof"
TABLES = {"logs": "otel_logs", "traces": "otel_traces"}
DAY = "2026-10-30"
START_NS = 1793318400000000000
END_NS = START_NS + 86400 * 1_000_000_000
WINDOW = (f"Timestamp >= fromUnixTimestamp64Nano({START_NS}) "
          f"AND Timestamp < fromUnixTimestamp64Nano({END_NS})")
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def canonical(rows):
    # Sorting complete rows preserves multiplicity while normalizing map order.
    return b"\n".join(sorted(json.dumps(row, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":")).encode() for row in rows))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(check, description, timeout=30):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(0.15)
    raise RuntimeError(f"Timed out: {description}; last transport error: {last_error}")


class Child:
    def __init__(self, command, directory, log, extra_env=None):
        self.command, self.directory, self.log = command, directory, log
        self.extra_env = extra_env or {}
        self.process = None

    def start(self):
        require(self.process is None or self.process.poll() is not None,
                "Refusing to launch a duplicate child")
        env = {key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR") if key in os.environ}
        env.update({"TZ": "UTC", **self.extra_env})
        with self.log.open("ab") as output:
            self.process = subprocess.Popen(self.command, cwd=self.directory, env=env,
                                            stdin=subprocess.DEVNULL, stdout=output,
                                            stderr=subprocess.STDOUT, start_new_session=True)

    def alive(self):
        if self.process.poll() is not None:
            raise RuntimeError(f"Child exited ({self.process.returncode}): {self.log.name}")
        return True

    def stop(self, crash=False):
        if self.process is None or self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGKILL if crash else signal.SIGTERM)
        except ProcessLookupError:
            self.process.wait(timeout=1)
            return
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The child exited before SIGKILL; still reap it below.
                pass
            self.process.wait(timeout=5)


class Server:
    def __init__(self, root, name, binary):
        self.directory = root / name
        self.directory.mkdir()
        self.http_port, self.tcp_port = free_port(), free_port()
        while self.tcp_port == self.http_port:
            self.tcp_port = free_port()
        data = self.directory / "data"
        data.mkdir()
        for child in ("tmp", "user_files", "format_schemas"):
            (data / child).mkdir()
        users = self.directory / "users.xml"
        users.write_text("""<clickhouse><profiles><default>
<max_memory_usage>268435456</max_memory_usage><max_threads>2</max_threads>
<max_insert_threads>1</max_insert_threads></default></profiles>
<users><default><password></password><networks><ip>127.0.0.1</ip></networks>
<profile>default</profile><quota>default</quota></default></users>
<quotas><default><interval><duration>3600</duration><queries>0</queries>
<errors>0</errors><result_rows>0</result_rows><read_rows>0</read_rows>
<execution_time>0</execution_time></interval></default></quotas></clickhouse>""")
        config = self.directory / "config.xml"
        path = html.escape(str(data))
        config.write_text(f"""<clickhouse>
<logger><level>warning</level><console>true</console></logger>
<listen_host>127.0.0.1</listen_host><http_port>{self.http_port}</http_port>
<tcp_port>{self.tcp_port}</tcp_port><timezone>UTC</timezone>
<path>{path}/</path><tmp_path>{path}/tmp/</tmp_path>
<user_files_path>{path}/user_files/</user_files_path>
<format_schema_path>{path}/format_schemas/</format_schema_path>
<users_config>{html.escape(str(users))}</users_config>
<max_server_memory_usage>536870912</max_server_memory_usage>
<max_concurrent_queries>4</max_concurrent_queries><max_thread_pool_size>64</max_thread_pool_size>
<background_pool_size>2</background_pool_size>
<background_merges_mutations_concurrency_ratio>1</background_merges_mutations_concurrency_ratio>
<background_schedule_pool_size>2</background_schedule_pool_size>
<background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size>
<background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size>
<background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
<background_move_pool_size>1</background_move_pool_size>
<background_fetches_pool_size>1</background_fetches_pool_size>
<background_common_pool_size>2</background_common_pool_size>
<merge_tree><number_of_free_entries_in_pool_to_execute_mutation>0</number_of_free_entries_in_pool_to_execute_mutation>
<number_of_free_entries_in_pool_to_lower_max_size_of_merge>0</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
<number_of_free_entries_in_pool_to_execute_optimize_entire_partition>0</number_of_free_entries_in_pool_to_execute_optimize_entire_partition></merge_tree>
</clickhouse>""")
        self.child = Child([str(binary), "server", "--config-file", str(config)],
                           self.directory, root / f"{name}.log")

    def start(self):
        self.child.start()
        wait_for(lambda: self.child.alive() and self.sql("SELECT 1").strip() == b"1",
                 "ClickHouse readiness (including first-launch binary expansion)", timeout=60)
        actual_path = self.sql("SELECT path FROM system.disks WHERE name = 'default'").decode().strip()
        require(Path(actual_path).resolve() == (self.directory / "data").resolve(),
                "Loopback endpoint is not the owned temporary ClickHouse instance")

    def sql(self, query, data=b""):
        url = f"http://127.0.0.1:{self.http_port}/?" + urllib.parse.urlencode({"query": query})
        request = urllib.request.Request(url, data=data, method="POST",
                                         headers={"Content-Type": "application/octet-stream"})
        try:
            with LOCAL_HTTP.open(request, timeout=15) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"ClickHouse query failed: {error.read().decode()[:3000]}") from error

    def rows(self, query):
        return [json.loads(line) for line in self.sql(query + " FORMAT JSONEachRow").splitlines()]


def make_collector(root, source, archive):
    require(file_digest(archive) == COLLECTOR_ARCHIVE_SHA256, "Collector archive checksum mismatch")
    binary = root / "otelcol-contrib"
    with tarfile.open(archive) as tar:
        matches = [member for member in tar.getmembers()
                   if member.isfile() and Path(member.name).name == "otelcol-contrib"]
        require(len(matches) == 1, "Expected one collector executable in the pinned archive")
        with tar.extractfile(matches[0]) as stream, binary.open("wb") as target:
            shutil.copyfileobj(stream, target)
    binary.chmod(0o700)
    port = free_port()
    queue = root / "collector-queue"
    queue.mkdir()
    config = root / "collector.yaml"
    # JSON is a YAML subset; quoting paths this way avoids YAML interpolation.
    config.write_text(json.dumps({
        "extensions": {"file_storage": {"directory": str(queue)}},
        "receivers": {"otlp": {"protocols": {"http": {"endpoint": f"127.0.0.1:{port}"}}}},
        "processors": {"memory_limiter": {"check_interval": "100ms", "limit_mib": 128,
                                             "spike_limit_mib": 32}},
        "exporters": {"clickhouse": {
            "endpoint": f"tcp://127.0.0.1:{source.tcp_port}", "database": DATABASE,
            "username": "default", "password": "", "create_schema": True, "ttl": "0s",
            "logs_table_name": TABLES["logs"], "traces_table_name": TABLES["traces"],
            "timeout": "2s", "async_insert": False,
            "sending_queue": {"enabled": True, "queue_size": 100, "num_consumers": 1,
                              "storage": "file_storage"},
            "retry_on_failure": {"enabled": True, "initial_interval": "200ms",
                                 "max_interval": "1s", "max_elapsed_time": "0s"}}},
        "service": {
            "extensions": ["file_storage"],
            "telemetry": {"logs": {"level": "warn"}, "metrics": {"level": "none"}},
            "pipelines": {kind: {"receivers": ["otlp"], "processors": ["memory_limiter"],
                                 "exporters": ["clickhouse"]} for kind in TABLES}}
    }, indent=2))
    child = Child([str(binary), "--config", str(config)], root, root / "collector.log",
                  {"GOMEMLIMIT": "192MiB"})
    return child, port, file_digest(binary)


def kv(key, value):
    if isinstance(value, bool):
        typed = {"boolValue": value}
    elif isinstance(value, int):
        typed = {"intValue": str(value)}
    elif isinstance(value, float):
        typed = {"doubleValue": value}
    else:
        typed = {"stringValue": value}
    return {"key": key, "value": typed}


def log_record(identifier, offset=123456789, span=2):
    return {"timeUnixNano": str(START_NS + offset), "observedTimeUnixNano": str(START_NS + offset + 1),
            "severityNumber": 9, "severityText": "INFO", "traceId": "11" * 16,
            "spanId": f"{span:016x}", "flags": 1,
            "body": {"stringValue": 'İstanbul / 東京\nsecond line: "quoted" \\ slash'},
            "attributes": [kv("proof.id", identifier), kv("proof.bool", True),
                           kv("proof.integer", 9007199254740993), kv("proof.float", 1.25),
                           kv("proof.empty", "")]}


def span_record(identifier, span=1, parent=0):
    return {"traceId": "11" * 16, "spanId": f"{span:016x}",
            "parentSpanId": f"{parent:016x}" if parent else "",
            "name": identifier, "kind": 1,
            "startTimeUnixNano": str(START_NS + span * 1_000_000_000 + 123456789),
            "endTimeUnixNano": str(START_NS + span * 1_000_000_000 + 223456799),
            "attributes": [kv("proof.id", identifier), kv("proof.unicode", "İstanbul / 東京")],
            "events": [{"timeUnixNano": str(START_NS + span * 1_000_000_000 + 123456790),
                        "name": "event\nwith newline", "attributes": [kv("ok", True)]}],
            "status": {"code": 1}}


def post_otlp(port, kind, records, service="proof-api"):
    item = "logRecords" if kind == "logs" else "spans"
    scope = "scopeLogs" if kind == "logs" else "scopeSpans"
    resource = "resourceLogs" if kind == "logs" else "resourceSpans"
    body = {resource: [{"resource": {"attributes": [kv("service.name", service),
                                                      kv("proof.resource", "synthetic"),
                                                      kv("k8s.namespace.name", "proof-namespace")]},
                       scope: [{"scope": {"name": "disposable-proof", "version": "1"}, item: records}]}]}
    request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/{kind}",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with LOCAL_HTTP.open(request, timeout=5) as response:
        result = json.loads(response.read() or b"{}")
    require(not result.get("partialSuccess"), f"OTLP partial rejection: {result}")


def wait_record(server, kind, identifier):
    column = "LogAttributes" if kind == "logs" else "SpanAttributes"
    query = (f"SELECT count() FROM {DATABASE}.{TABLES[kind]} "
             f"WHERE {column}['proof.id'] = '{identifier}'")
    return wait_for(lambda: int(server.sql(query)) > 0, f"persisted {identifier}")


def snapshot(server, kind):
    return server.rows(f"SELECT * FROM {DATABASE}.{TABLES[kind]} WHERE {WINDOW}")


def schemas(server):
    return server.rows("SELECT name, engine, create_table_query AS ddl FROM system.tables "
                       f"WHERE database = '{DATABASE}' ORDER BY name")


def trace_index(server):
    return server.rows(f"SELECT TraceId, toString(min(Start)) AS start, toString(max(End)) AS end "
                       f"FROM {DATABASE}.otel_traces_trace_id_ts GROUP BY TraceId ORDER BY TraceId")


def materialized_rows(server, kind):
    columns = server.rows("SELECT name FROM system.columns "
                          f"WHERE database = '{DATABASE}' AND table = '{TABLES[kind]}' "
                          "AND default_kind = 'MATERIALIZED' ORDER BY position")
    if not columns:
        return []
    projection = ", ".join("`" + row["name"].replace("`", "``") + "`" for row in columns)
    return server.rows(f"SELECT {projection} FROM {DATABASE}.{TABLES[kind]} WHERE {WINDOW}")


def verify_parquet(server, kind, data, expected_rows):
    table = f"{DATABASE}.archive_verify_{kind}"
    columns = server.rows("SELECT name, type FROM system.columns "
                          f"WHERE database = '{DATABASE}' AND table = '{TABLES[kind]}' "
                          "AND default_kind NOT IN ('MATERIALIZED', 'ALIAS') ORDER BY position")
    definitions = ", ".join("`" + row["name"].replace("`", "``") + "` " + row["type"] for row in columns)
    # Copy types only: the source's MergeTree indexes are not valid on Memory.
    server.sql(f"CREATE TABLE {table} ({definitions}) ENGINE = Memory")
    try:
        server.sql(f"INSERT INTO {table} FORMAT Parquet", data)
        actual_rows = server.rows(f"SELECT * FROM {table}")
        if canonical(actual_rows) != canonical(expected_rows):
            attribute = "LogAttributes" if kind == "logs" else "SpanAttributes"
            ordered_expected = sorted(expected_rows, key=lambda row: row[attribute]["proof.id"])
            ordered_actual = sorted(actual_rows, key=lambda row: row[attribute]["proof.id"])
            details = {"expected_rows": len(expected_rows), "actual_rows": len(actual_rows), "differences": []}
            for expected, actual in zip(ordered_expected, ordered_actual):
                for name in sorted(set(expected) | set(actual)):
                    if name not in expected or name not in actual or expected[name] != actual[name]:
                        details["differences"].append({"id": expected[attribute]["proof.id"], "column": name,
                            "expected": repr(expected.get(name, "<absent>"))[:300],
                            "actual": repr(actual.get(name, "<absent>"))[:300]})
                        if len(details["differences"]) == 8:
                            break
                if len(details["differences"]) == 8:
                    break
            raise RuntimeError(f"Parquet typed readback differs from source snapshot: {kind}: {json.dumps(details)}")
    finally:
        server.sql(f"DROP TABLE {table}")


def write_archive(server, directory, schema, mutate_first_file=None):
    directory.mkdir()  # Reusing a committed revision is an error.
    manifest = {"format_version": 1, "scope": "local_synthetic_proof_only", "utc_day": DAY,
                "start_unix_nano": str(START_NS), "end_unix_nano_exclusive": str(END_NS),
                "clickhouse_version": CLICKHOUSE_VERSION, "collector_version": COLLECTOR_VERSION,
                "schema": schema, "tables": {},
                "derived_trace_index_sha256": digest(canonical(trace_index(server)))}
    for kind, table in TABLES.items():
        rows = snapshot(server, kind)
        data = server.sql(f"SELECT * FROM {DATABASE}.{table} WHERE {WINDOW} FORMAT Parquet")
        filename = f"{table}.parquet"
        path = directory / filename
        path.write_bytes(data)
        if mutate_first_file is not None and kind == "logs":
            mutate_first_file(path)
        require(path.is_file(), f"Missing archive object: {filename}")
        require(file_digest(path) == digest(data), f"Archive checksum mismatch: {filename}")
        verify_parquet(server, kind, path.read_bytes(), rows)
        require(canonical(snapshot(server, kind)) == canonical(rows),
                f"Source changed during export/readback; retry as a new revision: {kind}")
        manifest["tables"][kind] = {"file": filename, "file_sha256": digest(data), "rows": len(rows),
                                    "canonical_sha256": digest(canonical(rows)),
                                    "materialized_sha256": digest(canonical(materialized_rows(server, kind))),
                                    "services": dict(collections.Counter(row["ServiceName"] for row in rows))}
    validate_archive(directory, manifest)
    require(digest(canonical(trace_index(server))) == manifest["derived_trace_index_sha256"],
            "Derived trace index changed during export")
    # The completion marker appears only after every immutable data file verifies.
    pending = directory / "manifest.tmp"
    pending.write_text(json.dumps(manifest, sort_keys=True, indent=2))
    os.replace(pending, directory / "manifest.json")
    return manifest


def validate_archive(directory, manifest):
    require(manifest["format_version"] == 1 and set(manifest["tables"]) == set(TABLES),
            "Unknown archive manifest")
    for entry in manifest["tables"].values():
        filename = entry["file"]
        require(Path(filename).name == filename, "Archive path must be a direct child")
        path = directory / filename
        require(path.is_file(), f"Missing archive object: {filename}")
        require(file_digest(path) == entry["file_sha256"], f"Archive checksum mismatch: {filename}")


def expect_rejection(check, description, expected_error):
    try:
        check()
    except RuntimeError as error:
        require(expected_error in str(error), f"Wrong failure for {description}: {error}")
        return description
    raise RuntimeError(f"Failure gate accepted {description}")


def run(args):
    download, collector_archive = args.clickhouse.resolve(), args.collector_archive.resolve()
    require(download.is_file() and file_digest(download) == CLICKHOUSE_SHA256,
            "ClickHouse binary checksum mismatch")
    require(shutil.disk_usage(tempfile.gettempdir()).free > 2 * 1024 ** 3, "Need 2 GiB free scratch space")
    report = {"status": "running", "pins": {"clickhouse": CLICKHOUSE_VERSION,
              "clickhouse_sha256": CLICKHOUSE_SHA256, "collector": COLLECTOR_VERSION,
              "collector_archive_sha256": COLLECTOR_ARCHIVE_SHA256}, "checks": [],
              "not_tested": ["actual EEUR R2 upload/download, permissions and outage recovery",
                             "Linux cgroup limits, filesystem quotas and shared-RAID contention",
                             "production Linux ClickHouse version selection and compatibility",
                             "production log input, rotation, backpressure and 7–14 day parity",
                             "daily scheduler, arbitrary late arrivals and production retention/TTL"]}
    children = []
    with tempfile.TemporaryDirectory(prefix="lobu-observability-proof-") as temp:
        root = Path(temp)
        try:
            # The official Mac binary expands itself IN PLACE on first launch.
            # Execute an owned copy so the caller's pinned download stays intact.
            binary = root / "clickhouse"
            shutil.copyfile(download, binary)
            require(file_digest(binary) == CLICKHOUSE_SHA256, "ClickHouse copy checksum mismatch")
            binary.chmod(0o700)
            source = Server(root, "source", binary)
            children.append(source.child)
            source.start()
            version = source.sql("SELECT version()").decode().strip()
            require(version == CLICKHOUSE_VERSION, f"Unexpected ClickHouse version: {version}")
            report["pins"]["clickhouse_expanded_sha256"] = file_digest(binary)
            collector, port, collector_hash = make_collector(root, source, collector_archive)
            children.append(collector)
            report["pins"]["collector_extracted_sha256"] = collector_hash
            collector.start()
            wait_for(lambda: collector.alive() and socket_ready(port), "collector HTTP readiness")
            initial_logs = [log_record("normal"), log_record("lower-bound", 0),
                            log_record("upper-inside", 86400 * 1_000_000_000 - 1),
                            log_record("before-window", -1),
                            log_record("upper-outside", 86400 * 1_000_000_000)]
            initial_spans = [span_record("root", 1), span_record("child", 2, 1)]
            post_otlp(port, "logs", initial_logs)
            post_otlp(port, "traces", initial_spans)
            wait_record(source, "logs", "upper-outside")
            wait_record(source, "traces", "child")
            ingested = source.rows(f"SELECT LogAttributes['proof.id'] AS id FROM {DATABASE}.otel_logs")
            require(collections.Counter(row["id"] for row in ingested) ==
                    collections.Counter({record["attributes"][0]["value"]["stringValue"]: 1
                                         for record in initial_logs}), "Initial logs missing or duplicated")
            ingested = source.rows(f"SELECT SpanAttributes['proof.id'] AS id FROM {DATABASE}.otel_traces")
            require(collections.Counter(row["id"] for row in ingested) == {"root": 1, "child": 1},
                    "Initial spans missing or duplicated")
            report["checks"].append("real OTLP/HTTP logs and traces stored through native ClickHouse exporter")

            source.child.stop()
            post_otlp(port, "logs", [log_record("queued", 1_123456789)], "proof-worker")
            post_otlp(port, "traces", [span_record("queued-span", 3, 2)], "proof-worker")
            collector.stop(crash=True)
            source.start()
            collector.start()
            wait_for(lambda: collector.alive() and socket_ready(port), "restarted collector")
            wait_record(source, "logs", "queued")
            wait_record(source, "traces", "queued-span")
            report["checks"].append("accepted telemetry survived collector SIGKILL during ClickHouse outage")

            post_otlp(port, "logs", [initial_logs[0], log_record("replay-barrier", 2_123456789)])
            post_otlp(port, "traces", [initial_spans[0], span_record("replay-barrier-span", 4, 1)])
            wait_record(source, "logs", "replay-barrier")
            wait_record(source, "traces", "replay-barrier-span")
            logs, spans = snapshot(source, "logs"), snapshot(source, "traces")
            log_ids = collections.Counter(row["LogAttributes"]["proof.id"] for row in logs)
            span_ids = collections.Counter(row["SpanAttributes"]["proof.id"] for row in spans)
            require(set(log_ids) == {"normal", "lower-bound", "upper-inside", "queued", "replay-barrier"},
                    f"Unexpected/missing UTC-day log IDs: {log_ids}")
            require(set(span_ids) == {"root", "child", "queued-span", "replay-barrier-span"},
                    f"Missing spans: {span_ids}")
            report["replay_observation"] = {"normal_log_copies": log_ids["normal"],
                                             "root_span_copies": span_ids["root"],
                                             "delivery_semantics": "at least once; no exactly-once claim"}
            precision = source.rows(f"SELECT LogAttributes['proof.id'] AS id, "
                                    f"toString(toUnixTimestamp64Nano(Timestamp)) AS ns "
                                    f"FROM {DATABASE}.otel_logs WHERE {WINDOW}")
            require(any(row["id"] == "upper-inside" and row["ns"] == str(END_NS - 1) for row in precision),
                    "Nanosecond boundary was truncated")
            require(all(row["TraceId"] == "11" * 16 for row in logs + spans), "Trace ID mismatch")
            require(any(row["SpanId"] == "0000000000000002" and row["ParentSpanId"] == "0000000000000001"
                        for row in spans), "Parent span linkage lost")
            require(any("İstanbul / 東京\nsecond line" in row["Body"] for row in logs), "Log body lost")
            require(all(row["LogAttributes"]["proof.integer"] == "9007199254740993" and
                        row["LogAttributes"]["proof.bool"] == "true" and
                        row["LogAttributes"]["proof.float"] == "1.25" and
                        row["LogAttributes"]["proof.empty"] == "" for row in logs),
                    "Attribute values lost precision or changed during OTLP ingestion")
            require(all(int(row["Duration"]) == 100000010 for row in spans), "Span duration precision lost")
            require(all(int(row["TraceFlags"]) == 1 for row in logs), "Log trace flags changed")
            require(all(row["StatusCode"].lower() == "ok" for row in spans), "Span success status lost")
            hidden = materialized_rows(source, "logs")
            require(hidden and all(row.get("__otel_materialized_k8s.namespace.name") == "proof-namespace"
                                   for row in hidden), "Exporter namespace materialization missing")
            events = source.rows(f"SELECT SpanId, arrayMap(x -> toString(toUnixTimestamp64Nano(x)), "
                                 f"`Events.Timestamp`) AS ns FROM {DATABASE}.otel_traces WHERE {WINDOW}")
            require(all(row["ns"] == [str(START_NS + int(row["SpanId"], 16) * 1_000_000_000 + 123456790)]
                        for row in events), "Span event timestamp precision lost")
            report["checks"].append("nanosecond UTC bounds, Unicode/multiline bodies, maps and trace parents")

            schema = schemas(source)
            require(any(row["engine"] == "MaterializedView" for row in schema), "Trace index view missing")
            require(trace_index(source), "Trace lookup index is empty")
            archive = root / "archive"
            archive.mkdir()
            first = write_archive(source, archive / "v1", schema)
            repeat = write_archive(source, archive / "v2", schema)
            require(all(first["tables"][kind]["canonical_sha256"] == repeat["tables"][kind]["canonical_sha256"]
                        for kind in TABLES), "Repeated stable export changed logical rows")
            post_otlp(port, "logs", [log_record("late-arrival", 3_123456789)], "proof-worker")
            wait_record(source, "logs", "late-arrival")
            manifest = write_archive(source, archive / "v3", schema)
            require(manifest["tables"]["logs"]["rows"] == first["tables"]["logs"]["rows"] + 1,
                    "Late-arrival revision did not include the extra record")
            require((archive / "v1" / "manifest.json").read_text() == json.dumps(first, sort_keys=True, indent=2),
                    "Earlier archive revision was overwritten")
            report["checks"].append("stable re-export and immutable late-arrival revision")

            broken = archive / "corrupt-probe"
            report["checks"].append(expect_rejection(
                lambda: write_archive(source, broken, schema, lambda path: path.write_bytes(b"corrupt")),
                                                     "corrupt archive rejected", "Archive checksum mismatch"))
            missing = archive / "missing-probe"
            report["checks"].append(expect_rejection(
                lambda: write_archive(source, missing, schema, lambda path: path.unlink()),
                                                     "missing archive rejected", "Missing archive object"))
            require(not (broken / "manifest.json").exists() and not (missing / "manifest.json").exists(),
                    "Invalid revision acquired a completion marker")

            collector.stop()
            source.child.stop()
            shutil.rmtree(source.directory)
            require(not source.directory.exists(), "Original data still exists")
            restored = Server(root, "restored", binary)
            children.append(restored.child)
            restored.start()
            # Everything needed for the restore comes from the saved archive.
            manifest_path = archive / "v3" / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            validate_archive(archive / "v3", manifest)
            restored.sql(f"CREATE DATABASE {DATABASE}")
            # Restore the original exporter schema; derived trace indexes are
            # rebuilt by their materialized views, never imported a second time.
            for row in sorted(manifest["schema"], key=lambda row: row["engine"] == "MaterializedView"):
                restored.sql(row["ddl"])
            for kind, table in TABLES.items():
                entry = manifest["tables"][kind]
                restored.sql(f"INSERT INTO {DATABASE}.{table} FORMAT Parquet",
                             (archive / "v3" / entry["file"]).read_bytes())
                rows = restored.rows(f"SELECT * FROM {DATABASE}.{table}")
                require(len(rows) == entry["rows"], f"Restore row count mismatch: {kind}")
                require(digest(canonical(rows)) == entry["canonical_sha256"], f"Restore full-row mismatch: {kind}")
                require(dict(collections.Counter(row["ServiceName"] for row in rows)) == entry["services"],
                        f"Restore service counts mismatch: {kind}")
                require(digest(canonical(materialized_rows(restored, kind))) == entry["materialized_sha256"],
                        f"Restore did not regenerate materialized columns: {kind}")
            require(digest(canonical(trace_index(restored))) == manifest["derived_trace_index_sha256"],
                    "Restored trace lookup index mismatch")
            report["checks"].append("source data removed; fresh server restored exact full-row multisets and trace lookup")
            report["archive"] = {"utc_day": DAY, "revision": "v3", "tables": manifest["tables"],
                                 "schema_sha256": digest(canonical(manifest["schema"])),
                                 "manifest_sha256": file_digest(manifest_path)}
            report["configured_limits"] = {"clickhouse_server_bytes": 536870912,
                                             "clickhouse_query_bytes": 268435456, "clickhouse_threads": 2,
                                             "collector_limit_mib": 128, "collector_gomemlimit": "192MiB",
                                             "os_enforced": False}
            report["status"] = "passed_local_only"
            require(file_digest(download) == CLICKHOUSE_SHA256, "Caller's ClickHouse artifact changed")
            return report
        except Exception:
            for path in root.glob("*.log"):
                print(f"--- {path.name} ---\n{path.read_text(errors='replace')[-10000:]}", file=sys.stderr)
            raise
        finally:
            # A first termination signal during normal teardown must not skip
            # the remaining children either. Every child has its own deadline.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            cleanup_errors = []
            for child in reversed(children):
                try:
                    child.stop()
                except Exception as error:
                    cleanup_errors.append(str(error))
            if cleanup_errors:
                raise RuntimeError(f"Owned child cleanup failed: {cleanup_errors}")


def socket_ready(port):
    with socket.create_connection(("127.0.0.1", port), timeout=0.5):
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clickhouse", type=Path, required=True,
                        help="Official clickhouse-macos-aarch64 from v26.8.34.13-lts")
    parser.add_argument("--collector-archive", type=Path, required=True,
                        help="Official otelcol-contrib_0.164.0_darwin_arm64.tar.gz")
    args = parser.parse_args()
    interrupted = []

    def interrupt(signum, _frame):
        interrupted.append(signum)
        # A second signal must not interrupt child teardown and temp cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        report = run(args)
    except KeyboardInterrupt:
        print(json.dumps({"status": "failed", "error": "Interrupted; owned children cleaned up"}))
        return 128 + (interrupted[0] if interrupted else signal.SIGINT)
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
