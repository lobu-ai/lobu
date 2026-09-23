/**
 * Dry-run a connector's sync method and validate events against eventKinds.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/dry-run-connector.ts <connector-file> [feed-config-json]
 *
 * Example:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/dry-run-connector.ts connectors/reddit.ts '{"subreddit":"lobu","content_type":"post"}'
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { compileConnectorSource, extractConnectorMetadata } from '../../packages/server/src/utils/connector-compiler';

async function main() {
  const [filePath, configJson] = process.argv.slice(2);
  if (!filePath) {
    console.error('Usage: npx tsx scripts/dry-run-connector.ts <connector.ts> [config-json]');
    process.exit(1);
  }

  const absPath = resolve(filePath);
  const name = basename(absPath, '.ts');
  const sourceCode = readFileSync(absPath, 'utf-8');
  const config = configJson ? JSON.parse(configJson) : {};

  console.log(`Compiling ${name}...`);
  const compiled = await compileConnectorSource(sourceCode);
  const metadata = await extractConnectorMetadata(compiled.compiledCode);
  console.log(`Compiled: ${metadata.key}@${metadata.version}`);

  // Extract eventKinds from feeds
  const feeds = metadata.feeds as Record<string, any> | null;
  const feedKeys = feeds ? Object.keys(feeds) : [];
  const feedKey = config.feed_key || feedKeys[0];
  const feedDef = feeds?.[feedKey];
  const eventKinds = feedDef?.eventKinds ?? null;

  console.log(`Feed: ${feedKey}`);
  console.log(`EventKinds: ${eventKinds ? Object.keys(eventKinds).join(', ') : '(none declared)'}`);

  // Dynamically import the compiled code
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const tmpPath = resolve(`.dry-run-${name}.mjs`);
  writeFileSync(tmpPath, compiled.compiledCode, 'utf-8');

  try {
    const mod = await import(`${pathToFileURL(tmpPath).href}?ts=${Date.now()}`);

    // Find the ConnectorRuntime class
    let RuntimeClass: any = null;
    for (const val of Object.values(mod)) {
      if (
        typeof val === 'function' &&
        (val as any).prototype?.sync &&
        (val as any).prototype?.execute
      ) {
        RuntimeClass = val;
        break;
      }
    }
    if (!RuntimeClass && mod.default?.prototype?.sync) {
      RuntimeClass = mod.default;
    }
    if (!RuntimeClass) {
      throw new Error('No ConnectorRuntime class found');
    }

    const instance = new RuntimeClass();

    console.log(`\nRunning sync with config: ${JSON.stringify(config)}...\n`);

    // Nothing is stored: each commit is collected so the run's events and last
    // checkpoint can be printed and validated below.
    const committed: { events: any[]; checkpoint: unknown } = { events: [], checkpoint: null };
    const outcome = await instance.sync({
      feedKey,
      config,
      checkpoint: null,
      credentials: null,
      entityIds: [],
      sessionState: config._sessionState ?? null,
      commit: async (events: any[], checkpoint: unknown) => {
        committed.events.push(...events);
        if (checkpoint !== null) committed.checkpoint = checkpoint;
      },
    });
    const result = { ...outcome, ...committed };

    console.log(`Status: ${result.status}`);
    console.log(`Events: ${result.events.length}`);
    console.log(`Checkpoint: ${JSON.stringify(result.checkpoint)}`);
    if (result.metadata) console.log(`Metadata: ${JSON.stringify(result.metadata)}`);

    // Validate each event against eventKinds
    let validCount = 0;
    let invalidCount = 0;
    const originTypeCounts: Record<string, number> = {};

    for (const event of result.events) {
      const originType = event.origin_type ?? null;
      originTypeCounts[originType || '(none)'] =
        (originTypeCounts[originType || '(none)'] || 0) + 1;

      if (!originType) {
        console.error(`  WARN: Event ${event.origin_id} has no origin_type`);
        invalidCount++;
        continue;
      }

      if (eventKinds) {
        if (!eventKinds[originType]) {
          console.error(
            `  FAIL: Event ${event.origin_id} has invalid origin_type '${originType}'. Valid: ${Object.keys(eventKinds).join(', ')}`
          );
          invalidCount++;
        } else {
          validCount++;
        }
      } else {
        validCount++;
      }
    }

    console.log(`\nOrigin type distribution: ${JSON.stringify(originTypeCounts)}`);
    console.log(`Valid: ${validCount}, Invalid: ${invalidCount}`);

    if (result.events.length > 0) {
      console.log('\nSample event:');
      const sample = result.events[0];
      console.log(
        JSON.stringify(
          {
            origin_id: sample.origin_id,
            origin_type: sample.origin_type,
            semantic_type: sample.semantic_type ?? 'content',
            title: sample.title?.substring(0, 80),
            author_name: sample.author_name,
            score: sample.score,
            metadata: sample.metadata,
          },
          null,
          2
        )
      );
    }

    if (invalidCount > 0) {
      process.exit(1);
    }
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {}
  }

  console.log('\nDry run passed.');
}

main().catch((err) => {
  console.error('Dry run failed:', err.message || err);
  process.exit(1);
});
