#!/usr/bin/env python3
"""Operator-assisted Cloudflare REST roundtrip for the native archive fixture.

This driver performs no network requests and receives no credentials. A trusted
controller performs the remote operations and publishes completion.json atomically.
The driver independently checks the downloaded bytes and local-copy removal.
It does not prove S3 conditional writes, credential scope, or production readiness.
"""

import argparse
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid


TRANSPORT = "cloudflare-management-api"
REVISIONS = ("v1", "v2", "v3")
TABLE_FILES = {"logs": "otel_logs.parquet", "traces": "otel_traces.parquet"}
LIMITATIONS = [
    "S3 conditional create-once writes and concurrent-writer safety",
    "S3 writer/reader credential boundaries",
    "multipart upload recovery and ambiguous network-outcome recovery",
    "daily scheduler, arbitrary lateness, retention, and live count parity",
]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    """Publish one durable handoff record without a partially readable JSON file."""
    require(not path.exists(), f"Handoff record already exists: {path.name}")
    pending = path.with_name(path.name + ".pending")
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(json.dumps(value, sort_keys=True, indent=2).encode())
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, path)


def read_owned_file(path, root, maximum=16 * 1024 * 1024):
    root = root.absolute()
    path = path.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise RuntimeError("Handoff file escapes its owned directory") from error
    require(not root.is_symlink() and root.resolve() == root, "Owned directory changed or is a symlink")
    cursor = root
    for part in relative.parts:
        require(part not in (".", ".."), "Unsafe handoff path component")
        cursor /= part
        require(not cursor.is_symlink(), "Symlink in handoff path")
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum,
            "Handoff artifact is not a bounded regular file")
    return path.read_bytes()


