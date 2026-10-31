// Synthetic R2 acceptance helpers for an authenticated Cloudflare Code Mode session.
// Import a helper and embed helper.toString() in the session's code payload. The
// controller supplies the exact owned proof bucket, prefix, and generated files.
// These helpers deliberately do not provide an unattended production archiver:
// management-API PUTs do not establish atomic conditional-write or S3 auth guarantees.

export async function publishProofRevision(cloudflare, accountId, input) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const hash = async (bytes) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
  const decode = (encoded) =>
    Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const asBytes = (value) =>
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  check(
    /^lobu-obs-proof-[a-z0-9-]+$/.test(input.bucket),
    "Only a disposable proof bucket is allowed"
  );
  check(
    /^acceptance\/[0-9a-f-]+\/(v[123]|probe-[a-z-]+)\/$/.test(input.prefix),
    "Invalid owned proof prefix"
  );
  check(
    ["none", "missing", "corrupt", "abort-after-data"].includes(input.fault),
    "Unknown proof fault"
  );
  const files = input.files;
  check(
    Array.isArray(files) && files.length === 3,
    "Expected two Parquet files and one manifest"
  );
  for (const file of files) {
    check(file && typeof file === "object", "Invalid source object metadata");
    check(
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 16777216,
      "Invalid source object size"
    );
    check(
      typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256),
      "Invalid source object checksum"
    );
  }
  const byName = Object.fromEntries(files.map((file) => [file.name, file]));
  check(
    Object.keys(byName).sort().join(",") ===
      "manifest.json,otel_logs.parquet,otel_traces.parquet",
    "Unexpected proof inventory"
  );
  for (const file of files) {
    check(
      typeof file.base64 === "string" && file.base64.length <= 22369624,
      "Invalid encoded source object size"
    );
    file.bytes = decode(file.base64);
    check(file.bytes.length === file.size, "Invalid source object size");
    check(
      (await hash(file.bytes)) === file.sha256,
      "Source object checksum mismatch"
    );
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(byName["manifest.json"].bytes)
  );
  check(
    manifest?.scope === "local_synthetic_proof_only" &&
      manifest.format_version === 1,
    "Not a synthetic acceptance manifest"
  );
  check(
    manifest.tables &&
      Object.keys(manifest.tables).sort().join(",") === "logs,traces",
    "Unexpected manifest table inventory"
  );
  for (const [kind, name] of [
    ["logs", "otel_logs.parquet"],
    ["traces", "otel_traces.parquet"],
  ]) {
    const entry = manifest.tables[kind];
    check(
      entry?.file === name && byName[name].sha256 === entry.file_sha256,
      "Manifest/source hash mismatch"
    );
  }
  const base = `/accounts/${accountId}/r2/buckets/${input.bucket}`;
  const list = async () => {
    const response = await cloudflare.request({
      method: "GET",
      path: `${base}/objects`,
      query: { prefix: input.prefix, per_page: 20 },
    });
    check(
      response.success &&
        Array.isArray(response.result) &&
        !response.result_info?.is_truncated,
      "Object inventory failed or was truncated"
    );
    return response.result;
  };
  const info = await cloudflare.request({ method: "GET", path: base });
  check(
    info.success && info.result.location === "EEUR",
    "Proof bucket is not EEUR"
  );
  check(
    (await list()).length === 0,
    "Owned prefix is already populated; refusing to overwrite"
  );
  const receipts = [];
  const downloads = [];
  const dataNames = ["otel_logs.parquet", "otel_traces.parquet"];
  const pathFor = (name) => `${base}/objects/${input.prefix}${name}`;
  const put = async (name, body) => {
    const response = await cloudflare.request({
      method: "PUT",
      path: pathFor(name),
      body,
      contentType: "application/octet-stream",
    });
    check(response.success, "Object upload failed");
    receipts.push({ name, key: input.prefix + name, result: response.result });
  };
  for (let i = 0; i < dataNames.length; i++) {
    const name = dataNames[i];
    if (input.fault === "missing" && i === 0) continue;
    const bytes = new Uint8Array(byName[name].bytes);
    if (input.fault === "corrupt" && i === 0) bytes[0] ^= 1;
    await put(name, bytes);
    if (input.fault === "abort-after-data") {
      const keys = (await list()).map((object) => object.key);
      check(
        !keys.includes(`${input.prefix}manifest.json`),
        "Incomplete upload published a manifest"
      );
      return {
        status: "injected_failure_after_data_upload",
        manifest_published: false,
        receipts,
        keys,
      };
    }
  }
  const keys = (await list()).map((object) => object.key);
  if (!dataNames.every((name) => keys.includes(input.prefix + name))) {
    check(input.fault === "missing", "Required remote object missing");
    check(
      !keys.includes(`${input.prefix}manifest.json`),
      "Missing-object probe published a manifest"
    );
    return {
      status: "rejected_missing_object",
      manifest_published: false,
      receipts,
      keys,
    };
  }
  for (const name of dataNames) {
    const bytes = asBytes(
      await cloudflare.request({ method: "GET", path: pathFor(name) })
    );
    check(bytes instanceof Uint8Array, "Object download did not return bytes");
    const digest = await hash(bytes);
    if (digest !== byName[name].sha256 || bytes.length !== byName[name].size) {
      check(input.fault === "corrupt", "Remote readback checksum mismatch");
      check(
        !(await list()).some(
          (object) => object.key === `${input.prefix}manifest.json`
        ),
        "Corrupt-object probe published a manifest"
      );
      return {
        status: "rejected_corrupt_object",
        manifest_published: false,
        receipts,
        mismatched_object: { name, sha256: digest, bytes: bytes.length },
      };
    }
    downloads.push({ name, sha256: digest, size: bytes.length, data: bytes });
  }
  check(
    input.fault === "none",
    "Negative probe unexpectedly passed verification"
  );
  await put("manifest.json", byName["manifest.json"].bytes);
  const manifestBytes = asBytes(
    await cloudflare.request({ method: "GET", path: pathFor("manifest.json") })
  );
  check(
    manifestBytes instanceof Uint8Array &&
      manifestBytes.length === byName["manifest.json"].size &&
      (await hash(manifestBytes)) === byName["manifest.json"].sha256,
    "Manifest readback mismatch"
  );
  downloads.push({
    name: "manifest.json",
    sha256: byName["manifest.json"].sha256,
    size: manifestBytes.length,
    data: manifestBytes,
  });
  return {
    status: "published_after_verified_readback",
    manifest_published: true,
    receipts,
    downloads,
    conditional_create_tested: false,
    transport: "cloudflare-management-api",
  };
}

