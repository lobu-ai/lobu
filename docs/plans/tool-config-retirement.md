# Retire agent tool configuration

Status: implementation authorized. One PR concern: retire the configuration end to end.

## Locked target

Ordinary agents receive standard runtime and discovered integration tools. Existing membership, source ACL, resource policy, connector Auto/Ask/Block, conversation authorization, sandbox and credential boundaries continue to govern execution. Those boundaries do not reproduce every former tool-name restriction. The owner accepted standard capabilities for the one configured production agent; its stored setting was cleared through the existing settings API.

Delete `Agent.tools`, `ToolsConfig`, `allowedTools`/`disallowedTools` agent options, the two gateway environment settings, producer name filtering, and configurable bash prefix policy transport/enforcement. Keep model function schemas, device CLI contracts, concrete worker tool manifests and fixed package-install protection.

Files: CLI authoring/apply/export; core settings and worker contracts; gateway config/stores/producer; isolate worker workspace; the two owning examples; focused tests and a generic cutover assertion. No new endpoint, table, column, UI control or permission class.

Shipping code is net negative. The fixed shell checks move to `shell-safety.ts`; tests can grow.

## Evaluation correction

The earlier direct-provider evaluation proposal was rejected. The context-layer example removes its deployed baseline agent and live-model quality comparison. Its demo is explicitly deterministic. An example-owned fixture drives both arms through the real exported isolate bundle and executor with synthetic provider responses, no tools, no memory and fresh sessions. It tests isolation and runtime execution, not live-model quality.

## Cutover

The generic migration and read-only precondition refuse nonempty stored configuration and active agent turns carrying the removed bash policy. No tenant IDs or automatic clearing belong in migration code. The deploy uses the existing quiesced upgrade. New CLI/API/runtime inputs reject retired settings explicitly.

The unused `agents.tools_config` column remains through this release. Drop it in a separate release only after every reader/worker has moved; the repository mandates two-phase column removal. Historical events and approved run inputs remain unchanged.

## Acceptance

- Old authored settings, API patches and gateway environment inputs fail visibly.
- Ordinary, scheduled and event turns keep standard/discovered tools; Automation required-tool discovery checks remain.
- Fixed local/remote package-install guards and workspace isolation pass.
- Actual authorization/dispatch and conversation authorization tests pass.
- Evaluation isolation fails under deliberate session leakage and passes with fresh sessions.
- Cutover refuses stored restrictions and pending/claimed/running legacy turns, preserving their data.
- Focused tests, pre-pr, review-fix, CI and review gates pass; show the final diff at the shipping checkpoint.

## Out of scope

Universal permission redesign, new policy categories, UI work, memory freshness, provider empty-stream error handling, and live-model quality evaluation. Column deletion follows rollout as the next release slice.