class ArchiveTransport:
    def __init__(self, handoff_dir, deadline_seconds):
        self.handoff_dir = handoff_dir.resolve()
        self.handoff_dir.mkdir(mode=0o700)
        self.deadline_seconds = deadline_seconds
        self.run_id = str(uuid.uuid4())
        self.verified = False

    def __call__(self, archive_root, download_root, selected_revision):
        archive_root, download_root = archive_root.resolve(), download_root.resolve()
        root = archive_root.parent
        require(root.name.startswith("lobu-observability-proof-") and archive_root.name == "archive",
                "Unexpected native fixture directory")
        require(download_root == root / "r2-download", "Unexpected download directory")
        require(selected_revision == "v3", "Only the known late-arrival revision is selected")
        require(not (root / "source").exists(), "Original synthetic database still exists")
        require(not self.handoff_dir.is_relative_to(root) and not root.is_relative_to(self.handoff_dir),
                "Handoff evidence must be outside the auto-cleaned fixture directory")
        first_verification = root / "r2-first-verification"
        download_root.mkdir(mode=0o700)
        first_verification.mkdir(mode=0o700)

        # This oracle is captured in memory before the controller sees a checkpoint.
        oracle = {}
        for revision in REVISIONS:
            directory = archive_root / revision
            manifest_bytes = read_owned_file(directory / "manifest.json", root)
            manifest = json.loads(manifest_bytes)
            require(manifest.get("format_version") == 1 and set(manifest["tables"]) == set(TABLE_FILES),
                    "Unexpected local manifest format")
            require(manifest.get("scope") == "local_synthetic_proof_only", "Unexpected manifest scope")
            files = {"manifest.json": {"sha256": sha256(manifest_bytes), "bytes": len(manifest_bytes)}}
            for kind, filename in TABLE_FILES.items():
                entry = manifest["tables"][kind]
                require(entry["file"] == filename, "Unexpected archive filename")
                data = read_owned_file(directory / filename, root)
                require(sha256(data) == entry["file_sha256"], "Local archive does not match its manifest")
                files[filename] = {"sha256": sha256(data), "bytes": len(data)}
            oracle[revision] = {"manifest": manifest, "files": files}

        checkpoint = {
            "protocol_version": 1, "run_id": self.run_id, "transport": TRANSPORT,
            "phase": "awaiting_controller", "archive_root": str(archive_root),
            "download_root": str(download_root), "first_verification_root": str(first_verification),
            "selected_revision": selected_revision,
            "revisions": {name: value["files"] for name, value in oracle.items()},
            "completion_file": str(self.handoff_dir / "completion.json"),
            "evidence_file": str(self.handoff_dir / "remote-evidence.json"),
            "deadline_seconds": self.deadline_seconds,
            "limitations": LIMITATIONS,
        }
        write_json(self.handoff_dir / "checkpoint.json", checkpoint)
        print(json.dumps({"phase": "awaiting_controller", "run_id": self.run_id,
                          "checkpoint": str(self.handoff_dir / "checkpoint.json")}), flush=True)
        deadline = time.monotonic() + self.deadline_seconds
        completion_path = self.handoff_dir / "completion.json"
        while not completion_path.exists():
            require(time.monotonic() < deadline, "Controller completion deadline expired")
            time.sleep(0.25)
        require(time.monotonic() <= deadline, "Controller completion deadline expired")

        completion = json.loads(read_owned_file(completion_path, self.handoff_dir, 128 * 1024))
        require(completion.get("protocol_version") == 1 and completion.get("run_id") == self.run_id,
                "Completion belongs to a different run or protocol")
        require(completion.get("status") == "completed" and completion.get("transport") == TRANSPORT,
                "Controller did not report a management-API roundtrip")
        expected_restore = download_root / selected_revision
        require(completion.get("restore_directory") == str(expected_restore), "Wrong restoration path")
        require(not archive_root.exists() and not archive_root.is_symlink(),
                "Original local archive copies still exist")
        require(not first_verification.exists() and not first_verification.is_symlink(),
                "First verification copies still exist")
        require(not (root / "source").exists(), "Original synthetic database reappeared")
        require(not download_root.is_symlink(), "Download directory is a symlink")
        require(set(path.name for path in download_root.iterdir()) == {selected_revision},
                "Download directory contains unselected revisions or extra files")
        require(not expected_restore.is_symlink(), "Restoration directory is a symlink")
        expected = oracle[selected_revision]
        require(set(path.name for path in expected_restore.iterdir()) == set(expected["files"]),
                "Restoration inventory differs from the captured oracle")
        for filename, metadata in expected["files"].items():
            data = read_owned_file(expected_restore / filename, root)
            require(len(data) == metadata["bytes"] and sha256(data) == metadata["sha256"],
                    f"Downloaded artifact differs from the captured oracle: {filename}")
        downloaded_manifest = json.loads(read_owned_file(expected_restore / "manifest.json", root))
        require(downloaded_manifest == expected["manifest"], "Downloaded manifest changed")
        require(completion.get("manifest_sha256") == expected["files"]["manifest.json"]["sha256"],
                "Controller manifest digest differs from the captured oracle")

        evidence_path = self.handoff_dir / "remote-evidence.json"
        evidence_bytes = read_owned_file(evidence_path, self.handoff_dir, 512 * 1024)
        require(sha256(evidence_bytes) == completion.get("evidence_sha256"), "Remote evidence digest mismatch")
        evidence = json.loads(evidence_bytes)
        require(evidence.get("protocol_version") == 1 and evidence.get("run_id") == self.run_id
                and evidence.get("transport") == TRANSPORT, "Remote evidence belongs to another run")
        report = {
            "transport": TRANSPORT, "mode": "operator_assisted",
            "local_verification": "captured oracle matched fresh downloads; original local copies absent",
            "remote_actions": "performed and attested by controller; driver makes no network requests",
            "selected_revision": selected_revision,
            "manifest_sha256": expected["files"]["manifest.json"]["sha256"],
            "remote_evidence_file": str(evidence_path), "remote_evidence_sha256": sha256(evidence_bytes),
            "not_proven": LIMITATIONS,
        }
        write_json(self.handoff_dir / "transport-verified.json", report)
        self.verified = True
        return expected_restore, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof-script", type=Path, required=True)
    parser.add_argument("--handoff-dir", type=Path, required=True,
                        help="New owned directory outside the fixture temp tree; parent must exist")
    parser.add_argument("--deadline-seconds", type=int, default=900)
    parser.add_argument("proof_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    require(60 <= args.deadline_seconds <= 3600, "Controller deadline must be between 60 and 3600 seconds")
    proof_args = args.proof_args[1:] if args.proof_args[:1] == ["--"] else args.proof_args
    require(proof_args, "Pass the native fixture arguments after --")
    proof_path = args.proof_script.resolve(strict=True)
    spec = importlib.util.spec_from_file_location("lobu_native_archive_proof", proof_path)
    require(spec is not None and spec.loader is not None, "Cannot load native proof module")
    proof = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof)
    require({"argv", "archive_transport"} <= set(inspect.signature(proof.main).parameters),
            "Native proof does not yet expose the agreed optional transport hook")
    transport = ArchiveTransport(args.handoff_dir, args.deadline_seconds)
    started = time.monotonic()
    native_exit_code = 1
    exit_code = 1
    try:
        native_exit_code = proof.main(argv=proof_args, archive_transport=transport)
        if native_exit_code == 0 and transport.verified:
            exit_code = 0
        elif isinstance(native_exit_code, int) and 0 < native_exit_code < 256:
            exit_code = native_exit_code
        return exit_code
    finally:
        write_json(transport.handoff_dir / "result.json", {
            "status": "passed_management_api_roundtrip_restore" if exit_code == 0 else "failed",
            "native_exit_code": native_exit_code, "exit_code": exit_code,
            "transport_checkpoint_verified": transport.verified,
            "elapsed_seconds": round(time.monotonic() - started, 3), "not_proven": LIMITATIONS,
        })


if __name__ == "__main__":
    sys.exit(main())
