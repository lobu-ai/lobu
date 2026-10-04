import type { DeviceConnectorSpec } from "@lobu/connector-sdk";

/**
 * The one `os.shell` contract, shared by every endpoint that implements it.
 *
 * Two endpoints run shell commands today — the Mac app, through its native
 * bridge, and the `lobu daemon` built-in on a headless host — and before this
 * file each authored its own manifest. Two manifests hash differently, so a
 * single organization could only ever elect ONE of them: whichever device
 * advertised the losing manifest was denied claim authorization and became
 * silently unreachable, even while polling and healthy.
 *
 * The contract is therefore endpoint-independent. `platforms` names both hosts
 * because both make the same declared promise; HOW each endpoint satisfies it
 * is that endpoint's private business and deliberately absent here, since
 * anything written down becomes part of the manifest hash and would split the
 * contract again.
 *
 * The action description names both shells because they genuinely differ: the
 * Mac app runs the user's login shell, the headless daemon a bare
 * non-interactive one. That is an environment difference the caller must plan
 * for, not an implementation detail.
 */
export const osShellDeviceConnector: DeviceConnectorSpec = {
  key: "os.shell",
  version: "0.3.1",
  name: "Shell",
  description:
    "Run shell commands on this device through Lobu. Returns structured stdout/stderr/exit_code. Same trust tier as computer use — commands see the device's real filesystem and PATH. On a Mac they run as the signed-in user in that user's environment; on a headless host they run in a minimal environment with no profile and no inherited secrets. Gate with approval.",
  requiredCapability: "os.shell",
  runtime: {
    platforms: ["headless", "macos"],
  },
  authSchema: {
    methods: [
      {
        type: "none",
      },
    ],
  },
  feeds: {},
  actions: {
    run: {
      key: "run",
      kind: "write",
      name: "Run command",
      description:
        "Run a shell command on the device and return stdout, stderr, and exit_code. Pipes, redirects, and && chains work. A Mac endpoint executes through the signed-in user's login shell (`zsh -l -c`), so host-installed CLIs (gh, git, bun, brew, …) resolve via PATH; a headless endpoint executes through `bash --noprofile --norc -c`, which loads no profile or rc file, so prefer absolute paths over aliases there. Prefer one focused command per call over a long script. Destructive/open-world by nature — gate with approval in production.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            minLength: 1,
            maxLength: 20000,
            description:
              "Shell command to execute. Keep commands short and targeted.",
          },
          cwd: {
            type: "string",
            description:
              "Absolute working directory. Defaults to the user's home directory. Must exist.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 100,
            maximum: 150000,
            default: 60000,
            description:
              "Wall-clock budget in milliseconds. On timeout the process gets SIGTERM (3s grace) then SIGKILL. Default 60000, max 150000.",
          },
          stdin: {
            type: "string",
            maxLength: 1000000,
            description: "Optional string piped to the command's stdin.",
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          stdout: {
            type: "string",
          },
          stderr: {
            type: "string",
          },
          exit_code: {
            type: "integer",
          },
          success: {
            type: "boolean",
          },
          timed_out: {
            type: "boolean",
          },
          duration_ms: {
            type: "integer",
          },
        },
      },
    },
  },
};
