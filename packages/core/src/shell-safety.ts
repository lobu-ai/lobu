/** Fixed shell protections shared by the isolate and remote workspace tools. */
import {
  blankQuotedSpans,
  INTERPRETER_DASH_C,
  matchesBeforeArgumentData,
  splitShellCommands,
} from "./bash-command-parser";

const PACKAGE_MANAGER_DENY_PREFIXES = [
  "apt ",
  "apt-get ",
  "yum ",
  "dnf ",
  "apk ",
  "pacman ",
  "zypper ",
  "brew ",
  "nix-shell ",
  "nix-env ",
  // New-style nix CLI. `nix shell`/`run`/`develop` put arbitrary packages on
  // PATH or fetch-and-execute them and `nix build`/`nix-store` realise arbitrary
  // derivations — the same capability the old-style commands above already
  // denied. A bare `nix ` prefix covers every subcommand (conservative, like
  // `brew `); `nixfmt` and friends keep working because the prefix needs the
  // trailing space. This matcher only recognizes the honestly-typed leading
  // command; what actually contains a package manager differs per backend —
  // see the header on isDirectPackageInstallCommand.
  "nix ",
  "nix-build ",
  "nix-store ",
  "nix-channel ",
  "nix-instantiate ",
  "nix-prefetch-url ",
  "nix-collect-garbage ",
  "nix-copy-closure ",
  // Ad-hoc package runners: fetch-and-run a tool that is not installed.
  // `npx`/`bunx` are absent — they prefer already-installed local binaries.
  "uvx ",
  "uv tool install ",
  "uv tool run ",
  "uv tool upgrade ",
  "uv add ",
  "pipx install ",
  "pipx run ",
  "pipx upgrade ",
  "pipx upgrade-all ",
  "pipx inject ",
  "pipx reinstall ",
  "pipx reinstall-all ",
  "pipx runpip ",
  "pnpm dlx ",
  "yarn dlx ",
  "sudo apt ",
  "sudo apt-get ",
  "sudo yum ",
  "sudo dnf ",
  "sudo apk ",
  "sudo pacman ",
  "sudo zypper ",
  "sudo brew ",
  "sudo nix-shell ",
  "sudo nix-env ",
  "sudo nix ",
  "sudo nix-build ",
  "sudo nix-store ",
  "sudo nix-channel ",
  "sudo nix-instantiate ",
  "sudo nix-prefetch-url ",
  "sudo nix-collect-garbage ",
  "sudo nix-copy-closure ",
  "pip install ",
  "pip3 install ",
  "uv pip install ",
  "npm install ",
  "npm i ",
  "pnpm install ",
  "pnpm add ",
  "yarn install ",
  "yarn add ",
  "bun install ",
  "bun add ",
  "cargo install ",
  "go install ",
  "gem install ",
  "poetry add ",
  "composer require ",
];

const DIRECT_PACKAGE_INSTALL_PATTERNS = [
  /(^|[\s;|&()])(?:sudo\s+)?(?:apt|apt-get|yum|dnf|apk|pacman|zypper|brew)\s+(?:install|upgrade|add)\b/i,
  /(^|[\s;|&()])(?:sudo\s+)?(?:nix-shell|nix-env)\b/i,
  // New-style nix subcommands and the nix-* helpers, recognized after a shell
  // operator or `sudo` (leading forms are already covered by the prefix list).
  /(^|[\s;|&()])(?:sudo\s+)?nix\s+(?:profile|shell|run|develop|build|eval|flake|store|copy|bundle|repl|search|edit|print-dev-env|why-depends|derivation|realisation|registry|upgrade-nix)\b/i,
  /(^|[\s;|&()])(?:sudo\s+)?nix-(?:build|store|channel|instantiate|prefetch-url|collect-garbage|copy-closure)\b/i,
  /(^|[\s;|&()])(?:pip|pip3)\s+install\b/i,
  /(^|[\s;|&()])uv\s+pip\s+install\b/i,
  /(^|[\s;|&()])uv\s+(?:tool\s+(?:install|run|upgrade)|add)\b/i,
  /(^|[\s;|&()])uvx\b/i,
  /(^|[\s;|&()])pipx\s+(?:install|run|upgrade|upgrade-all|inject|reinstall|reinstall-all|runpip)\b/i,
  /(^|[\s;|&()])npm\s+(?:install|i)\b/i,
  /(^|[\s;|&()])pnpm\s+(?:install|add|dlx)\b/i,
  /(^|[\s;|&()])yarn\s+(?:install|add|global\s+add|dlx)\b/i,
  /(^|[\s;|&()])bun\s+(?:install|add)\b/i,
  /(^|[\s;|&()])cargo\s+install\b/i,
  /(^|[\s;|&()])go\s+install\b/i,
  /(^|[\s;|&()])gem\s+install\b/i,
  /(^|[\s;|&()])poetry\s+add\b/i,
  /(^|[\s;|&()])composer\s+require\b/i,
];

/**
 * Longest command this matcher will scan. Past it the command is treated as an
 * install attempt rather than parsed: the scan is superlinear in the command
 * length and the caller does not control the input.
 */
const MAX_SCANNED_COMMAND_LENGTH = 8192;

/**
 * Advisory package-install detector shared by local and remote bash. The local
 * isolate has no package managers registered; this check supplies an actionable
 * error and runs before remote dispatch too. It is conservative text matching,
 * not a shell security boundary: quoted/path-qualified executables and wrappers
 * can evade it. Package availability and remote sandbox policy remain separate.
 */
export function isDirectPackageInstallCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  // The interpreter-body regex backtracks quadratically on adversarial option
  // clusters (`sh -` repeated), and on the isolate lane the model writes this
  // string, so an unbounded scan would block the guest's only thread for
  // seconds. No honest install command is anywhere near this long, and the
  // matcher's documented bias is to fail toward flagging.
  if (trimmed.length > MAX_SCANNED_COMMAND_LENGTH) {
    return true;
  }

  // Keep the platform's fixed prefix guard on every shell segment; this was
  // previously transported in each turn's configurable bash policy.
  if (
    splitShellCommands(command).some((segment) =>
      PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
        segment.toLowerCase().startsWith(prefix.toLowerCase())
      )
    )
  )
    return true;

  const matches = (text: string): boolean =>
    PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
      text.startsWith(prefix.toLowerCase())
    ) || DIRECT_PACKAGE_INSTALL_PATTERNS.some((pattern) => pattern.test(text));

  // Scan the command with quoted DATA blanked out and each data word's operands
  // dropped, so a manager merely NAMED cannot match. Both scrubs are advisory
  // and fail toward flagging: whatever they cannot prove to be data is matched.
  if (matchesBeforeArgumentData(blankQuotedSpans(trimmed), matches)) {
    return true;
  }

  // Then scan `sh -c '…'` bodies, where the quoted text IS a command.
  INTERPRETER_DASH_C.lastIndex = 0;
  for (const m of trimmed.matchAll(INTERPRETER_DASH_C)) {
    const body = m[2]?.trim();
    if (body && matchesBeforeArgumentData(blankQuotedSpans(body), matches)) {
      return true;
    }
  }

  return false;
}
