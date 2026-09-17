import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { deviceManifestHash } from "@lobu/connector-sdk/device-manifest-hash";
import { validateDeviceConnectorManifests } from "../../../server/src/worker-api/device-manifests";
import { headlessDeviceConnectorManifests } from "../headless.js";
import {
  macDeviceConnectorDefinitions,
  macDeviceConnectorManifests,
  macDeviceConnectorRegistry,
} from "../mac.js";

const expectedOriginHashes: Record<string, string> = {
  "apple.calendar":
    "934f8866eae6b13db330ec784e9f731ac57684726fa9c8d1f57f4de07aa09adc",
  "apple.computer_use":
    "965fe77a4c08c06d6903a2f62540e19fb9f25c2b90c0db7b0de3c7cc973f0de5",
  "apple.health":
    "95d01cbd942d6af5f201656e2b6ed320e3e6559723ad3f9de619b524451f70e4",
  "apple.photos":
    "0e140bd9a6d8f88fd1a750033a54b3157961c2046d0d18de08e16a9a566718e5",
  "apple.reminders":
    "ccaf18f1c403ce2ae125388a7d5a720f33a0ef656c69a2a4bde45d7b364c5de1",
  "apple.screen_time":
    "882dc20d30bfa79387b6fc88dfa0a97719823bf29ea9dacb6e53fd881198e084",
  "apple.system_audio":
    "f6c7024f9a9c82b124ece768b8a30b255de0a6d3d0e57fbf20c6044daf035766",
  "local.directory":
    "6846173d4a56d58677375f654cb10f04844b275280ec1cfb18d4d24b0fca89ee",
  "os.shell":
    "6b099c370806197f55f1c69776b3e2fff84f6522e4172aa1cd0445911e46e2df",
};

describe("Mac device connector registry", () => {
  test("is sorted, unique, and excludes the retired Mac WhatsApp connector", () => {
    const keys = macDeviceConnectorDefinitions.map(({ key }) => key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(macDeviceConnectorRegistry["whatsapp.local"]).toBeUndefined();
    expect(keys).toEqual(Object.keys(expectedOriginHashes).sort());
  });

  test("matches the merged Owletto Mac manifests semantically", () => {
    for (const manifest of macDeviceConnectorManifests) {
      expect(deviceManifestHash(manifest)).toBe(
        expectedOriginHashes[manifest.key]
      );
      expect(manifest.runtime.platforms).toContain("macos");
      // Nothing about HOW an endpoint implements the contract may enter the
      // manifest: it is hashed, so it would fork the identity per platform.
      expect(manifest.runtime).not.toHaveProperty("execution");
      expect(manifest.auth_schema).toEqual({ methods: [{ type: "none" }] });
    }
    expect(
      macDeviceConnectorManifests.find((m) => m.key === "local.directory")
        ?.feeds_schema.files
    ).toMatchObject({
      userManaged: true,
    });
    expect(
      macDeviceConnectorManifests.find((m) => m.key === "apple.computer_use")
        ?.actions_schema
    ).toMatchObject({
      screenshot: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    });
  });

  // os.shell is implemented by two endpoints — the Mac app's native bridge and
  // the headless daemon's built-in — and an organization elects exactly ONE
  // manifest per key. Byte-identical serialization is what lets both endpoints
  // be authorized against that single definition; the moment the two artifacts
  // differ, whichever device advertises the losing hash is denied claim
  // authorization and goes silently unreachable while still polling healthy.
  test("os.shell serializes identically for the Mac and headless endpoints", () => {
    const mac = macDeviceConnectorManifests.find((m) => m.key === "os.shell");
    const headless = headlessDeviceConnectorManifests.find(
      (m) => m.key === "os.shell"
    );
    expect(mac).toBeDefined();
    expect(JSON.stringify(headless)).toBe(JSON.stringify(mac));
    expect(deviceManifestHash(headless!)).toBe(deviceManifestHash(mac!));
    expect(mac?.runtime.platforms).toEqual(["headless", "macos"]);
  });

  test("the checked-in headless artifact is generated from the registry", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          "../../../connector-worker/src/daemon/generated/headless-device-connector-manifests.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(artifact).toEqual(headlessDeviceConnectorManifests);
  });

  test("apple.photos advertises only what the PhotoKit bridge populates", () => {
    const photos = macDeviceConnectorManifests.find(
      (manifest) => manifest.key === "apple.photos"
    );
    expect(photos).toBeDefined();

    const library = photos?.feeds_schema.library;
    const photoKind = library?.eventKinds?.photo;
    expect(library).toBeDefined();
    expect(photoKind).toBeDefined();

    // The Mac bridge reads PhotoKit's public API only; people, captions,
    // keywords and OCR text live in the Photos.sqlite bundle and are not
    // read today. The feed is metadata-only (`operations: ["sync"]`, no
    // action schema), so image bytes are not fetchable either. No catalog
    // string may promise any of it. The one advertised key the bridge does
    // not fill is place_name, which geo enrichment fills server-side.
    const unsupported = /people|caption|keyword|ocr|image bytes/i;
    expect(photos?.description).toContain("PhotoKit");
    expect(photos?.description).not.toMatch(unsupported);
    expect(library?.description).not.toMatch(unsupported);
    expect(photoKind?.description).not.toMatch(unsupported);

    const metadataKeys = Object.keys(
      photoKind?.metadataSchema?.properties ?? {}
    );
    expect(metadataKeys).toContain("asset_local_id");
    for (const key of metadataKeys) {
      expect(key).not.toMatch(unsupported);
    }

    expect(photos?.runtime.scopes).toEqual(["date", "location", "albums"]);
  });

  test("every generated manifest is accepted by the server validator", () => {
    const result = validateDeviceConnectorManifests({
      platform: "macos",
      capabilities: macDeviceConnectorManifests.map(
        (manifest) => manifest.required_capability
      ),
      manifests: macDeviceConnectorManifests,
    });
    expect(result.accepted).toBe(true);
    expect(result.manifests).toHaveLength(macDeviceConnectorManifests.length);
  });

  test("the checked-in artifact is generated from the registry", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          "../../generated/macos-device-connector-manifests.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(artifact).toEqual(macDeviceConnectorManifests);
  });

  // The Mac app does not import this package: it ships its own copy of the
  // generated artifact inside the owletto submodule and advertises THAT to the
  // server. When the copies diverge, the app advertises a manifest the
  // server's active definition no longer matches, and its runs are never
  // claimable. os.shell shipped at 0.1.0 for days after the spec here moved to
  // 0.2.0 because nothing compared the two files. Byte parity is the contract:
  // the generator emits deterministic, sorted JSON, so a re-sync is a copy.
  // Skipped only when the submodule is a stub (fork CI without the deploy key).
  test("the Mac app bundles this exact generated artifact", () => {
    const canonical = new URL(
      "../../generated/macos-device-connector-manifests.json",
      import.meta.url
    );
    const bundled = new URL(
      "../../../owletto/apps/mac/Owletto/ConnectorManifests/macos-device-connector-manifests.json",
      import.meta.url
    );
    if (!existsSync(bundled)) {
      console.warn(
        "owletto submodule not checked out; Mac manifest parity not verified"
      );
      return;
    }
    expect(readFileSync(bundled, "utf8")).toBe(readFileSync(canonical, "utf8"));
  });
});
