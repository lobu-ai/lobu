/**
 * Worker API Endpoints
 *
 * HTTP handlers for worker operations.
 * Updated for V1 integration platform: runs-based job model.
 *
 * This barrel re-exports all handlers from the worker-api/ subdirectory.
 * Routes are registered in packages/server/src/index.ts.
 */

// Polling (device registration + run claiming)
export { pollWorkerJob } from './worker-api/poll';
export { activatePageRun } from './worker-api/page-activation';

// Lanes that own their completion route instead of /api/workers/complete
export { completeAgentTurnRun } from './worker-api/agent-turn';
export { completeDeviceChatRun } from './worker-api/device-chat';

// Run lifecycle (heartbeat, stream, complete, Automation/auth/action/embedding)
export {
  heartbeat,
  streamContent,
  completeWorkerJob,
  completeAutomationRun,
  completeEmbeddings,
  fetchEventsForEmbedding,
  emitAuthArtifact,
  pollAuthSignal,
  completeAuthRun,
  completeActionRun,
} from './worker-api/run-lifecycle';

// UI-facing auth run endpoints (session-auth, not worker-token)
export {
  getActiveAuthRun,
  getAuthRun,
  postAuthSignal,
} from './worker-api/auth-runs';

// Device worker management (mcpAuth, /api/me/devices/*)
export {
  listDeviceWorkers,
  mintDeviceChildToken,
  updateDeviceWorkerOrg,
  deleteDeviceWorker,
} from './worker-api/device-management';

// Device-scoped feed CRUD (/api/workers/me/feeds/*)
export {
  listMyDeviceFeeds,
  createMyDeviceFeed,
  deleteMyDeviceFeed,
} from './worker-api/device-feeds';

// Device Automation trigger (/api/workers/me/automations/:id/trigger)
export { triggerAutomationForDevice } from './worker-api/automation-trigger';
