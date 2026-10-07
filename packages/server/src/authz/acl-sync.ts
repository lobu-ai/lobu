/**
 * The ACL sync orchestrator — ONE scheduled tick that re-materializes every
 * registered source's access graph. Each source owns its own fetch (Slack:
 * `conversations.members` over agent-connection-bound channels; GitHub: repo
 * collaborators over connection feeds) because data acquisition is inherently
 * per-source; they all converge on the same `buildAccessGraph` engine + the same
 * `authz_source_acl_state` switch the gates read. Adding a source = add its
 * `run<Source>AclSyncTick` here.
 *
 * Error isolation: a source tick that throws is logged and never aborts the
 * others (each source's per-connection sync is already atomic/fail-closed).
 */

import { createLogger } from '@lobu/core';
import type { CoreServices } from '../gateway/services/core-services.js';
import { runGithubAclSyncTick } from './github-acl-sync.js';
import { runSlackAclSyncTick } from './slack-acl-sync.js';

const logger = createLogger('acl-sync');

export async function runAclSyncTick(coreServices: CoreServices): Promise<void> {
  const sources: Array<{ key: string; run: () => Promise<void> }> = [
    { key: 'slack', run: () => runSlackAclSyncTick(coreServices) },
    { key: 'github', run: runGithubAclSyncTick },
  ];
  for (const source of sources) {
    try {
      await source.run();
    } catch (error) {
      logger.error({ source: source.key, error: String(error) }, 'ACL sync source tick failed');
    }
  }
}
