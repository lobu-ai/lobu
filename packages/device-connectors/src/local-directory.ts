import type { DeviceConnectorSpec } from "@lobu/connector-sdk";

/**
 * Canonical `local.directory` metadata, currently advertised only by the Mac
 * registry. Additional endpoints must reuse this definition to preserve one
 * manifest identity (see `os-shell.ts`).
 *
 * Changes to serialized metadata require a version bump and a new hash pin in
 * `__tests__/mac-device-connectors.test.ts`.
 */
export const localDirectoryDeviceConnector: DeviceConnectorSpec = {
  key: "local.directory",
  version: "0.2.0",
  name: "Local Folder",
  description:
    "Sync text files (txt/md/json/csv/html) from a folder on your Mac via Lobu for Mac.",
  faviconDomain: "apple.com",
  requiredCapability: "local_directory",
  runtime: {
    platforms: ["macos"],
  },
  authSchema: {
    methods: [
      {
        type: "none",
      },
    ],
  },
  feeds: {
    files: {
      key: "files",
      name: "Files",
      operations: ["sync", "read"],
      description:
        "Text files from one local folder on the user's Mac. One feed per folder — folder_id is an opaque stable id minted by the Mac app (the security-scoped bookmark is held device-side; the server never sees the absolute path).",
      userManaged: true,
      configSchema: {
        type: "object",
        required: ["folder_id", "display_name"],
        properties: {
          folder_id: {
            type: "string",
            minLength: 8,
            maxLength: 64,
            description:
              "Opaque stable id (UUID) minted on the Mac. Maps to a security-scoped bookmark stored locally on the device.",
          },
          display_name: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              'Folder name shown in the UI (e.g., "Documents"). Not used to locate the folder — the device resolves folder_id to its bookmark.',
          },
        },
      },
      eventKinds: {
        file_document: {
          description: "A text file from a configured local folder.",
          metadataSchema: {
            type: "object",
            required: ["source", "folder", "name"],
            properties: {
              source: {
                type: "string",
                const: "local_directory",
              },
              folder: {
                type: "string",
                description: "Display name of the local folder.",
              },
              name: {
                type: "string",
                description: "File name.",
              },
              ext: {
                type: "string",
              },
              size_bytes: {
                type: "number",
              },
              modified_at: {
                type: "string",
              },
            },
          },
        },
      },
    },
  },
};
