/**
 * Every production call site on the device access path, pinned.
 *
 * The types already force each one to state the caller's tier
 * (`SourceReadScope.chatAccess`, `DeviceAccessCaller`, a required
 * `ToolContext.sourceContext`). This guard makes a NEW entry point a reviewed
 * change: adding a call to any of these functions fails here until the table
 * below names it and what it passes. Parsed with the TypeScript compiler API,
 * so formatting and comments cannot hide a call.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

const GUARDED = new Set([
  'decideDeviceAccess',
  'chatAccessOfToolContext',
  'sourceReadScopeFromToolContext',
  'readSourceFeed',
  'readSourceFeedPage',
  'readSourceRecordActivity',
  'readSourceRecordLinks',
  'readDeviceFeed',
  'handleAutomationMode',
]);

/** `file -> callee` for every call site, with what each passes for the tier. */
const KNOWN: Record<string, string> = {
  // The rule itself and its two inputs.
  'authz/scope.ts -> chatAccessOfToolContext': 'the ToolContext tier inputs (tokenType, sourceContext)',
  'tools/admin/manage_operations/handlers/execute.ts -> chatAccessOfToolContext': 'the execute ToolContext',
  'tools/admin/manage_operations/handlers/execute.ts -> decideDeviceAccess': 'that tier, for a device-pinned connection',
  'lib/connector-pushdown.ts -> decideDeviceAccess': 'SourceReadScope.chatAccess, for a device-backed feed',
  'lib/connector-pushdown.ts -> readDeviceFeed': 'after the gate above',
  // Tool entry points: the caller's own ToolContext.
  'tools/admin/manage_feeds.ts -> sourceReadScopeFromToolContext': 'read_feeds ToolContext',
  'tools/admin/manage_feeds.ts -> readSourceFeedPage': 'that scope',
  'tools/admin/manage_entity.ts -> sourceReadScopeFromToolContext': 'record links ToolContext',
  'tools/admin/manage_entity.ts -> readSourceRecordLinks': 'that scope',
  'tools/get_content/handler.ts -> sourceReadScopeFromToolContext': 'record activity ToolContext',
  'tools/get_content/handler.ts -> readSourceRecordActivity': 'that scope',
  'tools/get_content/handler.ts -> handleAutomationMode': 'ctx.sourceContext + ctx.tokenType',
  'tools/admin/manage_automations/claim-next-window.ts -> handleAutomationMode': 'ctx.sourceContext + ctx.tokenType',
  'tools/get_content/automation-mode.ts -> sourceReadScopeFromToolContext': 'the required params tier',
  'tools/get_content/automation-mode.ts -> readSourceFeedPage': 'that scope',
  // Internal fan-out: forwards the SourceReadScope it was given.
  'lib/source-feed-page.ts -> readSourceFeed': 'its SourceReadScope',
  'utils/source-record-reads.ts -> readSourceFeedPage': 'its SourceReadScope',
  // System caller: server ingress for a subscribed Automation, no chat turn.
  'gateway/connections/chat-source-ingress.ts -> readSourceFeed': 'chatAccess: null (system)',
};

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function guardedCallSites(): string[] {
  const sites = new Set<string>();
  for (const file of productionFiles(SRC)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        if (name && GUARDED.has(name)) sites.add(`${relative(SRC, file)} -> ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...sites].sort();
}

describe('device access call sites', () => {
  it('are exactly the reviewed set; a new entry point must be added here with what it passes', () => {
    expect(guardedCallSites()).toEqual(Object.keys(KNOWN).sort());
  });
});
