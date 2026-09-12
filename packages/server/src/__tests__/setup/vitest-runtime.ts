const NODE_VITEST_COMMAND = 'cd packages/server && bun run test -- run <files>';

export function assertNodeVitestRuntime(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  lifecycleEvent: string | undefined = process.env.npm_lifecycle_event
): void {
  // Two triggers, both meaning "this run is not the supported one":
  //   versions.bun         — the vitest process itself is Bun (`bunx --bun
  //                          vitest`, `bun node_modules/.bin/vitest`), which
  //                          does not honour the Node fork-pool contract.
  //   lifecycleEvent bunx  — `bunx vitest`. Today bunx honours vitest's
  //                          `#!/usr/bin/env node` shebang, so versions.bun is
  //                          NOT set and the check above misses it. That
  //                          shebang deference is bunx's choice, not a
  //                          contract: keep this branch even though a bunx run
  //                          currently lands on Node.
  if (!versions.bun && lifecycleEvent !== 'bunx') return;

  throw new Error(
    '@lobu/server Vitest must run under Node: integration files share one Postgres and require a single fork worker.\n' +
      `Use: ${NODE_VITEST_COMMAND}`
  );
}