export async function readProofRevision(cloudflare, accountId, input) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  if (
    !/^lobu-obs-proof-[a-z0-9-]+$/.test(input.bucket) ||
    !/^acceptance\/[0-9a-f-]+\/v[123]\/$/.test(input.prefix)
  )
    throw new Error("Invalid proof target");
  check(
    Array.isArray(input.files) && input.files.length === 3,
    "Expected two Parquet files and one manifest"
  );
  for (const file of input.files) {
    check(file && typeof file === "object", "Invalid source object metadata");
    check(
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 16777216,
      "Invalid source object size"
    );
    check(
      typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256),
      "Invalid source object checksum"
    );
  }
  const byName = Object.fromEntries(
    input.files.map((file) => [file.name, file])
  );
  check(
    Object.keys(byName).sort().join(",") ===
      "manifest.json,otel_logs.parquet,otel_traces.parquet",
    "Unexpected proof inventory"
  );
  const result = [];
  for (const file of input.files) {
    if (
      !["manifest.json", "otel_logs.parquet", "otel_traces.parquet"].includes(
        file.name
      )
    )
      throw new Error("Invalid object");
    const value = await cloudflare.request({
      method: "GET",
      path: `/accounts/${accountId}/r2/buckets/${input.bucket}/objects/${input.prefix}${file.name}`,
    });
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    if (!(bytes instanceof Uint8Array))
      throw new Error("Object did not return bytes or lossless UTF-8 text");
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    if (bytes.length !== file.size || sha256 !== file.sha256)
      throw new Error("Remote object checksum mismatch");
    result.push({ name: file.name, size: bytes.length, sha256, data: bytes });
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(
      result.find((file) => file.name === "manifest.json").data
    )
  );
  check(
    manifest?.scope === "local_synthetic_proof_only" &&
      manifest.format_version === 1,
    "Not a synthetic acceptance manifest"
  );
  check(
    manifest.tables &&
      Object.keys(manifest.tables).sort().join(",") === "logs,traces",
    "Unexpected manifest table inventory"
  );
  for (const [kind, name] of [
    ["logs", "otel_logs.parquet"],
    ["traces", "otel_traces.parquet"],
  ]) {
    const entry = manifest.tables[kind];
    check(
      entry?.file === name && entry.file_sha256 === byName[name].sha256,
      "Manifest/source hash mismatch"
    );
  }
  return { status: "verified_existing_archive", downloads: result };
}
