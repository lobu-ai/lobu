/**
 * Re-export of the workspace-health helpers now inlined in
 * `issue-tracker.reaction.ts`. The server's reaction compiler requires a
 * single-file source, so the Automation cannot import this module; tests,
 * evals and scripts still can.
 */
export {
  HEALTH_PREFIX,
  type HealthResource,
  type HealthScope,
  healthProblem,
  healthSnapshotSql,
  planHealthChanges,
  readHealthSnapshot,
} from "./issue-tracker.reaction";
