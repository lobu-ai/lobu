# Changelog

## [19.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v19.1.0...lobu-v19.2.0) (2026-09-07)


### Features

* **agent-turn:** deliver the isolate lane's reply and transcript ([#3386](https://github.com/lobu-ai/lobu/issues/3386)) ([e35ae6b](https://github.com/lobu-ai/lobu/commit/e35ae6b4af43ea7c6c9ff599915a47a6ee5d2907))
* **agent-turn:** run the workspace tools inside the isolate ([#3384](https://github.com/lobu-ai/lobu/issues/3384)) ([bfa28f3](https://github.com/lobu-ai/lobu/commit/bfa28f396a455320209e8929777bdab1be314ce3))


### Bug Fixes

* **agent-turn:** deliver the timeout when a fleet worker dies mid-turn ([#3390](https://github.com/lobu-ai/lobu/issues/3390)) ([54485ec](https://github.com/lobu-ai/lobu/commit/54485ec85fb475b82300f8e33397cea0a3c4f2fb))
* **auth:** block deleting a user's personal organization ([#3398](https://github.com/lobu-ai/lobu/issues/3398)) ([667d000](https://github.com/lobu-ai/lobu/commit/667d000d21e831154be3b3c634a83925e6954e0c))
* **connectors:** let a cold WhatsApp tab finish hydrating ([#3387](https://github.com/lobu-ai/lobu/issues/3387)) ([624091f](https://github.com/lobu-ai/lobu/commit/624091fb1fc19b9d9d6576a45dc8c68240c98504))
* **linkedin:** isolate live feeds from filesystem takeout code ([#3393](https://github.com/lobu-ai/lobu/issues/3393)) ([c733d2e](https://github.com/lobu-ai/lobu/commit/c733d2e0e8e65b44c700078a4b503af83cbd653d))
* **sdk:** report enforced access tiers and normalize connector arguments ([#3391](https://github.com/lobu-ai/lobu/issues/3391)) ([8f7c405](https://github.com/lobu-ai/lobu/commit/8f7c405d136c47a2a39f8bbcb2ce64bbe04693b3))

## [19.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v19.0.0...lobu-v19.1.0) (2026-09-06)


### Features

* **agent-turn:** call the agent's MCP tools from the isolate lane ([#3383](https://github.com/lobu-ai/lobu/issues/3383)) ([c87afc0](https://github.com/lobu-ai/lobu/commit/c87afc0247959e92d11e9ea56a3863add895f9e5))


### Bug Fixes

* **ci:** stream the CI run list into jq instead of through argv ([#3380](https://github.com/lobu-ai/lobu/issues/3380)) ([f7392ca](https://github.com/lobu-ai/lobu/commit/f7392ca3122d561c4d495ec746626149bde99682))
* **connectors:** stop the WhatsApp collect budget racing the run fence ([#3382](https://github.com/lobu-ai/lobu/issues/3382)) ([9242f3b](https://github.com/lobu-ai/lobu/commit/9242f3b146864cf6893abf9dcf3dbca5d64d8ef6))

## [19.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v18.0.0...lobu-v19.0.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* **automations:** `@lobu/connector-sdk` removes `ReactionContext.window.granularity` and the twelve `automation-time` exports (`AUTOMATION_TIME_GRANULARITIES`, `AutomationTimeGranularity`, `addAutomationPeriod`, `subtractAutomationPeriod`, `shiftAutomationPeriod`, `alignToAutomationWindowStart`, `getAutomationDateTruncUnit`, `getAvailableAutomationGranularities`, `getFinerAutomationGranularities`, `getNextAutomationGranularity`, `inferAutomationGranularityFromDays`, `inferAutomationGranularityFromSchedule`, `isAutomationTimeGranularity`). Automation windows are arrival ranges on `events.created_at` and have no calendar period to describe. A reaction reads `window_start`/`window_end`.
* **automations:** rename agent_id to managed_agent_id and forbid the empty string ([#3319](https://github.com/lobu-ai/lobu/issues/3319))

### Features

* **automations:** window Automations on arrival, not occurrence ([#3334](https://github.com/lobu-ai/lobu/issues/3334)) ([3382b31](https://github.com/lobu-ai/lobu/commit/3382b31b10c8cf349d8ccd5180342f7e577fa15a))
* **cli:** display action approval management link on daemon startup ([#3351](https://github.com/lobu-ai/lobu/issues/3351)) ([642e49b](https://github.com/lobu-ai/lobu/commit/642e49b8e50a29f1a3f8f4d3c981f72060c2b516))
* **connector-worker:** consolidate connector execution onto isolate sandbox with direct sockets ([#3337](https://github.com/lobu-ai/lobu/issues/3337)) ([952c046](https://github.com/lobu-ai/lobu/commit/952c0467b5c2b936999fbd281502c388d2848f8a))
* **connector-worker:** hand the isolate guest a credential placeholder, not the OAuth token ([#3374](https://github.com/lobu-ai/lobu/issues/3374)) ([17ce19a](https://github.com/lobu-ai/lobu/commit/17ce19a031d5f420be7b5343b4900bbdb2f90e2e))
* **connector-worker:** stream fetch bodies to the isolate guest chunk by chunk ([#3372](https://github.com/lobu-ai/lobu/issues/3372)) ([6365b83](https://github.com/lobu-ai/lobu/commit/6365b83c8974e3caa1d8dc50e92f36571b76d914))
* **connectors:** add a Google Drive connector with a resumable bootstrap ([#3347](https://github.com/lobu-ai/lobu/issues/3347)) ([820888b](https://github.com/lobu-ai/lobu/commit/820888b02dd9f05f071d9d310a78d912e77bc06d))
* **device-connectors:** give os.shell one contract both endpoints can claim ([#3375](https://github.com/lobu-ai/lobu/issues/3375)) ([02268d2](https://github.com/lobu-ai/lobu/commit/02268d2ef314025d627c12b7a1015ec6e19f8e9c))
* Mac workspace chooser, Recent, and command-palette search ([#3339](https://github.com/lobu-ai/lobu/issues/3339)) ([82aeaad](https://github.com/lobu-ai/lobu/commit/82aeaada5d0b31e4a9f7582ae6a24c65af48693a))
* **owletto:** bump submodule for activity sessions switcher and simplified top nav ([#3353](https://github.com/lobu-ai/lobu/issues/3353)) ([5f7a86a](https://github.com/lobu-ai/lobu/commit/5f7a86ab0030fb222fd3b67e76f38b77ce1ba9e1))
* **server:** make empty search results explain themselves honestly ([#3340](https://github.com/lobu-ai/lobu/issues/3340)) ([bf4096a](https://github.com/lobu-ai/lobu/commit/bf4096a7cccb53ed650de999747df4eba4c7fab1))


### Bug Fixes

* **automations:** recover expired external trigger claims ([#3357](https://github.com/lobu-ai/lobu/issues/3357)) ([f81a6cc](https://github.com/lobu-ai/lobu/commit/f81a6cc983c916a201c48a85a8d3c95cd29a3812))
* **ci:** attest release commits reachable from main, not only the tip ([#3332](https://github.com/lobu-ai/lobu/issues/3332)) ([5bb4a7b](https://github.com/lobu-ai/lobu/commit/5bb4a7bf30788039d1d89d5f4122a8a99d3d21f6))
* **ci:** clear the pending label from a released PR so the next release opens ([#3376](https://github.com/lobu-ai/lobu/issues/3376)) ([8a3e0bf](https://github.com/lobu-ai/lobu/commit/8a3e0bf293d0bcacfa83b5510fef24e366664c8b))
* **ci:** let the prod smoke wait out the rollout it is verifying ([#3317](https://github.com/lobu-ai/lobu/issues/3317)) ([6f88008](https://github.com/lobu-ai/lobu/commit/6f8800823dfe07bbc69456576465f24d43f6bc8a))
* **ci:** pipe paginated API payloads into jq instead of passing them as args ([#3323](https://github.com/lobu-ai/lobu/issues/3323)) ([a2f21e8](https://github.com/lobu-ai/lobu/commit/a2f21e881bfefd3451baf0d0b64d074f91020968))
* **ci:** pipe the attested jobs payload into jq in publish-packages ([#3324](https://github.com/lobu-ai/lobu/issues/3324)) ([a64a4cb](https://github.com/lobu-ai/lobu/commit/a64a4cbc80d7e9963c71bc005b620d3afb71ae82))
* **ci:** stop a merge behind a release PR stranding the release forever ([#3320](https://github.com/lobu-ai/lobu/issues/3320)) ([04e4f57](https://github.com/lobu-ai/lobu/commit/04e4f575f7c1d40d2ad41d3173a4705439d70d07))
* **ci:** wait out registry propagation in the published-artifact smoke ([#3325](https://github.com/lobu-ai/lobu/issues/3325)) ([35eb4de](https://github.com/lobu-ai/lobu/commit/35eb4deb972b5a7a39750abec324ef922c6111a3))
* **cli:** stop apply silently clearing a feed cron it was never told about ([#3346](https://github.com/lobu-ai/lobu/issues/3346)) ([6486b04](https://github.com/lobu-ai/lobu/commit/6486b04be7e572b9a655a3fc6da4283776f8366a))
* **connector-worker:** preserve shell supervisor failures ([#3355](https://github.com/lobu-ai/lobu/issues/3355)) ([6b30efd](https://github.com/lobu-ai/lobu/commit/6b30efdd6142b072c2b8e9190ebcc0a1cee378e3))
* **connector-worker:** resolve the pre-upgrade socket closed on startTls so postgres.js TLS handshakes complete ([#3367](https://github.com/lobu-ai/lobu/issues/3367)) ([52a404e](https://github.com/lobu-ai/lobu/commit/52a404eb43342248a7f2a60ff657224262411dbf))
* **connectors:** preserve feeds across transient browser failures ([#3358](https://github.com/lobu-ai/lobu/issues/3358)) ([988f18e](https://github.com/lobu-ai/lobu/commit/988f18e8fcefe10ccdd683b608fcc95c6c814b66))
* **entities:** resolve unlink/update_link from the relationship triple ([#3352](https://github.com/lobu-ai/lobu/issues/3352)) ([260cfc9](https://github.com/lobu-ai/lobu/commit/260cfc9c0788a95b1825c74fe588f544ec1638c1))
* **feeds:** name the feed that has no way to be dispatched ([#3338](https://github.com/lobu-ai/lobu/issues/3338)) ([ada329c](https://github.com/lobu-ai/lobu/commit/ada329c40dda89464bedc7489bc46db6e1e40084))
* **personal-agent:** declare the cadence apply would otherwise strip ([#3350](https://github.com/lobu-ai/lobu/issues/3350)) ([07a88d0](https://github.com/lobu-ai/lobu/commit/07a88d082ad473f3f92fd1087af2d66c52ba5a88))
* **sdk:** derive the knowledge input types from one shared contract ([#3349](https://github.com/lobu-ai/lobu/issues/3349)) ([b761420](https://github.com/lobu-ai/lobu/commit/b761420854d473d5a2b4a9c949db1c6e669bb2cc))
* **sdk:** entities.create forwards every contract field; `type` is an alias ([#3360](https://github.com/lobu-ai/lobu/issues/3360)) ([5493e8b](https://github.com/lobu-ai/lobu/commit/5493e8bd225eb93fe6b858e80e91015fb7930472))
* **server:** honor explicit device action timeouts ([#3373](https://github.com/lobu-ai/lobu/issues/3373)) ([c3fbf34](https://github.com/lobu-ai/lobu/commit/c3fbf34a1ae349e0fa8f684210f3dbf8dd1c8a9b))
* **server:** let an external claimant complete the window it claimed ([#3345](https://github.com/lobu-ai/lobu/issues/3345)) ([eae673a](https://github.com/lobu-ai/lobu/commit/eae673afe81a0526c546f3a7fad56568272b70ed))
* **server:** make the empty-search guidance's promises true ([#3343](https://github.com/lobu-ai/lobu/issues/3343)) ([ee1a463](https://github.com/lobu-ai/lobu/commit/ee1a4638218577d80535ff3699e6a4a53f7d0c3e))
* **server:** release a device pin only if the reaper deletes that device ([#3330](https://github.com/lobu-ai/lobu/issues/3330)) ([f1cc157](https://github.com/lobu-ai/lobu/commit/f1cc157e0f2b2a8954d610664281a911a34bc916))
* **server:** stop an archived Automation anchoring a dead device forever ([#3322](https://github.com/lobu-ai/lobu/issues/3322)) ([7fc8550](https://github.com/lobu-ai/lobu/commit/7fc855042476a43687628415dbc91708467903f7))
* **spotify:** stop three snapshot feeds rewriting rows that never changed ([#3344](https://github.com/lobu-ai/lobu/issues/3344)) ([c13a095](https://github.com/lobu-ai/lobu/commit/c13a0957e091d56d97f0dabe255968b3d5c570f0))


### Code Refactoring

* **automations:** rename agent_id to managed_agent_id and forbid the empty string ([#3319](https://github.com/lobu-ai/lobu/issues/3319)) ([7a2228a](https://github.com/lobu-ai/lobu/commit/7a2228a80db66adc0ae5e9652d5772e2d7952011))

## [18.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v17.2.0...lobu-v18.0.0) (2026-09-03)


### ⚠ BREAKING CHANGES

* **connector-sdk:** @lobu/connector-sdk's root no longer exports the browser SDK (acquireBrowser, launchBrowser, runReviewScrape, CdpPage, resolveCdpUrl, fetchCdpVersionInfo, browserNetworkSync, ...), the FileSystemSource implementations (GitFileSource, TarballFileSource, LocalFileSource, fileSystemSourceFromUri) or deviceManifestHash. Import them from @lobu/connector-sdk/browser, @lobu/connector-sdk/sources and @lobu/connector-sdk/device-manifest-hash. Compiled connector bundles that imported one of these from the root need a re-run of `lobu apply`.
* **server:** `EGRESS_JUDGE_MODEL` and any per-rule `judgeModel` must now be a `<provider>/<model>` ref whose provider has a deployment system key set in the environment and speaks the OpenAI-compatible protocol. A bare model id (`gpt-4o-mini`) or an Anthropic-protocol ref (`claude/...`) is unresolvable and the judge FAILS CLOSED, denying every judged egress request. Repoint at an eligible provider, e.g. `openai/gpt-4o-mini`. The boot preflight logs the resolution outcome and is deliberately non-fatal, so a deployment that only reads denials will not see the cause until it reads the log.
* **server:** migrate the judges off the Anthropic SDK onto the gateway client ([#3277](https://github.com/lobu-ai/lobu/issues/3277))

### Features

* **connector-sdk:** make the SDK root loadable in a V8 isolate ([#3294](https://github.com/lobu-ai/lobu/issues/3294)) ([495cf61](https://github.com/lobu-ai/lobu/commit/495cf61ddf850dd5bbd767eb9aeac7dced78bf2a))
* **connector-worker:** isolate executor for pure-JS connectors ([#3303](https://github.com/lobu-ai/lobu/issues/3303)) ([5cfcffa](https://github.com/lobu-ai/lobu/commit/5cfcffa9d11819e64e38e96fa7ec3ffefdde491c))
* **connector-worker:** run the worker image under Node so the isolate lane can load ([#3314](https://github.com/lobu-ai/lobu/issues/3314)) ([f052859](https://github.com/lobu-ai/lobu/commit/f05285995731616b00e9f92264092a81c9736bf6))
* **device-connectors:** Meeting Audio captures your own voice, and ships what it records ([#3312](https://github.com/lobu-ai/lobu/issues/3312)) ([a218ad2](https://github.com/lobu-ai/lobu/commit/a218ad25dc8f2ccf34b27673dda6c579a16e1dec))
* expose generic webhook automation event ([#3242](https://github.com/lobu-ai/lobu/issues/3242)) ([a657ccf](https://github.com/lobu-ai/lobu/commit/a657ccf8345ec0e4e4c574a560f182b9b2a18def))
* **gateway:** warn at boot when an unrestricted allowlist makes every egress judge inert ([#3309](https://github.com/lobu-ai/lobu/issues/3309)) ([9539e1b](https://github.com/lobu-ai/lobu/commit/9539e1b8afb56d6f8f66457a808bcf25416ca792))
* **oauth:** consolidate authorization review grants ([#3240](https://github.com/lobu-ai/lobu/issues/3240)) ([f7c03c5](https://github.com/lobu-ai/lobu/commit/f7c03c5f00f39d765762fbfc08c1dd9f39c6a10a))
* prepare generic webhook event activation ([#3238](https://github.com/lobu-ai/lobu/issues/3238)) ([c10f761](https://github.com/lobu-ai/lobu/commit/c10f761e84993b78d499603cb186be28d155b4b2))
* **sandbox:** public dev previews with the seat claimed and worker auth closed ([#3279](https://github.com/lobu-ai/lobu/issues/3279)) ([a24c090](https://github.com/lobu-ai/lobu/commit/a24c090f4f4330f3b2917ec3a4df926ce0f54e82))
* **sandbox:** surface and remove sandboxes that outlived their worktree ([#3287](https://github.com/lobu-ai/lobu/issues/3287)) ([85401bf](https://github.com/lobu-ai/lobu/commit/85401bf1e40a7571f02b684752fb60e738be6f5a))
* **worker:** execute os.shell as a daemon builtin and gate claims on backend capacity ([#3259](https://github.com/lobu-ai/lobu/issues/3259)) ([1ba8123](https://github.com/lobu-ai/lobu/commit/1ba81232ae5a30c0328217b111e7ab8ceac64072))


### Bug Fixes

* **agent-worker:** preserve durable turn delivery ([#3251](https://github.com/lobu-ai/lobu/issues/3251)) ([bb78e89](https://github.com/lobu-ai/lobu/commit/bb78e89fe1454df7c38613b2703998a1ca5f5189))
* **api:** harden pagination contracts and metadata ([#3237](https://github.com/lobu-ai/lobu/issues/3237)) ([6db0f8d](https://github.com/lobu-ai/lobu/commit/6db0f8d958dce51efe70e441465375ff4e094a4f))
* **authz:** stop marking consent-only GitHub connections ACL-failed ([#3258](https://github.com/lobu-ai/lobu/issues/3258)) ([ada2080](https://github.com/lobu-ai/lobu/commit/ada2080cd62d269f18ce367e24b84b81d6221363))
* **chart:** minimize embeddings secret projection ([#3252](https://github.com/lobu-ai/lobu/issues/3252)) ([73aae4e](https://github.com/lobu-ai/lobu/commit/73aae4ee491ed5aa0e5118bcaba15088617f9329))
* **ci:** gate releases on image provenance ([#3247](https://github.com/lobu-ai/lobu/issues/3247)) ([2620057](https://github.com/lobu-ai/lobu/commit/2620057f56d8a9367d0bb71b390fae54872ef102))
* **cli:** make E2E cleanup portable ([#3232](https://github.com/lobu-ai/lobu/issues/3232)) ([3bafcb5](https://github.com/lobu-ai/lobu/commit/3bafcb56a0c6750a415a0fd10141ebc31409f7fe))
* **cloud-gate:** admit an image-shipped connector shadowed by an org row ([#3285](https://github.com/lobu-ai/lobu/issues/3285)) ([6e8b110](https://github.com/lobu-ai/lobu/commit/6e8b110504b7b17f6d64f54daad46bf4ba44ee11))
* **connector-worker:** stage runtime dependencies safely ([#3234](https://github.com/lobu-ai/lobu/issues/3234)) ([b73055b](https://github.com/lobu-ai/lobu/commit/b73055bea3272fc420d9c58495c98f7520406fe2))
* **connector-worker:** verify runtime before claiming work ([#3233](https://github.com/lobu-ai/lobu/issues/3233)) ([2082b4a](https://github.com/lobu-ai/lobu/commit/2082b4a4077366d6ac87f12fb6e1ca462156e522))
* **connectors:** bound os.shell process-group cleanup ([#3229](https://github.com/lobu-ai/lobu/issues/3229)) ([28c014b](https://github.com/lobu-ai/lobu/commit/28c014b62892931dcf34581c9757c13171c14508))
* **connectors:** keep a WhatsApp thumbnail out of payload_text ([#3298](https://github.com/lobu-ai/lobu/issues/3298)) ([40b0540](https://github.com/lobu-ai/lobu/commit/40b05408a53e64946ce919dfa1f915b82efbf313))
* **connectors:** reject a reserved chrome.* connector key that ships its own code ([#3273](https://github.com/lobu-ai/lobu/issues/3273)) ([ab5c301](https://github.com/lobu-ai/lobu/commit/ab5c301f1f42e395f4fbd9302e186af1cc94a0e7))
* **core:** accept parent Automation run on live worker tokens ([#3257](https://github.com/lobu-ai/lobu/issues/3257)) ([2e37817](https://github.com/lobu-ai/lobu/commit/2e3781746e539210a19d170460e545276a1e6528))
* **core:** scrub credentials from agent-worker Sentry events too ([#3261](https://github.com/lobu-ai/lobu/issues/3261)) ([40db6c8](https://github.com/lobu-ai/lobu/commit/40db6c86e8a99493870cb4baa19a4df4060c510c))
* **deps:** bump undici to 7.29.0 across the workspace, with the lockfile ([#3286](https://github.com/lobu-ai/lobu/issues/3286)) ([4f5ea6b](https://github.com/lobu-ai/lobu/commit/4f5ea6b6f5cb9ff4e72d80ad59829480b443d722))
* **devices:** enforce target and executed device routing invariants ([#3315](https://github.com/lobu-ai/lobu/issues/3315)) ([da5c47a](https://github.com/lobu-ai/lobu/commit/da5c47afd08f55050dbdcd44d5bbc10fda8f3ae6))
* **gateway:** never grant an allow for a domain the egress judge governs ([#3300](https://github.com/lobu-ai/lobu/issues/3300)) ([4f5b0f5](https://github.com/lobu-ai/lobu/commit/4f5b0f583e0ae2138851ae50d713c1676ac502ea))
* **gateway:** prefer a healthy provider over an exhausted one at dispatch ([#3308](https://github.com/lobu-ai/lobu/issues/3308)) ([cb74675](https://github.com/lobu-ai/lobu/commit/cb74675a7a152e8995950fb7f704601b10800431))
* **gateway:** refuse an allow grant for a judged domain at the GrantStore chokepoint ([#3304](https://github.com/lobu-ai/lobu/issues/3304)) ([b4cee9f](https://github.com/lobu-ai/lobu/commit/b4cee9f01e27a74e1d915fe11f17c29f0daf7b21))
* **gateway:** reject an egress guardrail whose judged domain an allow grant shadows ([#3299](https://github.com/lobu-ai/lobu/issues/3299)) ([62ddf47](https://github.com/lobu-ai/lobu/commit/62ddf476fa2b344514550d45d4f81c9fcbc5bc83))
* **gateway:** stop a provider-failed turn from renewing its own liveness deadline ([#3313](https://github.com/lobu-ai/lobu/issues/3313)) ([399bfc4](https://github.com/lobu-ai/lobu/commit/399bfc4a2938b4e296dfb9f24695bdafc9e6eeb0))
* **gateway:** stop a reasoning model's judge verdict being truncated ([#3293](https://github.com/lobu-ai/lobu/issues/3293)) ([f6c79f3](https://github.com/lobu-ai/lobu/commit/f6c79f350121ed6c9e158da5ddb3c36dc8e275fb))
* **mcp:** isolate direct client instructions ([#3297](https://github.com/lobu-ai/lobu/issues/3297)) ([5d152ca](https://github.com/lobu-ai/lobu/commit/5d152caac1c9fa8803c0c3ae6a7dddcfe97b9d66))
* **naming:** stop the canonical-vocabulary gate from renaming Chrome APIs ([#3265](https://github.com/lobu-ai/lobu/issues/3265)) ([ec19023](https://github.com/lobu-ai/lobu/commit/ec190238cc1853b2016cf1ac61017c56490966cd))
* **queue:** keep one worker per queue and fence claims against shutdown ([#3255](https://github.com/lobu-ai/lobu/issues/3255)) ([41f6b9a](https://github.com/lobu-ai/lobu/commit/41f6b9af4b54b5be54152797e9caae0aa4c65e1f))
* **sandbox:** accept the API-key credential shape the daytona CLI writes ([#3271](https://github.com/lobu-ai/lobu/issues/3271)) ([5e1bada](https://github.com/lobu-ai/lobu/commit/5e1bada7da800d0ae91edcef6d44609029237a6c))
* **scripts:** sign lobu-device-daemon with JIT entitlements under Hardened Runtime ([#3307](https://github.com/lobu-ai/lobu/issues/3307)) ([d505471](https://github.com/lobu-ai/lobu/commit/d505471a16fbdc5c0e1e94e670c620c082139d69))
* **security:** harden connector-controlled egress ([#3236](https://github.com/lobu-ai/lobu/issues/3236)) ([4d38b6c](https://github.com/lobu-ai/lobu/commit/4d38b6c36be5f607c3be666d76478a76e8b43fb5))
* **server:** cap the wall-clock budget of a connection pushdown ([#3302](https://github.com/lobu-ai/lobu/issues/3302)) ([3471bea](https://github.com/lobu-ai/lobu/commit/3471beaecf74dbf735941d6347cc3177ff07ffab))
* **server:** claim connectorless embedding backfills ([#3245](https://github.com/lobu-ai/lobu/issues/3245)) ([f7591d2](https://github.com/lobu-ai/lobu/commit/f7591d2db8998043ee37b2d2fd51026ad605fb92))
* **server:** deny custom connector code in cloud ([#3246](https://github.com/lobu-ai/lobu/issues/3246)) ([8ecb49d](https://github.com/lobu-ai/lobu/commit/8ecb49d7f097a6b911a65030cafde1d7fb794254))
* **server:** fence inline operation run leases ([#3249](https://github.com/lobu-ai/lobu/issues/3249)) ([37f01ae](https://github.com/lobu-ai/lobu/commit/37f01ae7e1cdfd3df39d52e47b348a4702fa4c37))
* **server:** harden SDK script errors ([#3239](https://github.com/lobu-ai/lobu/issues/3239)) ([b5c60aa](https://github.com/lobu-ai/lobu/commit/b5c60aa81ab504ef49cd71cd23fc3c660171ce7d))
* **server:** name the remedy in Cloud connector denials ([#3281](https://github.com/lobu-ai/lobu/issues/3281)) ([630dd21](https://github.com/lobu-ai/lobu/commit/630dd21a304949e5dc60494a1b440fd7299597ee))
* **server:** narrow Vite fs.allow to the trees the SPA loads from ([#3284](https://github.com/lobu-ai/lobu/issues/3284)) ([0405236](https://github.com/lobu-ai/lobu/commit/0405236ec2cdf081db40c5cea5b60879b1658a52))
* **server:** redact credentials from Sentry events ([#3253](https://github.com/lobu-ai/lobu/issues/3253)) ([6569c03](https://github.com/lobu-ai/lobu/commit/6569c0342f8c8f894e93c056c4feea8729571e87))
* **server:** repair cross-replica authorization revocation ([#3250](https://github.com/lobu-ai/lobu/issues/3250)) ([94c5bea](https://github.com/lobu-ai/lobu/commit/94c5beacd40ed68f90fc3a67451e2bc2b53a95de))
* **server:** resolve a derived row's slug in SQL instead of paging the view ([#3301](https://github.com/lobu-ai/lobu/issues/3301)) ([bc106ec](https://github.com/lobu-ai/lobu/commit/bc106ec8d1cf47f99ca53209c504a1e504b5a7c1))
* **server:** stop /@fs/ serving live state from the dev server ([#3282](https://github.com/lobu-ai/lobu/issues/3282)) ([c4336dd](https://github.com/lobu-ai/lobu/commit/c4336dd551481b9c365ab1faee6d924dd4aab027))
* **server:** surface an STT provider outage instead of dropping the job ([#3310](https://github.com/lobu-ai/lobu/issues/3310)) ([63c559b](https://github.com/lobu-ai/lobu/commit/63c559b520ffbd8e19efc172db77f9c5cf18da98))
* **worker:** stop an orphaned chrome-dispatch reply from killing the worker ([#3288](https://github.com/lobu-ai/lobu/issues/3288)) ([84578ae](https://github.com/lobu-ai/lobu/commit/84578aee4abed6412a893fdeca59382fed38c94c))


### Documentation

* **server:** document the judged-egress model contract for operators ([#3290](https://github.com/lobu-ai/lobu/issues/3290)) ([35e8d53](https://github.com/lobu-ai/lobu/commit/35e8d5350d973922ad93b30b324233aefcb587c0))


### Code Refactoring

* **server:** migrate the judges off the Anthropic SDK onto the gateway client ([#3277](https://github.com/lobu-ai/lobu/issues/3277)) ([ba6967f](https://github.com/lobu-ai/lobu/commit/ba6967fdf59476853917a0e2084f28e926b6ee11))

## [17.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v17.1.0...lobu-v17.2.0) (2026-08-29)


### Features

* add portable template event actions ([#3174](https://github.com/lobu-ai/lobu/issues/3174)) ([0ad36c1](https://github.com/lobu-ai/lobu/commit/0ad36c1ce9730bc32c5e5066366fc1c8565ff6c0))
* **chat:** add event-backed polls ([#3215](https://github.com/lobu-ai/lobu/issues/3215)) ([2b37d9e](https://github.com/lobu-ai/lobu/commit/2b37d9e7b330cd28a8ccd9709e0022685eb24b7d))
* **content:** bound agent-facing event reads ([#3197](https://github.com/lobu-ai/lobu/issues/3197)) ([2ba9641](https://github.com/lobu-ai/lobu/commit/2ba9641d9687994d278e70111f5b65f578fa6865))
* **identity:** scope identities by upstream tenant ([#3217](https://github.com/lobu-ai/lobu/issues/3217)) ([96ff93e](https://github.com/lobu-ai/lobu/commit/96ff93e7c9a8b5e1a4081cc7c283cc0b75c2a059))
* run Activity chat on selected devices ([#3184](https://github.com/lobu-ai/lobu/issues/3184)) ([568ae61](https://github.com/lobu-ai/lobu/commit/568ae61508351e36946911a11833a9db5e572a43))
* **server:** add explicit MCP workspace grants ([#3191](https://github.com/lobu-ai/lobu/issues/3191)) ([8fcdc31](https://github.com/lobu-ai/lobu/commit/8fcdc311a73bd13db69da9d5c25244d46c6309ec))
* **server:** materialize connector-declared edges ([#3209](https://github.com/lobu-ai/lobu/issues/3209)) ([2cd21cd](https://github.com/lobu-ai/lobu/commit/2cd21cdd38eb82fdda3c79a574706eb6bea0a99e))
* **server:** persist durable entity denial audits ([#3208](https://github.com/lobu-ai/lobu/issues/3208)) ([5385d2d](https://github.com/lobu-ai/lobu/commit/5385d2d8e6cd81bc265d1bdef08c4f9276a14314))


### Bug Fixes

* **auth:** reject worker tokens off MCP routes ([#3182](https://github.com/lobu-ai/lobu/issues/3182)) ([b76f7bc](https://github.com/lobu-ai/lobu/commit/b76f7bcc471b0497a2d60758ac3df56296b1f358))
* auto-pause repeatedly failing automations ([#3200](https://github.com/lobu-ai/lobu/issues/3200)) ([5aadc42](https://github.com/lobu-ai/lobu/commit/5aadc4268f9f71936811e26e8bc5e50183d0a419))
* **automations:** encode poll response slugs ([#3225](https://github.com/lobu-ai/lobu/issues/3225)) ([d48e3cd](https://github.com/lobu-ai/lobu/commit/d48e3cd54585cb12f1f9df2895ad01b88af67f84))
* **automations:** make reactions crash-safe through TaskScheduler ([#3219](https://github.com/lobu-ai/lobu/issues/3219)) ([45587eb](https://github.com/lobu-ai/lobu/commit/45587eb6270488e54f4c8b8189bdc4a85c37e5b4))
* **automations:** normalize run-bound poll entity ids ([#3222](https://github.com/lobu-ai/lobu/issues/3222)) ([68b9164](https://github.com/lobu-ai/lobu/commit/68b91643ae841e126470bb27d689bee704add906))
* **automations:** query the durable poll head ([#3223](https://github.com/lobu-ai/lobu/issues/3223)) ([0ca8d0c](https://github.com/lobu-ai/lobu/commit/0ca8d0c146aa800344230ef1309676a3f2db87d9))
* **automations:** scope poll responses by poll actor ([#3224](https://github.com/lobu-ai/lobu/issues/3224)) ([a79ae25](https://github.com/lobu-ai/lobu/commit/a79ae2507271b09356d788c318e2ef26ce0ace47))
* **chat:** complete live event-card interactions ([#3221](https://github.com/lobu-ai/lobu/issues/3221)) ([de4d78f](https://github.com/lobu-ai/lobu/commit/de4d78f0589141f278a0fe4b1d0d3bc9daef2020))
* **cli:** isolate Mac debug bootstrap context ([#3162](https://github.com/lobu-ai/lobu/issues/3162)) ([4f4c235](https://github.com/lobu-ai/lobu/commit/4f4c235135b8dd1b235fe98a9759ebed4054b3fb))
* **connector-worker:** stop terminal interactive handoffs ([#3187](https://github.com/lobu-ai/lobu/issues/3187)) ([3d864f9](https://github.com/lobu-ai/lobu/commit/3d864f98397ef7272e7203aa431ca97213542f57))
* **connectors:** harden Outlook and Reddit sync ([#3192](https://github.com/lobu-ai/lobu/issues/3192)) ([78077f7](https://github.com/lobu-ai/lobu/commit/78077f7881838f28fb7fa45a80bc9161d1a88abb))
* **connectors:** pin device readiness to the exact selected artifact ([#3175](https://github.com/lobu-ai/lobu/issues/3175)) ([25ebd3b](https://github.com/lobu-ai/lobu/commit/25ebd3b37f00478fdc8eca7bcf665d4fa1d147f2))
* **gateway:** verify worker readiness before dispatch ([#3176](https://github.com/lobu-ai/lobu/issues/3176)) ([2a51ce3](https://github.com/lobu-ai/lobu/commit/2a51ce37ca165b0c5e0ba5f059710a8ce4d71624))
* **github:** encode REST path segments ([#3194](https://github.com/lobu-ai/lobu/issues/3194)) ([1bd3826](https://github.com/lobu-ai/lobu/commit/1bd3826219360be47ec58092b36078a054a320f5))
* **linkedin:** bind expansion to durable row identity ([#3193](https://github.com/lobu-ai/lobu/issues/3193)) ([5c0db44](https://github.com/lobu-ai/lobu/commit/5c0db449445f01078e78801527d01c46f3e380cc))
* **linkedin:** settle asynchronous comments ([#3163](https://github.com/lobu-ai/lobu/issues/3163)) ([a67710c](https://github.com/lobu-ai/lobu/commit/a67710c7f0dac0b1055225ea3dbad6cf02b8b307))
* **mac:** make Owletto browser login survive non-TTY supervision ([#3216](https://github.com/lobu-ai/lobu/issues/3216)) ([5862c07](https://github.com/lobu-ai/lobu/commit/5862c07dedb51bf80f9156ba4c5b3f5f06168b75))
* **mcp:** align app review metadata ([#3198](https://github.com/lobu-ai/lobu/issues/3198)) ([c26d899](https://github.com/lobu-ai/lobu/commit/c26d8996d0855b553ef7871610a37e468e2e910f))
* **mcp:** declare ChatGPT app widget domain ([#3180](https://github.com/lobu-ai/lobu/issues/3180)) ([27b8df7](https://github.com/lobu-ai/lobu/commit/27b8df7c7f1928dae17fea7bd66d68920eff14db))
* **mcp:** negotiate app sandbox domain ([#3181](https://github.com/lobu-ai/lobu/issues/3181)) ([10de689](https://github.com/lobu-ai/lobu/commit/10de6890e149ec00429703107a74bb4c0d30efd3))
* **mcp:** scope app sandbox domain per session ([#3183](https://github.com/lobu-ai/lobu/issues/3183)) ([a54d815](https://github.com/lobu-ai/lobu/commit/a54d8153c7262460dd02f34caff501c5bb1b3b50))
* **photos:** align v1 connector contract ([#3195](https://github.com/lobu-ai/lobu/issues/3195)) ([664f9db](https://github.com/lobu-ai/lobu/commit/664f9dbefb5acc16fede1075dff3f0612dc7d044))
* **sdk:** align device-aware method signatures ([#3188](https://github.com/lobu-ai/lobu/issues/3188)) ([0c4a89d](https://github.com/lobu-ai/lobu/commit/0c4a89d0b1b6a5986cceaa91712c9178d9544567))
* **sdk:** document nullable entity schema lookups ([#3178](https://github.com/lobu-ai/lobu/issues/3178)) ([2627d9e](https://github.com/lobu-ai/lobu/commit/2627d9ee3aec24ba3a3d27d22da0033c9229cf5d))
* **server:** contain escaped browser callback parameters ([#3186](https://github.com/lobu-ai/lobu/issues/3186)) ([4460b85](https://github.com/lobu-ai/lobu/commit/4460b85362c92752904c6a1670ac2de8d6716bf8))
* **server:** harden connector relationship claims ([#3228](https://github.com/lobu-ai/lobu/issues/3228)) ([5dd31ea](https://github.com/lobu-ai/lobu/commit/5dd31ea0739335c17407f7af6258399e6172f847))
* **server:** preserve device auto-wire suppression ([#3189](https://github.com/lobu-ai/lobu/issues/3189)) ([39fa7b2](https://github.com/lobu-ai/lobu/commit/39fa7b23554dd47b0c8477722935abddab914a3c))
* **server:** reject invalid identity scope keys ([#3218](https://github.com/lobu-ai/lobu/issues/3218)) ([09fc772](https://github.com/lobu-ai/lobu/commit/09fc77267722781178eca60aafa03ae4b10cd996))
* **server:** reject structured tenant scope keys ([#3227](https://github.com/lobu-ai/lobu/issues/3227)) ([5fe58fc](https://github.com/lobu-ai/lobu/commit/5fe58fc0e86717428eec48a7f64643b6465b0d46))
* **worker-api:** ship bundled code to device workers ([#3220](https://github.com/lobu-ai/lobu/issues/3220)) ([648a495](https://github.com/lobu-ai/lobu/commit/648a4957baf085d505e881734039235cef63fe23))

## [17.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v17.0.0...lobu-v17.1.0) (2026-08-25)


### Features

* **connectors:** derive device setup readiness ([#3160](https://github.com/lobu-ai/lobu/issues/3160)) ([4fbd4fa](https://github.com/lobu-ai/lobu/commit/4fbd4fa419e58d74a81e01c90737f7a311242738))
* **gchat:** add native Lobu command parity ([#3158](https://github.com/lobu-ai/lobu/issues/3158)) ([4b7526d](https://github.com/lobu-ai/lobu/commit/4b7526d332a10fde2209055b3f67f4a6c238e48c))
* **linkedin:** collect complete comment threads ([#3153](https://github.com/lobu-ai/lobu/issues/3153)) ([60d7414](https://github.com/lobu-ai/lobu/commit/60d74141030fdc9ea4d58d3d8269f6b3b49dc456))


### Bug Fixes

* **ci:** allow AppKit behavior properties in naming gate ([#3165](https://github.com/lobu-ai/lobu/issues/3165)) ([4bccd1c](https://github.com/lobu-ai/lobu/commit/4bccd1cbc80214cc26cf3c4f08484afa9d60e2f8))
* **gchat:** align native command behavior [client-regen-not-needed] ([#3167](https://github.com/lobu-ai/lobu/issues/3167)) ([a39c9db](https://github.com/lobu-ai/lobu/commit/a39c9dbc1bdbd7eca9c220a66e78d57061e70c93))
* **linkedin:** ignore feed helper rows ([#3159](https://github.com/lobu-ai/lobu/issues/3159)) ([60544fd](https://github.com/lobu-ai/lobu/commit/60544fd375c59e4e424b3e1eeeb8184c3502261e))
* **linkedin:** recover complete comment scraping ([#3157](https://github.com/lobu-ai/lobu/issues/3157)) ([f135edc](https://github.com/lobu-ai/lobu/commit/f135edc006c78d45aa82e656b80eb864c9821fc6))
* **release:** keep Mac updater current ([#3156](https://github.com/lobu-ai/lobu/issues/3156)) ([f2d74ab](https://github.com/lobu-ai/lobu/commit/f2d74abc27c497721668f1a0ba2145e8a6bf651e))
* **server:** replace real content id in search_memory example with synthetic one ([#3169](https://github.com/lobu-ai/lobu/issues/3169)) ([52c4eb5](https://github.com/lobu-ai/lobu/commit/52c4eb5210d00d160f5f753683253c80b0ff1062))
* **worker:** keep transient context out of transcripts ([#3154](https://github.com/lobu-ai/lobu/issues/3154)) ([4c087a4](https://github.com/lobu-ai/lobu/commit/4c087a4c75b87789db7f092f0771c0dc32b0b6ab))

## [17.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v16.1.0...lobu-v17.0.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **connectors:** feed capabilities now use per-feed `sync` and `read` handlers. The public Connector SDK no longer exposes `SearchContext`, `ConnectorRuntime.search()`, `FeedDefinition.virtual`, or `QueryContext.feedKey`. External connectors must move live source reads into each feed's `read` handler; connection-level `query` remains for SQL and warehouse compute pushdown.


### Features

* **mcp:** add semantic approval context ([#3145](https://github.com/lobu-ai/lobu/issues/3145)) ([13a5444](https://github.com/lobu-ai/lobu/commit/13a54447ae40eb0a6b03f38bd21b174b482033b7))


### Bug Fixes

* **devices:** stamp public origin on child tokens ([#3151](https://github.com/lobu-ai/lobu/issues/3151)) ([7bf6036](https://github.com/lobu-ai/lobu/commit/7bf6036139ee13e35207265500cbd7229ccef18f))
* **feeds:** honor pinned connector capabilities ([#3149](https://github.com/lobu-ai/lobu/issues/3149)) ([7e46922](https://github.com/lobu-ai/lobu/commit/7e4692253c8699b98a5118ed0abdc9133523a446))
* **gchat:** resolve stored secrets in tenant context ([#3147](https://github.com/lobu-ai/lobu/issues/3147)) ([3e3c20e](https://github.com/lobu-ai/lobu/commit/3e3c20e3e0bed78800324eb5326e5ced9fa9ef8e))
* **linkedin:** ignore identity-less feed modules ([#3152](https://github.com/lobu-ai/lobu/issues/3152)) ([43de225](https://github.com/lobu-ai/lobu/commit/43de225b8ce0cb5636a148bf113d8856c6a59713))
* **linkedin:** recall content through person identities ([#3141](https://github.com/lobu-ai/lobu/issues/3141)) ([c80beb6](https://github.com/lobu-ai/lobu/commit/c80beb6370b09c11aea3b350c373c611c4756571))
* **server:** allow agent chat from workspace subdomains ([#3144](https://github.com/lobu-ai/lobu/issues/3144)) ([3ee0d7c](https://github.com/lobu-ai/lobu/commit/3ee0d7c6150e5a584bc855b5857716fcc2d51b55))

## [16.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v16.0.0...lobu-v16.1.0) (2026-08-24)


### Features

* **gchat:** add marketplace welcome and help [client-regen-not-needed] ([#3143](https://github.com/lobu-ai/lobu/issues/3143)) ([eadd839](https://github.com/lobu-ai/lobu/commit/eadd8394ff69cf0d76fb55dd60cfeef712a3255b))
* **linkedin:** complete home feed events ([#3106](https://github.com/lobu-ai/lobu/issues/3106)) ([bcbf825](https://github.com/lobu-ai/lobu/commit/bcbf82596f042242da198b30284d3ce2a92799bd))
* **staging:** route public host to local tailnet ([#3063](https://github.com/lobu-ai/lobu/issues/3063)) ([b571155](https://github.com/lobu-ai/lobu/commit/b5711553aa741fb862a3fef5fbc2eb09b2a1cfd1))


### Bug Fixes

* **auth:** allow packaged Mac child tokens ([#3133](https://github.com/lobu-ai/lobu/issues/3133)) ([66cfb65](https://github.com/lobu-ai/lobu/commit/66cfb657a6b1dd0e43a560a2bdd926d3f5375d20))
* **automations:** expire abandoned manual runs ([#3119](https://github.com/lobu-ai/lobu/issues/3119)) ([36def35](https://github.com/lobu-ai/lobu/commit/36def35c08c1ebe09d5da65d5e40b6d508cc8829))
* **chat:** support live Google Chat webhooks ([#3124](https://github.com/lobu-ai/lobu/issues/3124)) ([7f9621b](https://github.com/lobu-ai/lobu/commit/7f9621bb6dcee6b1342a7110a091ac982833b0f6))
* **chat:** verify Google Workspace add-on webhooks ([#3126](https://github.com/lobu-ai/lobu/issues/3126)) ([fb9dcf9](https://github.com/lobu-ai/lobu/commit/fb9dcf9ff1d6321fd8ac39dfff6382668c49fb41))
* **connectors:** release final X likes parser ([#3122](https://github.com/lobu-ai/lobu/issues/3122)) ([4e23a91](https://github.com/lobu-ai/lobu/commit/4e23a917038e52c212010a591cc23f8402cd1cb2))
* **linkedin:** allow short-link resolution ([#3139](https://github.com/lobu-ai/lobu/issues/3139)) ([db736cf](https://github.com/lobu-ai/lobu/commit/db736cfeab25c1d05d24662d6c2247b4124be929))
* **linkedin:** fail unusable home feed scrapes ([#3137](https://github.com/lobu-ai/lobu/issues/3137)) ([57c704a](https://github.com/lobu-ai/lobu/commit/57c704adaaf53e783d92c9a20d60c4cc7254e953))
* **linkedin:** resolve copied post links ([#3138](https://github.com/lobu-ai/lobu/issues/3138)) ([abe81f7](https://github.com/lobu-ai/lobu/commit/abe81f7a487ecea5c7231eab981e8591e918d23c))
* **linkedin:** reuse hydrated feed for live scores ([#3136](https://github.com/lobu-ai/lobu/issues/3136)) ([0cdcf6f](https://github.com/lobu-ai/lobu/commit/0cdcf6f796f3d5cdaa315b7b822c7cb70bc3a4c2))
* **linkedin:** score visible comment reactions ([#3135](https://github.com/lobu-ai/lobu/issues/3135)) ([e182a5a](https://github.com/lobu-ai/lobu/commit/e182a5a7bc6295801f1bc747081eeed834ec2a3a))
* **linkedin:** use durable home feed origins ([#3130](https://github.com/lobu-ai/lobu/issues/3130)) ([81d777a](https://github.com/lobu-ai/lobu/commit/81d777ada88eb4fee68338d12d73682ff909bd3b))
* **mcp:** render approval changes clearly ([#3129](https://github.com/lobu-ai/lobu/issues/3129)) ([b889c07](https://github.com/lobu-ai/lobu/commit/b889c077ef4caf38f46afd375296e905bd96efcc))
* project latest completed automation window ([#3096](https://github.com/lobu-ai/lobu/issues/3096)) ([4db43dd](https://github.com/lobu-ai/lobu/commit/4db43dd6f06d2acd642d0ea263d31415b1e41ab8))
* **server:** preserve transcription event identity ([#3120](https://github.com/lobu-ai/lobu/issues/3120)) ([88c6fdf](https://github.com/lobu-ai/lobu/commit/88c6fdf7ce162b01d574f9a031a2b65497f57586))
* **server:** select active attribution definitions ([#3125](https://github.com/lobu-ai/lobu/issues/3125)) ([adf3e45](https://github.com/lobu-ai/lobu/commit/adf3e45a580286ded33daf894e21ff37c80eeb19))

## [16.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.8.0...lobu-v16.0.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **cli:** drop legacy --inside-claude daemon flag ([#3105](https://github.com/lobu-ai/lobu/issues/3105))

### Features

* **cli:** drop legacy --inside-claude daemon flag ([#3105](https://github.com/lobu-ai/lobu/issues/3105)) ([b18c150](https://github.com/lobu-ai/lobu/commit/b18c1502cd70e592722da865cab69835a973b26e))
* **cli:** rotate headless device credentials ([#3107](https://github.com/lobu-ai/lobu/issues/3107)) ([5318365](https://github.com/lobu-ai/lobu/commit/53183655246be0e3cc1b8d79aa76105a73a0324b))
* **connector-worker:** add supervised native bridge ([#3089](https://github.com/lobu-ai/lobu/issues/3089)) ([24cbc5d](https://github.com/lobu-ai/lobu/commit/24cbc5dba2e96e5d4c31d929745f9c6eb8f448d1))
* **connector-worker:** package lean macOS device daemon ([#3080](https://github.com/lobu-ai/lobu/issues/3080)) ([f0e32f8](https://github.com/lobu-ai/lobu/commit/f0e32f8e6f8b9b894c7189db8fcf8fa19402b019))
* **device-connectors:** add canonical Mac device connectors ([#3086](https://github.com/lobu-ai/lobu/issues/3086)) ([3391815](https://github.com/lobu-ai/lobu/commit/339181527dd06774fed967229f310f925cf889cc))
* **device-daemon:** run Codex automations over ACP ([#3118](https://github.com/lobu-ai/lobu/issues/3118)) ([87edc5b](https://github.com/lobu-ai/lobu/commit/87edc5b3c98c207f69ee8716f97870fd754bbbde))
* **lobu-team:** manage engineering task dogfood runner ([#3112](https://github.com/lobu-ai/lobu/issues/3112)) ([3c5aebe](https://github.com/lobu-ai/lobu/commit/3c5aebee767cb50f9ee522ea868c40f53aba6997))
* **mac:** bundle native device daemon ([#3098](https://github.com/lobu-ai/lobu/issues/3098)) ([871a6b6](https://github.com/lobu-ai/lobu/commit/871a6b609018cc1a472bf9c098bbaa0d631b3795))
* **server:** propagate browser execution context ([#3084](https://github.com/lobu-ai/lobu/issues/3084)) ([df77635](https://github.com/lobu-ai/lobu/commit/df77635adf696a5c3ab07ee617fa47a2cb35d1a6))
* **worker:** add poll capacity semantics ([#3087](https://github.com/lobu-ai/lobu/issues/3087)) ([c052253](https://github.com/lobu-ai/lobu/commit/c052253a1805d0685f7fa6d4ac3c9bc61e11bfec))


### Bug Fixes

* **automations:** expose trigger execution ownership ([#3115](https://github.com/lobu-ai/lobu/issues/3115)) ([52f774b](https://github.com/lobu-ai/lobu/commit/52f774b5b6001252395bfb0d6b60dcbd7180dc2e))
* **automations:** preserve device catch-up scheduling ([#3117](https://github.com/lobu-ai/lobu/issues/3117)) ([898cd9a](https://github.com/lobu-ai/lobu/commit/898cd9af248597465ba688830843d8d585a11c0c))
* **automations:** support run-bound external completion ([#3078](https://github.com/lobu-ai/lobu/issues/3078)) ([d117e15](https://github.com/lobu-ai/lobu/commit/d117e152e468b78bb2aaeb80ae1184f5f3870ee9))
* **ci:** preflight kubeconfig before deploys ([#3094](https://github.com/lobu-ai/lobu/issues/3094)) ([74f3da6](https://github.com/lobu-ai/lobu/commit/74f3da68b65c83b13ef9b40fa11df183e90dfc39))
* complete cross-workspace MCP handoff ([#3101](https://github.com/lobu-ai/lobu/issues/3101)) ([3663e06](https://github.com/lobu-ai/lobu/commit/3663e06cd20d3709d3f8f6b0779b279222398def))
* contain browser callback secrets on ingestion ([#3092](https://github.com/lobu-ai/lobu/issues/3092)) ([cdfb191](https://github.com/lobu-ai/lobu/commit/cdfb1913b31052f36a0c31da89f176ad79151537))
* defer device schedules until workers reconnect ([#3108](https://github.com/lobu-ai/lobu/issues/3108)) ([d91b2ce](https://github.com/lobu-ai/lobu/commit/d91b2ce3a3a5a22da46d12d5372ae9f201b4771f))
* **mcp:** bound proxy transport responses ([#3091](https://github.com/lobu-ai/lobu/issues/3091)) ([20e16b2](https://github.com/lobu-ai/lobu/commit/20e16b2f36d608defff56a5fa06a68da33042db5))
* **mcp:** cap diagnostic preview allocation ([#3095](https://github.com/lobu-ai/lobu/issues/3095)) ([12a5175](https://github.com/lobu-ai/lobu/commit/12a517571404fbe26482ab85f272cc47d48dedcc))
* **oauth:** enforce device verifier ownership ([#3099](https://github.com/lobu-ai/lobu/issues/3099)) ([51b0aff](https://github.com/lobu-ai/lobu/commit/51b0aff59582e6ea486e7bb908fd42be96b49e4f))
* recover automation windows with fenced claims ([#3090](https://github.com/lobu-ai/lobu/issues/3090)) ([bb33aef](https://github.com/lobu-ai/lobu/commit/bb33aef04788c44141fdadc29e84ba01e346013a))
* **search:** reclaim a superseded event's vectors ([#3074](https://github.com/lobu-ai/lobu/issues/3074)) ([b42407f](https://github.com/lobu-ai/lobu/commit/b42407fb6112db26cad0db3fcdf7051b3e77bef7))
* **server:** allow dry runs on paused feeds ([#3110](https://github.com/lobu-ai/lobu/issues/3110)) ([6fa1ccf](https://github.com/lobu-ai/lobu/commit/6fa1ccf1f6a82e2c572adaca83e3d338f6d6bef6))
* **server:** authorize exact device manifest artifacts ([#3079](https://github.com/lobu-ai/lobu/issues/3079)) ([32e17aa](https://github.com/lobu-ai/lobu/commit/32e17aaeed117ba00cf13637b316f4727a85abf8))
* **server:** raise the inline attachment cap so screenshots survive it ([#3055](https://github.com/lobu-ai/lobu/issues/3055)) ([461cc46](https://github.com/lobu-ai/lobu/commit/461cc4670f2bee8b00b7bb1f1fd41b7695a1a818))
* **server:** stop accepting HTTP work before gateway/db teardown ([#3077](https://github.com/lobu-ai/lobu/issues/3077)) ([bf87f09](https://github.com/lobu-ai/lobu/commit/bf87f092579bfb5f0067f8df4a7e904a2c346615))
* validate sdk dry-run actions ([#3093](https://github.com/lobu-ai/lobu/issues/3093)) ([4cd13ba](https://github.com/lobu-ai/lobu/commit/4cd13baf2c0d8af2be17b3bd8e247dba90b2a701))
* **worker:** validate poll requests at runtime ([#3088](https://github.com/lobu-ai/lobu/issues/3088)) ([b87a7bf](https://github.com/lobu-ai/lobu/commit/b87a7bf72aa588d26cb5bab65bf6577e8a94d5e1))

## [15.8.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.7.0...lobu-v15.8.0) (2026-08-22)


### Features

* **cli:** unify external agent onboarding ([#3059](https://github.com/lobu-ai/lobu/issues/3059)) ([c4113eb](https://github.com/lobu-ai/lobu/commit/c4113eb3f92c0066729c0f0232e3679cb2ce7993))
* **lens:** ship context-aware picture-in-picture ([#3070](https://github.com/lobu-ai/lobu/issues/3070)) ([2b33c8d](https://github.com/lobu-ai/lobu/commit/2b33c8ddaf86564067ea9f4b382f047bbea37087))


### Bug Fixes

* **classification:** scope the parent-context join by org and connection ([#3069](https://github.com/lobu-ai/lobu/issues/3069)) ([ae1dad8](https://github.com/lobu-ai/lobu/commit/ae1dad8b46faeca3a9830b179d67fb987fd33d9c)), closes [#3068](https://github.com/lobu-ai/lobu/issues/3068)
* make browser draft handoffs actionable ([#3064](https://github.com/lobu-ai/lobu/issues/3064)) ([c1091ff](https://github.com/lobu-ai/lobu/commit/c1091ffb1d0e3ec576bd952054d29689059db11b))
* **mcp:** support admin scope upgrades ([#3062](https://github.com/lobu-ai/lobu/issues/3062)) ([a169f5d](https://github.com/lobu-ai/lobu/commit/a169f5d91fae28415ae221db497f7e9da1ec3f01))
* **server:** sanitize NUL at persistence boundaries ([#3073](https://github.com/lobu-ai/lobu/issues/3073)) ([50b6706](https://github.com/lobu-ai/lobu/commit/50b6706231fe50a9cc9e164d6c0f73c0fa27e8d6))


### Performance Improvements

* **events:** reconcile volatile counters in place instead of superseding ([#3071](https://github.com/lobu-ai/lobu/issues/3071)) ([0ce7f12](https://github.com/lobu-ai/lobu/commit/0ce7f12a9f84a22fd1d775534b250a24ce1771e5)), closes [#3065](https://github.com/lobu-ai/lobu/issues/3065)

## [15.7.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.6.0...lobu-v15.7.0) (2026-08-21)


### Features

* **connectors:** declare attributed entity relationships ([#3057](https://github.com/lobu-ai/lobu/issues/3057)) ([aaf3897](https://github.com/lobu-ai/lobu/commit/aaf389713743d7f99c1070014ed740f867859243))


### Bug Fixes

* **auth:** scope direct MCP worker credentials ([#3053](https://github.com/lobu-ai/lobu/issues/3053)) ([288c691](https://github.com/lobu-ai/lobu/commit/288c69177f8f18e7b329df4448f437798e2b455d))
* **cli:** finish authenticated daemon onboarding ([#3056](https://github.com/lobu-ai/lobu/issues/3056)) ([68678d3](https://github.com/lobu-ai/lobu/commit/68678d38bd386146157b11fbb588ee864f9f71e5))
* **dev:** resolve a remote-only branch in task-setup ([#3051](https://github.com/lobu-ai/lobu/issues/3051)) ([1133495](https://github.com/lobu-ai/lobu/commit/113349570eba1d3ad9bfb39a167cb471f75e5591))
* **server:** bind save_memory media and stop re-sync supersede loops ([#3054](https://github.com/lobu-ai/lobu/issues/3054)) ([fe69416](https://github.com/lobu-ai/lobu/commit/fe694168bba305850ec8f86574ab6b13cb8e91c1))

## [15.6.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.5.0...lobu-v15.6.0) (2026-08-21)


### Features

* **dev:** per-worktree Daytona dev sandbox ([#3044](https://github.com/lobu-ai/lobu/issues/3044)) ([8737beb](https://github.com/lobu-ai/lobu/commit/8737bebe52503cb2c2292bc0124bccbdfb079560))
* **helm:** add durable artifact PVC topology ([#3036](https://github.com/lobu-ai/lobu/issues/3036)) ([ecee020](https://github.com/lobu-ai/lobu/commit/ecee0206e9ea54bf6ceefc792180b41d9d1d2b5e))


### Bug Fixes

* **automation:** fail fast on OpenCode quota waits ([#3041](https://github.com/lobu-ai/lobu/issues/3041)) ([c9de7dd](https://github.com/lobu-ai/lobu/commit/c9de7dd7f27540d20d4de60fd5b345f664fb2e9f))
* preserve explicit OAuth feed pauses ([#3046](https://github.com/lobu-ai/lobu/issues/3046)) ([03899b8](https://github.com/lobu-ai/lobu/commit/03899b82c05cb6e7af47ee85d2bff91525fd8aca))
* **server:** accept Slack Grid org-wide auth identity ([#3047](https://github.com/lobu-ai/lobu/issues/3047)) ([3972c84](https://github.com/lobu-ai/lobu/commit/3972c847268cecc445ee48843a51be048a4946b9))
* **server:** persist and verify media artifacts ([#3037](https://github.com/lobu-ai/lobu/issues/3037)) ([f4dd811](https://github.com/lobu-ai/lobu/commit/f4dd811371c76c4b2b14070299e99394ad7ca34d))
* **server:** report truthful automation and feed health ([#3038](https://github.com/lobu-ai/lobu/issues/3038)) ([af7a64b](https://github.com/lobu-ai/lobu/commit/af7a64b3596bb4638fbbe45ee17fdbc2169a9051))
* **server:** route Slack channel automations ([#3039](https://github.com/lobu-ai/lobu/issues/3039)) ([dcd04bb](https://github.com/lobu-ai/lobu/commit/dcd04bb9cd5d58b33cb95b59178d6c1b537cd910))
* **server:** serialize edge audits with force delete ([#3048](https://github.com/lobu-ai/lobu/issues/3048)) ([4d43503](https://github.com/lobu-ai/lobu/commit/4d43503e10fd011643666450bb95a77b9da28024))
* **server:** verify Slack chat reliability ([#3045](https://github.com/lobu-ai/lobu/issues/3045)) ([dddfc08](https://github.com/lobu-ai/lobu/commit/dddfc084c16b27aa980348ffb7c79a93192e0ca1))

## [15.5.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.4.0...lobu-v15.5.0) (2026-08-21)


### Features

* **cli:** first-run device wizard + consistent daemon worker id ([#3014](https://github.com/lobu-ai/lobu/issues/3014)) ([c8f0efb](https://github.com/lobu-ai/lobu/commit/c8f0efb87d923c1675af6f2ed61abbaf29e04e44))
* **dev:** add make ctx and make land composite commands ([#3026](https://github.com/lobu-ai/lobu/issues/3026)) ([df662c1](https://github.com/lobu-ai/lobu/commit/df662c1ae7286914dae5e56c7f88ac067f7de153))


### Bug Fixes

* **ci:** stop merges cancelling main's validation, build the graph in task-setup ([#3028](https://github.com/lobu-ai/lobu/issues/3028)) ([dd61596](https://github.com/lobu-ai/lobu/commit/dd61596f736c4d65a41ec8ed2eb0cea34ab387b4))
* **mcp:** mark audited retrieval tools read-only ([#3029](https://github.com/lobu-ai/lobu/issues/3029)) ([16019d1](https://github.com/lobu-ai/lobu/commit/16019d145fb149ca65b261eb00e171b172187917))
* **test:** reap embedded-Postgres clusters orphaned by a killed run ([#3025](https://github.com/lobu-ai/lobu/issues/3025)) ([093548b](https://github.com/lobu-ai/lobu/commit/093548b9208c9850e1dd381069171f3c0c1a753e))

## [15.4.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.3.1...lobu-v15.4.0) (2026-08-21)


### Features

* support interactive Codex and OpenCode automations ([#3023](https://github.com/lobu-ai/lobu/issues/3023)) ([94837a8](https://github.com/lobu-ai/lobu/commit/94837a80c9161e69604c2e90ffb9150584203c11))


### Bug Fixes

* **ci:** give the prod rollout gate headroom over observed deploy latency ([#3019](https://github.com/lobu-ai/lobu/issues/3019)) ([c40efce](https://github.com/lobu-ai/lobu/commit/c40efce1935e051cd817c858a7e007ea5b9f740e))

## [15.3.1](https://github.com/lobu-ai/lobu/compare/lobu-v15.3.0...lobu-v15.3.1) (2026-08-21)


### Bug Fixes

* **automation:** return parent Claude results safely ([#3016](https://github.com/lobu-ai/lobu/issues/3016)) ([65023ac](https://github.com/lobu-ai/lobu/commit/65023ac1c9bbb778cb406a847856c9daf661e051))
* **daemon:** stop CLI after terminal heartbeat conflict ([#2997](https://github.com/lobu-ai/lobu/issues/2997)) ([5418b3b](https://github.com/lobu-ai/lobu/commit/5418b3b01c9ae7cb72c137b9aa666225f2f683a4))
* **server:** make worker dispatch claim-aware ([#3012](https://github.com/lobu-ai/lobu/issues/3012)) ([22c97f4](https://github.com/lobu-ai/lobu/commit/22c97f4163aa77e555059fc986e51c41e7df6cab))

## [15.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.2.1...lobu-v15.3.0) (2026-08-21)


### Features

* **automation:** run Claude Automations in parent session ([#3010](https://github.com/lobu-ai/lobu/issues/3010)) ([6120c04](https://github.com/lobu-ai/lobu/commit/6120c04bcb5b8404ef595fa444930ec26784472c))
* expose media attachments as MCP resources ([#2885](https://github.com/lobu-ai/lobu/issues/2885)) ([795935f](https://github.com/lobu-ai/lobu/commit/795935f5f86e9178698ee43717e36b8eb2068db4))


### Bug Fixes

* **deploy:** enforce the promotions pause server-side, not just in the CLI ([#2936](https://github.com/lobu-ai/lobu/issues/2936)) ([e02a8e0](https://github.com/lobu-ai/lobu/commit/e02a8e0bfb33ab276a905bc2c7457b998f9fabb0))
* **migrations:** flush deferred Automation trigger [migration-never-applied] ([#3008](https://github.com/lobu-ai/lobu/issues/3008)) ([477484d](https://github.com/lobu-ai/lobu/commit/477484d609ddb5a1764697485bbd0acaa6629d3d))
* **scripts:** prune the worktree registration before deleting its branch ([#2874](https://github.com/lobu-ai/lobu/issues/2874)) ([f3a989e](https://github.com/lobu-ai/lobu/commit/f3a989e26a757d60fd8ccd8d2abf5e47ac7f7f41))
* **server:** let an org member use an agent they do not own ([#2900](https://github.com/lobu-ai/lobu/issues/2900)) ([7e893d5](https://github.com/lobu-ai/lobu/commit/7e893d59601e61d04467dfd3324936026f5e76d6))

## [15.2.1](https://github.com/lobu-ai/lobu/compare/lobu-v15.2.0...lobu-v15.2.1) (2026-08-20)


### Bug Fixes

* **auth:** stamp automation worker token source ([#2998](https://github.com/lobu-ai/lobu/issues/2998)) ([553411d](https://github.com/lobu-ai/lobu/commit/553411dd707d71af4905e06bea0e37fbf7ae0aec))
* **cli:** surface local sign-in diagnostics ([#3002](https://github.com/lobu-ai/lobu/issues/3002)) ([5182f87](https://github.com/lobu-ai/lobu/commit/5182f879b336288a2b7bc34ef87b92107dadad52))
* **migrations:** preserve legacy Canvas results [migration-never-applied] ([#3001](https://github.com/lobu-ai/lobu/issues/3001)) ([e4e3f54](https://github.com/lobu-ai/lobu/commit/e4e3f541144050f66535668a427c80c4a8218c41))
* **migrations:** preserve orphan Automation reaction [migration-never-applied] ([#3005](https://github.com/lobu-ai/lobu/issues/3005)) ([39f8be2](https://github.com/lobu-ai/lobu/commit/39f8be24149e4e59bfba715ae91d9042d08b4e1f))
* **server:** audit entity policy denials ([#2999](https://github.com/lobu-ai/lobu/issues/2999)) ([7f5e59a](https://github.com/lobu-ai/lobu/commit/7f5e59a39c8225574e7fbbfee46920ba6f7f8bb5))


### Performance Improvements

* **db:** project stored event content length ([#3000](https://github.com/lobu-ai/lobu/issues/3000)) ([545429b](https://github.com/lobu-ai/lobu/commit/545429bd9473502993bc1f2b1fd1c17d89750fde))

## [15.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.1.0...lobu-v15.2.0) (2026-08-20)


### Features

* **authz:** govern force_delete_tree with the same $deleted rule the soft path uses ([#2963](https://github.com/lobu-ai/lobu/issues/2963)) ([64b2d8b](https://github.com/lobu-ai/lobu/commit/64b2d8b7f51725e4b218e243d1aa6c8743bffe8a))
* **authz:** govern merge with entity write rules, under its own name ([#2950](https://github.com/lobu-ai/lobu/issues/2950)) ([5da9664](https://github.com/lobu-ai/lobu/commit/5da9664e850a7c73ba9e68272452bc5279e2b783))
* **automations:** execute headless device Automations on a per-run agent session ([#2943](https://github.com/lobu-ai/lobu/issues/2943)) ([42a230d](https://github.com/lobu-ai/lobu/commit/42a230d7f143d128e986b04256b968c5734b4454))
* **automations:** expose the platform event catalog to trigger pickers ([#2959](https://github.com/lobu-ai/lobu/issues/2959)) ([8818450](https://github.com/lobu-ai/lobu/commit/8818450208fd1d93ea2a6dc3ef39e8d073a4b1f2))
* **ci:** let ui-review skip the screenshot when a range has no UI surface ([#2993](https://github.com/lobu-ai/lobu/issues/2993)) ([97808ba](https://github.com/lobu-ai/lobu/commit/97808ba7aba7bea07b6e05ec3aee18fadd6d37fa))
* **entities:** preview a merge's rule verdict with dry_run ([#2958](https://github.com/lobu-ai/lobu/issues/2958)) ([02114cf](https://github.com/lobu-ai/lobu/commit/02114cfbb2529d63514ad30fdbdf4a6248638685))
* **merge:** card a merge the write rule escalates instead of failing it closed ([#2984](https://github.com/lobu-ai/lobu/issues/2984)) ([b96dbb1](https://github.com/lobu-ai/lobu/commit/b96dbb11d316fe86f3ad06eb7f4092c725221a95))


### Bug Fixes

* **approvals:** apply builder-run proposals without re-entering the fresh-call scope gate ([#2981](https://github.com/lobu-ai/lobu/issues/2981)) ([276f42e](https://github.com/lobu-ai/lobu/commit/276f42e21d1dc2cbb07058e40d62175fe131d462))
* **authz:** verify a declared automation_source at every write surface ([#2967](https://github.com/lobu-ai/lobu/issues/2967)) ([6496ad4](https://github.com/lobu-ai/lobu/commit/6496ad4a05d1b7c6aa3da2526dfa2096a3e7bc0b))
* **automations:** bound audit-mediated cascades and verify declared sources ([#2952](https://github.com/lobu-ai/lobu/issues/2952)) ([4328258](https://github.com/lobu-ai/lobu/commit/4328258c617be6b943ce9f8cf700c5969ecb9539))
* **connections:** gate action_modes writes to human web sessions ([#2961](https://github.com/lobu-ai/lobu/issues/2961)) ([304c95c](https://github.com/lobu-ai/lobu/commit/304c95c6dbdf4847e3902d9abbd341d8f182dc62))
* **devices:** expire child tokens and stop the mint chain at depth 1 ([#2962](https://github.com/lobu-ai/lobu/issues/2962)) ([d9b9af8](https://github.com/lobu-ai/lobu/commit/d9b9af82938883a060b922736065293f8c9eb451))
* **devices:** stop poll and re-mint heartbeats from clobbering a user-set device label ([#2957](https://github.com/lobu-ai/lobu/issues/2957)) ([a1428ba](https://github.com/lobu-ai/lobu/commit/a1428baacb7634f507535a814945666d679f856f))
* **entities:** let a merged record be force-deleted instead of wedging on its ledger ([#2970](https://github.com/lobu-ai/lobu/issues/2970)) ([162cb90](https://github.com/lobu-ai/lobu/commit/162cb901f48ace88a4ac79ba6dd7e5f416a696e2))
* **entities:** route a delete rule's escalate into an approval card ([#2971](https://github.com/lobu-ai/lobu/issues/2971)) ([7b7c7d9](https://github.com/lobu-ai/lobu/commit/7b7c7d9ca746b22d27e60a330843794bcfd07f99))
* **feeds:** defer offline device syncs ([#2989](https://github.com/lobu-ai/lobu/issues/2989)) ([276940a](https://github.com/lobu-ai/lobu/commit/276940a6934ae8ca8ee3e162a306dc79bc5cf785))
* **feeds:** exclude paused feeds from health filters ([#2992](https://github.com/lobu-ai/lobu/issues/2992)) ([ec1d511](https://github.com/lobu-ai/lobu/commit/ec1d5110e05887474803f5cf12467a577b628e88))
* **mcp:** echo the saved payload to every card, not only negotiated clients ([#2968](https://github.com/lobu-ai/lobu/issues/2968)) ([3fd9c00](https://github.com/lobu-ai/lobu/commit/3fd9c00ca54fdfadc6e7efa177a5325c92f4435f))
* **mcp:** issue and redeem the approval capability without the Apps declaration ([#2973](https://github.com/lobu-ai/lobu/issues/2973)) ([2b3c899](https://github.com/lobu-ai/lobu/commit/2b3c8997415774dfbf2f1c65c1a963a9ee82ba33))
* **mcp:** resolve superseded interaction resource URIs to the current shell ([#2949](https://github.com/lobu-ai/lobu/issues/2949)) ([b96f172](https://github.com/lobu-ai/lobu/commit/b96f17264fc4fb7792c9f831d855beb5c34b42f3))
* **mcp:** send the App binding to every client, not only negotiated ones ([#2960](https://github.com/lobu-ai/lobu/issues/2960)) ([7f8862e](https://github.com/lobu-ai/lobu/commit/7f8862e10ae1418628ce0c6fde25934c06f691f5))
* **server:** require Node for Vitest suites ([#2991](https://github.com/lobu-ai/lobu/issues/2991)) ([ad3a668](https://github.com/lobu-ai/lobu/commit/ad3a6684ada45a8fe641a3054ebbf15c6178254d))
* **server:** settle terminal chat action cards ([#2985](https://github.com/lobu-ai/lobu/issues/2985)) ([c778c72](https://github.com/lobu-ai/lobu/commit/c778c725422b8a6fa3d65e2d5a707e3dc339a2f6))
* **server:** show approval decision provenance ([#2990](https://github.com/lobu-ai/lobu/issues/2990)) ([4783797](https://github.com/lobu-ai/lobu/commit/478379740ee661e4eefdcfcf91e7b9c0bb4d770e))
* **tools:** make save_memory metadata optional ([#2975](https://github.com/lobu-ai/lobu/issues/2975)) ([1244c05](https://github.com/lobu-ai/lobu/commit/1244c05dc06268d344a15de3304526b076b3d3e7))
* **workers:** mint an org-scoped MCP URL a spawned CLI can actually open ([#2974](https://github.com/lobu-ai/lobu/issues/2974)) ([180a694](https://github.com/lobu-ai/lobu/commit/180a69460c1d5762d83b3b21661efe8fdc8d5bd3))

## [15.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v15.0.0...lobu-v15.1.0) (2026-08-20)


### Features

* add headless device platform for server/VM workers ([#2880](https://github.com/lobu-ai/lobu/issues/2880)) ([72107a2](https://github.com/lobu-ai/lobu/commit/72107a2c6696f2f518433a34f697372da4446584))
* allow headless platform to mint child device tokens ([#2884](https://github.com/lobu-ai/lobu/issues/2884)) ([6064780](https://github.com/lobu-ai/lobu/commit/6064780ecc9765179ba80e37e8442a782aaf1754))
* **authz:** govern soft delete with entity write rules ([#2932](https://github.com/lobu-ai/lobu/issues/2932)) ([7731ae2](https://github.com/lobu-ai/lobu/commit/7731ae2b7b3b45adc319b739e7befc019fa060fb))
* **automations:** let platform-written events activate Automations as roots ([#2938](https://github.com/lobu-ai/lobu/issues/2938)) ([f321ce3](https://github.com/lobu-ai/lobu/commit/f321ce38114a7702f18861835f5cc7eedfc678fa))
* **automations:** make platform events subscribable from a computed catalog ([#2944](https://github.com/lobu-ai/lobu/issues/2944)) ([1d9fffe](https://github.com/lobu-ai/lobu/commit/1d9fffe1e6c881b765e6201310092b204052cd4f))
* **automations:** queue activation for platform-written events ([#2947](https://github.com/lobu-ai/lobu/issues/2947)) ([e53c712](https://github.com/lobu-ai/lobu/commit/e53c7127e42911b817201700750ef40368c65394))
* **ci:** rename pre-pr-remote to pr-full with daytona-first, local-fallback gate ([#2890](https://github.com/lobu-ai/lobu/issues/2890)) ([abc5469](https://github.com/lobu-ai/lobu/commit/abc5469fe7a2d12c255d77239e016efcb8e6b661))
* **cli:** execute an already-claimed device Automation via `lobu automation execute` ([#2907](https://github.com/lobu-ai/lobu/issues/2907)) ([201546d](https://github.com/lobu-ai/lobu/commit/201546d3e3027f1e33ae021651ac693260b68d9a))
* **cli:** prompt for token scope interactively instead of hardcoding read+write ([#2834](https://github.com/lobu-ai/lobu/issues/2834)) ([4138062](https://github.com/lobu-ai/lobu/commit/4138062941e755c484983e36e8a7ae61b43a35ff))
* **connectors:** read device-backed virtual feeds live, retaining nothing ([#2940](https://github.com/lobu-ai/lobu/issues/2940)) ([a13789c](https://github.com/lobu-ai/lobu/commit/a13789c189a3bcc3120966113fb8cd312628d256))
* **devices:** gate the automation claim lane on advertised agent kinds ([#2918](https://github.com/lobu-ai/lobu/issues/2918)) ([1854088](https://github.com/lobu-ai/lobu/commit/185408861ec5f56e8d010081df180ae1367501c8))
* **notifications:** render every notification through one json_template pipeline ([#2935](https://github.com/lobu-ai/lobu/issues/2935)) ([3125a29](https://github.com/lobu-ai/lobu/commit/3125a29a2d48fa1608afa9e9999158b58fb124e2))
* os.shell connector for headless devices (run commands on herdr) ([#2886](https://github.com/lobu-ai/lobu/issues/2886)) ([5dffccf](https://github.com/lobu-ai/lobu/commit/5dffccf50ee43932fb7f532e97e6a675e6946c1e))
* PR preview environments with K8s + Tailscale ([#2826](https://github.com/lobu-ai/lobu/issues/2826)) ([9f65c1e](https://github.com/lobu-ai/lobu/commit/9f65c1efd81e5e6f5b08ac2b8edd7fd558c9ef41))
* **sdk:** expose the caller's devices as client.devices ([#2926](https://github.com/lobu-ai/lobu/issues/2926)) ([d641b23](https://github.com/lobu-ai/lobu/commit/d641b2381dd53804d7c298259ffc08290f044dff))
* **server,connector-sdk:** scope entity identities per connection when declared ([#2846](https://github.com/lobu-ai/lobu/issues/2846)) ([70e5aba](https://github.com/lobu-ai/lobu/commit/70e5abae116ca0fcffe1188154bf9bd79f7d3713))
* **server,core:** expose acl_managed on relationship rows ([#2843](https://github.com/lobu-ai/lobu/issues/2843)) ([d727440](https://github.com/lobu-ai/lobu/commit/d7274409835a894335e276e1b88a6b19d90c0edb))
* **server,core:** report relationship-type purpose on list and get ([#2837](https://github.com/lobu-ai/lobu/issues/2837)) ([2a8bc47](https://github.com/lobu-ai/lobu/commit/2a8bc47aa65829b3e8a9606e6006a1861532f4b2))
* **server:** expose device_workers through query_sql, owner-scoped ([#2922](https://github.com/lobu-ai/lobu/issues/2922)) ([4b9d5f4](https://github.com/lobu-ai/lobu/commit/4b9d5f49dfd4326a6e85a51e6786caeaf0a6838d))
* **server:** per-type entity write rules, enforced at the write seam ([#2842](https://github.com/lobu-ai/lobu/issues/2842)) ([006f3c5](https://github.com/lobu-ai/lobu/commit/006f3c568f4546a544695200ed12f4b3df6ecadb))
* **worker:** execute device Automations in the connector-worker daemon ([#2902](https://github.com/lobu-ai/lobu/issues/2902)) ([0703a0e](https://github.com/lobu-ai/lobu/commit/0703a0efcd61a97b9bcb02a543564a1e3397a058))


### Bug Fixes

* **automations:** contain a write-rule escalate to its promoted row ([#2923](https://github.com/lobu-ai/lobu/issues/2923)) ([561f0db](https://github.com/lobu-ai/lobu/commit/561f0dbe58cb04ed448df9c9d70f26c3b27b1a6d))
* **automations:** contain a write-rule verdict on a promoted CREATE ([#2924](https://github.com/lobu-ai/lobu/issues/2924)) ([fd1511d](https://github.com/lobu-ai/lobu/commit/fd1511d9c31c59806614af39b1a506d5ee0b36ca))
* **automations:** make a stalled device Automation diagnosable ([#2937](https://github.com/lobu-ai/lobu/issues/2937)) ([e5ccc1e](https://github.com/lobu-ai/lobu/commit/e5ccc1ee28e44f9f58316db7677c353ac8240264))
* **automations:** record a refused promote in the run change set ([#2927](https://github.com/lobu-ai/lobu/issues/2927)) ([7d022a4](https://github.com/lobu-ai/lobu/commit/7d022a46e6f0b7ddfab67193c538cf80ea484389))
* **chart:** make registry credentials opt-in ([#2779](https://github.com/lobu-ai/lobu/issues/2779)) ([2ea1e6c](https://github.com/lobu-ai/lobu/commit/2ea1e6c45490e7c8f20983f1fa4e82a1a9ba4392))
* **ci:** exempt Owletto build scripts from ui-review hosted proof ([#2928](https://github.com/lobu-ai/lobu/issues/2928)) ([6c8f9f3](https://github.com/lobu-ai/lobu/commit/6c8f9f3b7efc682bd925e85ed592ec0f893ab065))
* **ci:** exempt the vendored Barman Cloud manifests from the naming gate ([#2939](https://github.com/lobu-ai/lobu/issues/2939)) ([77f8efc](https://github.com/lobu-ai/lobu/commit/77f8efcfec2ffa48b4f85a465de87defe49ea0e7))
* **ci:** exempt unhosted Owletto trees from ui-review hosted proof ([#2905](https://github.com/lobu-ai/lobu/issues/2905)) ([4f901bf](https://github.com/lobu-ai/lobu/commit/4f901bfe7f62ab38edb2304eb7d13d47c3e74709))
* **ci:** fail closed when daytona CLI is present but unusable ([#2934](https://github.com/lobu-ai/lobu/issues/2934)) ([433b0e1](https://github.com/lobu-ai/lobu/commit/433b0e1aabd57ad6b12a42a18afda37133f6d591))
* **connections:** backfill legacy unowned private connections before removing admin visibility arm ([#2892](https://github.com/lobu-ai/lobu/issues/2892)) ([535c338](https://github.com/lobu-ai/lobu/commit/535c338298142bd872b876e427642cdc8b678287))
* **deploy:** skip the migration quiesce for backward-compatible migrations ([#2921](https://github.com/lobu-ai/lobu/issues/2921)) ([170e171](https://github.com/lobu-ai/lobu/commit/170e171075986a758b99979b86574058e092b24f))
* **gateway:** deliver terminal thread_response locally on the final attempt ([#2901](https://github.com/lobu-ai/lobu/issues/2901)) ([883b577](https://github.com/lobu-ai/lobu/commit/883b5779572fc2dd60dc0c43405ad7a45bd3b71c))
* **mcp-apps:** honour the asset content digest and scope base injection to head ([#2897](https://github.com/lobu-ai/lobu/issues/2897)) ([fe27eb8](https://github.com/lobu-ai/lobu/commit/fe27eb89f7e52f6acdef5aaf5703f1749c8a0a0a))
* **mcp-apps:** serve absolute asset URLs so Claude can render the card ([#2915](https://github.com/lobu-ai/lobu/issues/2915)) ([8d1a349](https://github.com/lobu-ai/lobu/commit/8d1a349a1a06c596cfca541ab4d75e6a4fe0a306))
* **mcp:** bind MCP resource to the host the client actually called ([#2893](https://github.com/lobu-ai/lobu/issues/2893)) ([ddbc043](https://github.com/lobu-ai/lobu/commit/ddbc043ee46d8de99994012fad1a5f91dfb1fd25))
* **notifications:** make the approval chat-origin tier work for preview orgs ([#2916](https://github.com/lobu-ai/lobu/issues/2916)) ([8995c8f](https://github.com/lobu-ai/lobu/commit/8995c8f2cda48684b76db927d1d84421e55da813))
* **notifications:** stop approvals fanning out to every bound channel ([#2906](https://github.com/lobu-ai/lobu/issues/2906)) ([9a2ee35](https://github.com/lobu-ai/lobu/commit/9a2ee35567c87875e81e6eccc1e2a3a980c60d43))
* re-stage biome auto-fixes in pre-commit hook ([#2881](https://github.com/lobu-ai/lobu/issues/2881)) ([817f985](https://github.com/lobu-ai/lobu/commit/817f9857a4a81ee7d378d4dbca7eb67631a6c526))
* **review:** default the Claude reviewer to Opus instead of Fable ([#2898](https://github.com/lobu-ai/lobu/issues/2898)) ([e48b684](https://github.com/lobu-ai/lobu/commit/e48b68435bba0782a643b66976d59972d6371674))
* **review:** end teardown when a process group cannot be signalled ([#2896](https://github.com/lobu-ai/lobu/issues/2896)) ([0d6fbb3](https://github.com/lobu-ai/lobu/commit/0d6fbb3a4d78d1dedc7074579ea0501a03c9c41e))
* **server,cli:** resolve entity-type slugs through one canonical normalizer ([#2762](https://github.com/lobu-ai/lobu/issues/2762)) ([4770346](https://github.com/lobu-ai/lobu/commit/4770346a108b8b14c3f9e39f87ee4c30d6360325))
* **server:** an escalated approval card applies atomically or not at all ([#2919](https://github.com/lobu-ai/lobu/issues/2919)) ([da4484e](https://github.com/lobu-ai/lobu/commit/da4484ed662e7467c380cf8c9ec3a094485c7572))
* **server:** gate agent create and inference-provider mutations to owner/admin ([#2914](https://github.com/lobu-ai/lobu/issues/2914)) ([8b569c5](https://github.com/lobu-ai/lobu/commit/8b569c5a0ae94c1a8e3e69e86d470d1e18464060))
* **server:** gate agent management mutations to owner/admin ([#2899](https://github.com/lobu-ai/lobu/issues/2899)) ([95e0fdf](https://github.com/lobu-ai/lobu/commit/95e0fdf0d729c5ed5fb98683d36219c5102f3e65))
* **server:** gate approval-waived entity writes behind a module boundary ([#2903](https://github.com/lobu-ai/lobu/issues/2903)) ([ad3bb80](https://github.com/lobu-ai/lobu/commit/ad3bb800d4e83e1994b6f4bd672f8f286295a30c))
* **server:** keep the ACL-managed half of an inverse relationship pair ([#2844](https://github.com/lobu-ai/lobu/issues/2844)) ([976b68a](https://github.com/lobu-ai/lobu/commit/976b68aa6172c108f9c3b82aec8ce4f1cba3da3c))
* **server:** reuse headless device identity on child-token re-mint ([#2911](https://github.com/lobu-ai/lobu/issues/2911)) ([38b4cac](https://github.com/lobu-ai/lobu/commit/38b4cacb70e493b0cd8752403d383e99a569867c))
* **server:** seed device autowire connections from default_connection_config ([#2841](https://github.com/lobu-ai/lobu/issues/2841)) ([e883f18](https://github.com/lobu-ai/lobu/commit/e883f18b5caf7d5aa6397e11020e5c801cf3bc49))
* **server:** tell agents which relationship types refuse writes ([#2840](https://github.com/lobu-ai/lobu/issues/2840)) ([9ffbefc](https://github.com/lobu-ai/lobu/commit/9ffbefc926556ed2ffe4aded03d8fa04a0877bbf))
* **server:** union repeated escalate verdicts in entity rules ([#2910](https://github.com/lobu-ai/lobu/issues/2910)) ([f66db5b](https://github.com/lobu-ai/lobu/commit/f66db5bc8ad92b9d7cc23a954581142ca074be5a))


### Performance Improvements

* **server:** memoize compiled sandbox sources by content hash ([#2838](https://github.com/lobu-ai/lobu/issues/2838)) ([7f70ab9](https://github.com/lobu-ai/lobu/commit/7f70ab985ac1acfe29c208cbd8f6141764fb26d0))

## [15.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.22.0...lobu-v15.0.0) (2026-08-17)


### ⚠ BREAKING CHANGES

* **connector-sdk:** IdentityNamespaceDefinition no longer declares uniquePerOrg, and the entries in IDENTITY_NAMESPACE_REGISTRY no longer carry it. Nothing consumed the field — uniqueness is enforced solely by the blanket idx_entity_identities_live_unique index — so there is no behavioural change and no migration to perform. Consumers reading definition.uniquePerOrg should drop the read; consumers needing per-namespace uniqueness should track #2798.
* make Automation canonical ([#2784](https://github.com/lobu-ai/lobu/issues/2784))

### Features

* allow reaction-only Automations (prompt optional) with codified-vs-agentic UI ([#2822](https://github.com/lobu-ai/lobu/issues/2822)) ([a79c6ef](https://github.com/lobu-ai/lobu/commit/a79c6ef5845fa84d9248af3b13c86b2d230e4355))
* **attention:** browser-handoff drafts stay until Done + HN draft staging + device-pinned behaviors ([#2758](https://github.com/lobu-ai/lobu/issues/2758)) ([d9d42aa](https://github.com/lobu-ai/lobu/commit/d9d42aa908b7cde6b32c4aac36adf7fef7e559ed))
* **behaviors:** route notifications to one channel ([#2789](https://github.com/lobu-ai/lobu/issues/2789)) ([140b000](https://github.com/lobu-ai/lobu/commit/140b000bed631df5eeb72077ccde0f2523ad6201))
* **browser:** activate operations on visited pages ([#2734](https://github.com/lobu-ai/lobu/issues/2734)) ([3180c94](https://github.com/lobu-ai/lobu/commit/3180c94e2015b793a9620a3609a224e78e388010))
* **ci:** make Owletto pointer updates non-blocking ([#2782](https://github.com/lobu-ai/lobu/issues/2782)) ([ed46903](https://github.com/lobu-ai/lobu/commit/ed46903951e394ef521403085ab90c3ec750abc3))
* **cli:** add field() shorthand for entity properties; route CI by trusted author ([#2823](https://github.com/lobu-ai/lobu/issues/2823)) ([5d1ef28](https://github.com/lobu-ai/lobu/commit/5d1ef28f3d5843a9a1d2b724ee8c0f26baada8d7))
* **cli:** add on/every/context shorthands for automation triggers and sources ([#2819](https://github.com/lobu-ai/lobu/issues/2819)) ([228c75b](https://github.com/lobu-ai/lobu/commit/228c75b4409101a2f512d6eedd24344a264c7380))
* **connectors:** sync Revolut investment balances ([#2693](https://github.com/lobu-ai/lobu/issues/2693)) ([60b0151](https://github.com/lobu-ai/lobu/commit/60b0151ce3d2cedec74cf469dd7f7b9e1b4094a3))
* make Automation canonical ([#2784](https://github.com/lobu-ai/lobu/issues/2784)) ([03c2904](https://github.com/lobu-ai/lobu/commit/03c2904aea0fed68adfa17898ac08bc1acc4baae))
* **personal-agent:** consolidate household net worth ([#2737](https://github.com/lobu-ai/lobu/issues/2737)) ([7e6d247](https://github.com/lobu-ai/lobu/commit/7e6d2477b9d504eecf39247424c93a6cc8287c4c))
* **review:** skip LLM passes for deterministic changes ([#2780](https://github.com/lobu-ai/lobu/issues/2780)) ([0e64b7b](https://github.com/lobu-ai/lobu/commit/0e64b7bee69d2d99208cf68295ce499de5193c47))
* **review:** skip the cross-harness review for pure submodule pointer bumps ([#2773](https://github.com/lobu-ai/lobu/issues/2773)) ([1d11ce9](https://github.com/lobu-ai/lobu/commit/1d11ce9b4b11af742bf905d145b0510a92e674d3))
* **server:** classify authorization-bearing relationship types ([#2825](https://github.com/lobu-ai/lobu/issues/2825)) ([629b531](https://github.com/lobu-ai/lobu/commit/629b5314c9d1ffeaf808ea26672e1a9c31bc7623))
* **server:** classify member_of as authorization-bearing ([#2833](https://github.com/lobu-ai/lobu/issues/2833)) ([87e9f69](https://github.com/lobu-ai/lobu/commit/87e9f6945c5ab85e91f8ff9d88f994dd97c40628))
* **server:** complete Atlassian Rovo Jira feeds [client-regen-not-needed] ([#2733](https://github.com/lobu-ai/lobu/issues/2733)) ([dcfd8ae](https://github.com/lobu-ai/lobu/commit/dcfd8aed89c2d23767f87c9e1a3d052d0e63ee08))
* **server:** deliver Jira webhooks through Atlassian MCP ([#2745](https://github.com/lobu-ai/lobu/issues/2745)) ([96665f2](https://github.com/lobu-ai/lobu/commit/96665f25d8d26dee3aff0fa3ffc313dbf1a3614e))
* **server:** give Atlassian Rovo MCP the Jira virtual issues feed ([#2731](https://github.com/lobu-ai/lobu/issues/2731)) ([d5b86cc](https://github.com/lobu-ai/lobu/commit/d5b86cca7ec245c234fa624ca4c510c7b7ec49b6))
* **server:** lower the declared asOf metric read mode ([#2766](https://github.com/lobu-ai/lobu/issues/2766)) ([88fa2e8](https://github.com/lobu-ai/lobu/commit/88fa2e84d36da716d2bff4326953617e14d1ed10))
* **server:** record edge change history for link, unlink and update_link ([#2807](https://github.com/lobu-ai/lobu/issues/2807)) ([e76dcc1](https://github.com/lobu-ai/lobu/commit/e76dcc1b3f531b8cc29e857ad276fa3473e93fcd)), closes [#2805](https://github.com/lobu-ai/lobu/issues/2805)
* **server:** surface ACL sync failures instead of failing silently ([#2788](https://github.com/lobu-ai/lobu/issues/2788)) ([078be4c](https://github.com/lobu-ai/lobu/commit/078be4c03a7d61c693c033be89196fb4b41c7c6a))
* **ui-review:** pass deploy-only Owletto pointer moves as not applicable ([#2767](https://github.com/lobu-ai/lobu/issues/2767)) ([e6f605b](https://github.com/lobu-ai/lobu/commit/e6f605b8df5c2c477255417cbf0322ac27459021))
* **x-connector:** support scraping the user's open x.com tab for home_feed ([#2755](https://github.com/lobu-ai/lobu/issues/2755)) ([d4ec400](https://github.com/lobu-ai/lobu/commit/d4ec4003dea79fd9d68771794ff916dc0f2e5ea4))


### Bug Fixes

* **apply:** never block or prune system-tagged Behaviors ([#2783](https://github.com/lobu-ai/lobu/issues/2783)) ([5fce260](https://github.com/lobu-ai/lobu/commit/5fce2601c7f3214a9ba21292db4ec2add83229f9))
* **auth:** preserve extension sidebar organization ([#2746](https://github.com/lobu-ai/lobu/issues/2746)) ([875095e](https://github.com/lobu-ai/lobu/commit/875095e13b6439aeb21da45c248de313f120c0f7))
* **cli:** treat ACL-managed relationship types as platform-owned in apply ([#2827](https://github.com/lobu-ai/lobu/issues/2827)) ([b4ce5d4](https://github.com/lobu-ai/lobu/commit/b4ce5d435717f1f658c969809092ef689872e56f))
* **connectors:** align health and deletion lifecycle ([#2775](https://github.com/lobu-ai/lobu/issues/2775)) ([e6c8778](https://github.com/lobu-ai/lobu/commit/e6c87789f31ac5a438133468d3f88cb5064c96e4))
* **connectors:** expose Jira webhook delivery scopes ([#2753](https://github.com/lobu-ai/lobu/issues/2753)) ([4eccc45](https://github.com/lobu-ai/lobu/commit/4eccc458b965f41e6db659c192dbba2af4c6b698))
* **example:** describe page-activated browser drafts ([#2738](https://github.com/lobu-ai/lobu/issues/2738)) ([41e5f09](https://github.com/lobu-ai/lobu/commit/41e5f096ea45b2fc59296ec27c2ed440141d4f9a))
* **example:** do not close Midas holdings a partial render has not painted ([#2722](https://github.com/lobu-ai/lobu/issues/2722)) ([2f10837](https://github.com/lobu-ai/lobu/commit/2f1083709c2615ab8c11ce9f18ed5b3e0cdc3432))
* **examples:** adopt Lobu Team lunch schema ([#2725](https://github.com/lobu-ai/lobu/issues/2725)) ([6f642b4](https://github.com/lobu-ai/lobu/commit/6f642b41ad5f721239731d99d2ae5c2ebd4193f0))
* **examples:** avoid archived Lobu Team Behavior slugs ([#2723](https://github.com/lobu-ai/lobu/issues/2723)) ([644e150](https://github.com/lobu-ai/lobu/commit/644e150c11a93ccd0d904a3fde08e0c2baee5085))
* **examples:** make Lobu Team digest headless-safe ([#2729](https://github.com/lobu-ai/lobu/issues/2729)) ([d88d52c](https://github.com/lobu-ai/lobu/commit/d88d52cc4462629dc4cfc72274599c9a440451f8))
* **examples:** pre-approve digest completion ([#2730](https://github.com/lobu-ai/lobu/issues/2730)) ([bcf37e6](https://github.com/lobu-ai/lobu/commit/bcf37e683e0f03f42f17163fdb627b2d7a7770f1))
* **example:** wait for Midas position rows ([#2724](https://github.com/lobu-ai/lobu/issues/2724)) ([b4b390e](https://github.com/lobu-ai/lobu/commit/b4b390e80d90f8a775a775b6f3b6e4e23dfc3f4f))
* **handoff:** retry stale composer refs on X + Open post opens a fresh tab ([#2768](https://github.com/lobu-ai/lobu/issues/2768)) ([d973ebe](https://github.com/lobu-ai/lobu/commit/d973ebe7b1887380fd063980bcbeda941dcea415))
* **mcp:** decouple data tools from app rendering ([#2763](https://github.com/lobu-ai/lobu/issues/2763)) ([c314660](https://github.com/lobu-ai/lobu/commit/c3146601cb1eb2d9ad264c0094aac9c8aa1095c4))
* **mcp:** make approval apps resume hosts ([#2828](https://github.com/lobu-ai/lobu/issues/2828)) ([7f48127](https://github.com/lobu-ai/lobu/commit/7f481272b1a418c2935e0cad5856801a081d0829))
* **mcp:** rehydrate approval apps after reload ([#2831](https://github.com/lobu-ai/lobu/issues/2831)) ([d29877b](https://github.com/lobu-ai/lobu/commit/d29877b1f88551fa4d68fe20d14183b6918ed24e))
* **mcp:** render saved memory inline ([#2793](https://github.com/lobu-ai/lobu/issues/2793)) ([b331352](https://github.com/lobu-ai/lobu/commit/b3313527a87872e90f790b3ebfbb0b62d4780999))
* **mcp:** simplify app approvals ([#2814](https://github.com/lobu-ai/lobu/issues/2814)) ([3b5766f](https://github.com/lobu-ai/lobu/commit/3b5766f792f498b3e4e6b35d5b6b124ec0715097))
* **owletto:** render SDK results for MCP clients, not just the Lobu SPA ([#2756](https://github.com/lobu-ai/lobu/issues/2756)) ([9d59c6a](https://github.com/lobu-ai/lobu/commit/9d59c6a158ddd159c25a94c9ac5c9a97a991c87a))
* **personal-agent:** route task behavior through Hetzner ([#2778](https://github.com/lobu-ai/lobu/issues/2778)) ([a3e887a](https://github.com/lobu-ai/lobu/commit/a3e887a0857f0d13e3cacc5ae64a0da1dbf4162e))
* **personal-agent:** version net-worth idempotency keys ([#2727](https://github.com/lobu-ai/lobu/issues/2727)) ([69eee6a](https://github.com/lobu-ai/lobu/commit/69eee6a17930aae21a4f484e5eed9ae5a533fd98))
* **security:** keep worker tokens out of run history ([#2774](https://github.com/lobu-ai/lobu/issues/2774)) ([0b82326](https://github.com/lobu-ai/lobu/commit/0b8232639a484310842be44eb0c84ac4a20aa36e))
* **server,owletto:** surface truncated columns and started side effects in run_sdk results ([#2748](https://github.com/lobu-ai/lobu/issues/2748)) ([968e54f](https://github.com/lobu-ai/lobu/commit/968e54f1ea69c3ce5295e4dc5bf436c5c2fa9448))
* **server:** bound the cleanup TRUNCATE lock wait instead of hanging ([#2820](https://github.com/lobu-ai/lobu/issues/2820)) ([3d92ace](https://github.com/lobu-ai/lobu/commit/3d92aceaaf31b2ff15be775669cf7365e2d516a4))
* **server:** close prod-readiness auth and device lifecycle gaps ([#2757](https://github.com/lobu-ai/lobu/issues/2757)) ([28c13d2](https://github.com/lobu-ai/lobu/commit/28c13d20e51c518f2f7b3f4749c1316dcfc12a63))
* **server:** copy event lineage on supersede ([#2732](https://github.com/lobu-ai/lobu/issues/2732)) ([4f14ab4](https://github.com/lobu-ai/lobu/commit/4f14ab4050c5a5124d5b09135ae835b5bf7c0396))
* **server:** count connection-scoped MCP operations on get/list ([#2728](https://github.com/lobu-ai/lobu/issues/2728)) ([bd13740](https://github.com/lobu-ai/lobu/commit/bd13740cec505e095ea38f11252b01b446c61462))
* **server:** declare the stored relationship source vocabulary and protect reconciled edges ([#2810](https://github.com/lobu-ai/lobu/issues/2810)) ([69206db](https://github.com/lobu-ai/lobu/commit/69206db42b4c5373514f9bb869f21aaa3dc998a1)), closes [#2811](https://github.com/lobu-ai/lobu/issues/2811) [#2799](https://github.com/lobu-ai/lobu/issues/2799)
* **server:** harden ACL sync failure observability ([#2790](https://github.com/lobu-ai/lobu/issues/2790)) ([a665ec5](https://github.com/lobu-ai/lobu/commit/a665ec5a5c3babd8cf137347d27be4d72bed1b26))
* **server:** make connector entity writes atomic ([#2808](https://github.com/lobu-ai/lobu/issues/2808)) ([dd4207d](https://github.com/lobu-ai/lobu/commit/dd4207d31218aae92984cd39b14c43509dba33f1))
* **server:** preserve behavior attribution on approvals ([#2726](https://github.com/lobu-ai/lobu/issues/2726)) ([c612a5e](https://github.com/lobu-ai/lobu/commit/c612a5e2edc019cba7dd14828d3793388473c20f))
* **server:** prod-health fixes — z.ai removal, MCP refresh-on-401, member-claim healing, reaction retry, 4xx tool errors ([#2744](https://github.com/lobu-ai/lobu/issues/2744)) ([d7ea443](https://github.com/lobu-ai/lobu/commit/d7ea4437d35fc4232aa50432b3a7114eda7a144d))
* **server:** redact connector signature headers ([#2791](https://github.com/lobu-ai/lobu/issues/2791)) ([0748e11](https://github.com/lobu-ai/lobu/commit/0748e11317a21e8c7b1ace36c481e25cd1b1829a))
* **server:** register URI tool format ([#2739](https://github.com/lobu-ai/lobu/issues/2739)) ([337d147](https://github.com/lobu-ai/lobu/commit/337d1472542681cb2606b07c01fe0069f43eb94b))
* **server:** scope Jira dynamic webhooks to visible projects ([#2751](https://github.com/lobu-ai/lobu/issues/2751)) ([cc0c97f](https://github.com/lobu-ai/lobu/commit/cc0c97f7549c7067e17c4cd4497902caa8e064a2))
* **server:** serialize ACL syncs per connection and fence the projection ([#2830](https://github.com/lobu-ai/lobu/issues/2830)) ([30e506c](https://github.com/lobu-ai/lobu/commit/30e506c7e03daabbc321f44a35683af55352b0fa))
* **server:** serialize classifier entity enablement ([#2800](https://github.com/lobu-ai/lobu/issues/2800)) ([dba3767](https://github.com/lobu-ai/lobu/commit/dba3767563dcf1604c75cc9e863323d36c63a3d9))
* **server:** stop passing retired Behavior REST args ([#2720](https://github.com/lobu-ai/lobu/issues/2720)) ([6e4d66f](https://github.com/lobu-ai/lobu/commit/6e4d66f29d5cb25a58d4699fbcbee02204eb1240))
* **server:** stop validating the metadata clear sentinel as a value ([#2770](https://github.com/lobu-ai/lobu/issues/2770)) ([3922c87](https://github.com/lobu-ai/lobu/commit/3922c877d7f04fd9c201b4e179d941830679f9a7))
* **server:** thread the caller's handle through entity-write helpers ([#2829](https://github.com/lobu-ai/lobu/issues/2829)) ([acb9c26](https://github.com/lobu-ai/lobu/commit/acb9c262e5fe62e33bf16008e526ce1bc2d66c3e))
* **server:** verify Atlassian webhook bearer JWTs ([#2754](https://github.com/lobu-ai/lobu/issues/2754)) ([b261cf7](https://github.com/lobu-ai/lobu/commit/b261cf7ed61a21e6e16bcd67870236f630ad4930))
* **slack:** invalidate ACL freshness on channel membership changes ([#2771](https://github.com/lobu-ai/lobu/issues/2771)) ([b6e36ad](https://github.com/lobu-ai/lobu/commit/b6e36adaca80a3e935bdc7d2e21edda32129b3ef))


### Reverts

* **server:** move Lobu Team digest out of core ([#2717](https://github.com/lobu-ai/lobu/issues/2717)) ([3fb2a5b](https://github.com/lobu-ai/lobu/commit/3fb2a5b4134b0bd27190ce10e2bad12e63374382))


### Code Refactoring

* **connector-sdk:** drop the dead uniquePerOrg identity flag ([#2817](https://github.com/lobu-ai/lobu/issues/2817)) ([9519967](https://github.com/lobu-ai/lobu/commit/9519967ae408509914cea96111b0e9e742a76422)), closes [#2798](https://github.com/lobu-ai/lobu/issues/2798)

## [14.22.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.21.0...lobu-v14.22.0) (2026-08-13)


### Features

* **cli:** sync managed MCP connectors automatically ([#2714](https://github.com/lobu-ai/lobu/issues/2714)) ([a1ce960](https://github.com/lobu-ai/lobu/commit/a1ce9606f58ee61bef89b983900fbf50ffe2f108))
* **discovery:** add Claude Code plugin marketplace ([#2682](https://github.com/lobu-ai/lobu/issues/2682)) ([3981db7](https://github.com/lobu-ai/lobu/commit/3981db7ff3a9734eb8cddbce162a1c53b33e252b))


### Bug Fixes

* **ci:** pass --timeout 30000 to every bun test lane ([#2711](https://github.com/lobu-ai/lobu/issues/2711)) ([6ab5f0d](https://github.com/lobu-ai/lobu/commit/6ab5f0d305e76d621222357242a28d69184dc9ad))

## [14.21.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.20.0...lobu-v14.21.0) (2026-08-12)


### Features

* **apply:** drift gate blocks un-declared remote changes ([#2663](https://github.com/lobu-ai/lobu/issues/2663)) ([05adcd1](https://github.com/lobu-ai/lobu/commit/05adcd18a8e00f995b7c05d8a17bbb8762fe94ca))
* **behaviors:** chain durable workspace events ([#2660](https://github.com/lobu-ai/lobu/issues/2660)) ([c8c5eea](https://github.com/lobu-ai/lobu/commit/c8c5eeaaf8af9f573dddc40edccf49c024e224a4))
* **cli:** show before → after values in the apply plan ([#2692](https://github.com/lobu-ai/lobu/issues/2692)) ([1b8eeab](https://github.com/lobu-ai/lobu/commit/1b8eeab41ac1c16ac425b028094354d616b57408))
* **connector-worker:** run os.files device connectors on a local worker ([#2687](https://github.com/lobu-ai/lobu/issues/2687)) ([caf3e99](https://github.com/lobu-ai/lobu/commit/caf3e9916ef89f6595c55a5fc5c3e842deccb09d))
* **connectors:** gmail person-relevant sync + declarative resolution policy ([#2646](https://github.com/lobu-ai/lobu/issues/2646)) ([32fc86b](https://github.com/lobu-ai/lobu/commit/32fc86b2648bc1c82537f8ee442aed66eb7663a5))
* **dev:** add private Daytona remote development ([#2659](https://github.com/lobu-ai/lobu/issues/2659)) ([9bb8021](https://github.com/lobu-ai/lobu/commit/9bb80218b27966e806f8507a5cf8879b4c11fbd3))
* **example:** add a Maps feed to the Google Takeout connector ([#2697](https://github.com/lobu-ai/lobu/issues/2697)) ([a4c5ee4](https://github.com/lobu-ai/lobu/commit/a4c5ee465922f29be07f3744c3fccf5a9cb978ff))
* **mcp:** consolidate result tooling and connector branding ([#2667](https://github.com/lobu-ai/lobu/issues/2667)) ([c67bda3](https://github.com/lobu-ai/lobu/commit/c67bda31f5103c63c96e3e35b7a3ebaa5bde7e13))
* **mcp:** drop the undeclared-result guesswork tier ([#2690](https://github.com/lobu-ai/lobu/issues/2690)) ([e6282cc](https://github.com/lobu-ai/lobu/commit/e6282cc3f4076d6ce4612265ca88facdb2f9dcd1))
* **mcp:** render and restore rich app results ([#2643](https://github.com/lobu-ai/lobu/issues/2643)) ([c91edd7](https://github.com/lobu-ai/lobu/commit/c91edd74515b87fcc53c0e89e56b448762e4bcf3))
* **personal-agent:** add live Midas net worth snapshots ([#2702](https://github.com/lobu-ai/lobu/issues/2702)) ([39809f8](https://github.com/lobu-ai/lobu/commit/39809f886df4158d92a0b5f06cc6a60c2e5cedb2))
* **server:** derive Behavior activation from collected feed events ([#2664](https://github.com/lobu-ai/lobu/issues/2664)) ([77e15b0](https://github.com/lobu-ai/lobu/commit/77e15b0ce8c2c1d3b398ba7ab297cfbe178fa04d))
* **server:** install OAuth-protected MCP connectors ([#2695](https://github.com/lobu-ai/lobu/issues/2695)) ([56e9520](https://github.com/lobu-ai/lobu/commit/56e95208f302c4b2478e3ab8d5361419f0e39009))
* **server:** record workspace-identity audit events for org/member/invitation lifecycle ([#2662](https://github.com/lobu-ai/lobu/issues/2662)) ([1cfd8c2](https://github.com/lobu-ai/lobu/commit/1cfd8c2f0cefd6bf1dc16e0212bc895514b46a54))
* **server:** render rich notifications through event kinds ([#2648](https://github.com/lobu-ai/lobu/issues/2648)) ([cb5a1b0](https://github.com/lobu-ai/lobu/commit/cb5a1b08a30fc70c777c6db9b5a0d59f8fb6e535))
* **server:** send production activity digests ([#2700](https://github.com/lobu-ai/lobu/issues/2700)) ([54fd729](https://github.com/lobu-ai/lobu/commit/54fd729f202afd9e3d2b2f2be83c32848070fcd6))


### Bug Fixes

* **calendar:** persist durable sync cursor ([#2628](https://github.com/lobu-ai/lobu/issues/2628)) ([9abe1af](https://github.com/lobu-ai/lobu/commit/9abe1af5a1f6f4a46dd062d9f1176690ac355177))
* **ci:** give local Depot dispatches their own concurrency group ([#2707](https://github.com/lobu-ai/lobu/issues/2707)) ([9c2fba7](https://github.com/lobu-ai/lobu/commit/9c2fba7e6f2cb75493138f25265eb0e9909cacd2))
* **ci:** pin bun in images and retry GitHub release downloads ([#2704](https://github.com/lobu-ai/lobu/issues/2704)) ([b813df1](https://github.com/lobu-ai/lobu/commit/b813df166b27cf50c6c36b7a4526d6509eef5075))
* **cli:** distinguish an unrecorded apply baseline from an empty one ([#2686](https://github.com/lobu-ai/lobu/issues/2686)) ([9411ee0](https://github.com/lobu-ai/lobu/commit/9411ee0c55e60b947a880a048c88372727c7bc41))
* **cli:** identify remote-only definitions in the apply block report ([#2698](https://github.com/lobu-ai/lobu/issues/2698)) ([8ea9ede](https://github.com/lobu-ai/lobu/commit/8ea9ede8f7a6a39ed679fc3a0f2a60c7fa5ab681))
* **cli:** scope apply's definition-delete block to prune ([#2689](https://github.com/lobu-ai/lobu/issues/2689)) ([2d10451](https://github.com/lobu-ai/lobu/commit/2d10451fe78b17f85af3136c6c28976b8e6924f8))
* **cli:** scope the apply view-template fetch to org-owned types ([#2658](https://github.com/lobu-ai/lobu/issues/2658)) ([0865d7c](https://github.com/lobu-ai/lobu/commit/0865d7c2b37bfa87d83e5e79d08d72ca79601965))
* **connectors:** declare os.files + macos runtime on the takeout connectors ([#2685](https://github.com/lobu-ai/lobu/issues/2685)) ([a96bc45](https://github.com/lobu-ai/lobu/commit/a96bc452253404c416b396b4603331e85cba7746))
* **example:** resolve takeout dirs strictly and declare gmail auth profiles ([#2688](https://github.com/lobu-ai/lobu/issues/2688)) ([714a24b](https://github.com/lobu-ai/lobu/commit/714a24b43fb751d4f49cd8765608b39f6524662a))
* **example:** stop takeout connectors naming people by URL or reserved route ([#2694](https://github.com/lobu-ai/lobu/issues/2694)) ([ee53448](https://github.com/lobu-ai/lobu/commit/ee534485162d64ac3651006050affb0fc08df884))
* **mcp-app:** restore results without host tool info ([#2665](https://github.com/lobu-ai/lobu/issues/2665)) ([36a1c54](https://github.com/lobu-ai/lobu/commit/36a1c540add41ec3fe0c43a882bb5d5ad25089ad))
* **mcp:** deliver app snapshot capability through host arguments ([#2652](https://github.com/lobu-ai/lobu/issues/2652)) ([633a2bb](https://github.com/lobu-ai/lobu/commit/633a2bb3a265e99654efaa467212783a09d33889))
* **mcp:** emit viewer role on app-rendered results ([#2671](https://github.com/lobu-ai/lobu/issues/2671)) ([04deeb6](https://github.com/lobu-ai/lobu/commit/04deeb68ab019fc35280d032b5ea66c48e11ae08))
* **mcp:** harden ChatGPT review contract ([#2670](https://github.com/lobu-ai/lobu/issues/2670)) ([bcce57e](https://github.com/lobu-ai/lobu/commit/bcce57eee0e6a2d9d1790ba92e3799205553b323))
* **mcp:** resolve exact memory ids in search ([#2669](https://github.com/lobu-ai/lobu/issues/2669)) ([7c51e7d](https://github.com/lobu-ai/lobu/commit/7c51e7d67943ca871c544a49729754bba90acc0c))
* **mcp:** restore app cards by host identity ([#2647](https://github.com/lobu-ai/lobu/issues/2647)) ([d2b0e51](https://github.com/lobu-ai/lobu/commit/d2b0e518279c11a466f0a60721dcaf0fc4d013ce))
* **mcp:** serve self-contained v7 app resource ([#2642](https://github.com/lobu-ai/lobu/issues/2642)) ([8368ba5](https://github.com/lobu-ai/lobu/commit/8368ba57e30fc4430fb5370627622853fc08fdf9))
* **mcp:** ship reload-safe v6 app bundle ([#2640](https://github.com/lobu-ai/lobu/issues/2640)) ([be3a91b](https://github.com/lobu-ai/lobu/commit/be3a91b6baf8ee902d78f00013d001c20cc4e206))
* **personal-agent:** persist net worth as summary ([#2710](https://github.com/lobu-ai/lobu/issues/2710)) ([de158af](https://github.com/lobu-ai/lobu/commit/de158afda62e1fcbf6369ef3bb8a7cbeb94fd796))
* **server,example,chrome:** review-fix — reason schema, dead maxDelay, duplicate test, redundant post metadata, run-scoped tab retry ([#2680](https://github.com/lobu-ai/lobu/issues/2680)) ([12b1aa9](https://github.com/lobu-ai/lobu/commit/12b1aa997197e82cb0e4e53a22b9aa4d5795e03a))
* **server,example:** production-hardening — run expiry, feed health, gateway retry, LinkedIn durable post identity ([#2676](https://github.com/lobu-ai/lobu/issues/2676)) ([779b93a](https://github.com/lobu-ai/lobu/commit/779b93a2c741376eb83f93f90c9b1dea6a938845))
* **server:** bind remote MCP operations to connections ([#2706](https://github.com/lobu-ai/lobu/issues/2706)) ([61791c3](https://github.com/lobu-ai/lobu/commit/61791c3d11b054818bf47cd87ce556e3d7e57b17))
* **server:** block MCP sessions from approving operations ([#2651](https://github.com/lobu-ai/lobu/issues/2651)) ([f989300](https://github.com/lobu-ai/lobu/commit/f989300b92ac27b8ce654a52f5f76590d261039f))
* **server:** bound the SDK call trace so the model never gets a multi-MB trace ([#2655](https://github.com/lobu-ai/lobu/issues/2655)) ([fa892ba](https://github.com/lobu-ai/lobu/commit/fa892ba104651654130300895745216dcd74cc1a))
* **server:** consolidate sandbox output budgets into preview + per-message caps ([#2654](https://github.com/lobu-ai/lobu/issues/2654)) ([995adc3](https://github.com/lobu-ai/lobu/commit/995adc3209362c9f3b342ab140d7ded9a7edd486))
* **server:** decouple sandbox output budgets and truncate oversized returns ([#2645](https://github.com/lobu-ai/lobu/issues/2645)) ([7680b83](https://github.com/lobu-ai/lobu/commit/7680b8373e127e796fc831836ae16408bb4eef25))
* **server:** dedupe auto-provisioned connections by OAuth account ([#2656](https://github.com/lobu-ai/lobu/issues/2656)) ([1c47e21](https://github.com/lobu-ai/lobu/commit/1c47e21c01bcf4a08ecdd253de1a588dd5454d5a))
* **server:** deliver production digest to private Slack ([#2709](https://github.com/lobu-ai/lobu/issues/2709)) ([7e95d12](https://github.com/lobu-ai/lobu/commit/7e95d12cf085ab53d4452f3259ffca2af9478225))
* **server:** expose interactive notifications in ClientSDK ([#2635](https://github.com/lobu-ai/lobu/issues/2635)) ([b9a3dcc](https://github.com/lobu-ai/lobu/commit/b9a3dccbb07f835a4cfcd6c7fafc4e206788eba6))
* **server:** let behaviors use creator private connections ([#2701](https://github.com/lobu-ai/lobu/issues/2701)) ([dd8f07d](https://github.com/lobu-ai/lobu/commit/dd8f07d1e65df58fe1156ca26fa3b117463fe47c))
* **server:** make approval transitions atomic ([#2668](https://github.com/lobu-ai/lobu/issues/2668)) ([f2c0823](https://github.com/lobu-ai/lobu/commit/f2c08233e712bb5c06877f0b7e35753ae6b4f050))
* **server:** member execution of connector operations; principal-aware readiness ([#2644](https://github.com/lobu-ai/lobu/issues/2644)) ([9ace61a](https://github.com/lobu-ai/lobu/commit/9ace61a20ca4ca42040afdf5be6dcc295bc91bcf))
* **server:** raise the gateway test ceiling via CLI, not bunfig ([#2691](https://github.com/lobu-ai/lobu/issues/2691)) ([4873ecf](https://github.com/lobu-ai/lobu/commit/4873ecf9c416af64ada6eea6842fbafa31acf311))
* **server:** scope connector-health alerting to feeds that can actually sync ([#2683](https://github.com/lobu-ai/lobu/issues/2683)) ([deb351f](https://github.com/lobu-ai/lobu/commit/deb351f767f951a9e83436d9204cf8fa1c9bef3f))
* **server:** stub tooling fold in fake-based MessageConsumer tests ([#2674](https://github.com/lobu-ai/lobu/issues/2674)) ([72cf989](https://github.com/lobu-ai/lobu/commit/72cf989745863096ea6c2b4aea8d77d1f6019231))

## [14.20.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.19.0...lobu-v14.20.0) (2026-08-10)


### Features

* **behaviors:** close the social draft decision loop ([#2632](https://github.com/lobu-ai/lobu/issues/2632)) ([6a56f13](https://github.com/lobu-ai/lobu/commit/6a56f13b7ad5f542df85777daceb4f62660654c8))
* **mcp:** render rich tool results ([#2611](https://github.com/lobu-ai/lobu/issues/2611)) ([1d2863b](https://github.com/lobu-ai/lobu/commit/1d2863b2a8b10cd7373994d17618c6fa3ccde4f1))


### Bug Fixes

* **behaviors:** bound initial knowledge read ([#2614](https://github.com/lobu-ai/lobu/issues/2614)) ([d5b729d](https://github.com/lobu-ai/lobu/commit/d5b729d747a73d001a376c1c934c5a775eff3ab6))
* **behaviors:** bound SQL-backed context reads ([#2620](https://github.com/lobu-ai/lobu/issues/2620)) ([af011b9](https://github.com/lobu-ai/lobu/commit/af011b9f414cd8572834d43b126a04e41bbdfbf3))
* **behaviors:** honor provider retry horizons ([#2623](https://github.com/lobu-ai/lobu/issues/2623)) ([0fb06d8](https://github.com/lobu-ai/lobu/commit/0fb06d80ab876d2004de9311ad2d553408e71a17))
* **calendar:** virtualize reads and isolate OAuth grants ([#2619](https://github.com/lobu-ai/lobu/issues/2619)) ([6afd29b](https://github.com/lobu-ai/lobu/commit/6afd29b52221bdd1cee37e8caf191a8c7bcd492d))
* **connectors:** resolve active installed version ([#2626](https://github.com/lobu-ai/lobu/issues/2626)) ([7b9b395](https://github.com/lobu-ai/lobu/commit/7b9b39565d538cd13f5e37001e2f4a16c843833d))
* **mcp:** activate external v3 app template ([#2633](https://github.com/lobu-ai/lobu/issues/2633)) ([589f27f](https://github.com/lobu-ai/lobu/commit/589f27f186befa71caafc35d2a5384f6d463965f))
* **mcp:** publish accurate tool annotations ([#2624](https://github.com/lobu-ai/lobu/issues/2624)) ([e91789a](https://github.com/lobu-ai/lobu/commit/e91789ab999bdf5f925f53e929ed471bac63871b))
* **mcp:** refresh ChatGPT app template ([#2622](https://github.com/lobu-ai/lobu/issues/2622)) ([fc969bd](https://github.com/lobu-ai/lobu/commit/fc969bd9b7e361ab4dbd065ffff67e7e9957a97d))
* **mcp:** rehydrate ChatGPT sandbox cards ([#2639](https://github.com/lobu-ai/lobu/issues/2639)) ([c4b35b9](https://github.com/lobu-ai/lobu/commit/c4b35b99f79116174d0adae45b8fdfce863a17a6))
* **mcp:** render embedded results reliably ([#2613](https://github.com/lobu-ai/lobu/issues/2613)) ([8b1aa1b](https://github.com/lobu-ai/lobu/commit/8b1aa1bf9652d95d8780765cf9fb0263e0bb4cd4))
* **mcp:** restore historical ChatGPT app results ([#2637](https://github.com/lobu-ai/lobu/issues/2637)) ([d944363](https://github.com/lobu-ai/lobu/commit/d94436354b3dacfaa27e38c3299723c93f340fbe))
* **mcp:** stage app assets before v3 rollout ([#2631](https://github.com/lobu-ai/lobu/issues/2631)) ([ec16ce0](https://github.com/lobu-ai/lobu/commit/ec16ce016ad0130699910d597dc91f6d5b6a77db))
* **server:** propagate ToolUserError status on REST wrappers ([#2625](https://github.com/lobu-ai/lobu/issues/2625)) ([7741917](https://github.com/lobu-ai/lobu/commit/7741917038774aff9745bd204152efa604280834))
* **server:** remove superseded REST window/execute routes ([#2630](https://github.com/lobu-ai/lobu/issues/2630)) ([621c81e](https://github.com/lobu-ai/lobu/commit/621c81e809cbde0eb001e0a07ee3eee423636816))
* **server:** support tableless query_sql SELECTs ([#2616](https://github.com/lobu-ai/lobu/issues/2616)) ([5e6c845](https://github.com/lobu-ai/lobu/commit/5e6c84544d9ee19e8599b68dbff2013453d56d5f))
* **whatsapp:** enable reliable voice-note transcription ([#2636](https://github.com/lobu-ai/lobu/issues/2636)) ([9a74d69](https://github.com/lobu-ai/lobu/commit/9a74d6910d5553eab36b49792d3fc1fa45a1a84e))

## [14.19.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.18.0...lobu-v14.19.0) (2026-08-09)


### Features

* **activity:** expose unified source attribution ([#2605](https://github.com/lobu-ai/lobu/issues/2605)) ([11ed6ed](https://github.com/lobu-ai/lobu/commit/11ed6edea91031f50391f9ac278d1123030c9911))
* **get_content:** expose event source attribution on ContentItem ([#2598](https://github.com/lobu-ai/lobu/issues/2598)) ([411ba6b](https://github.com/lobu-ai/lobu/commit/411ba6ba2d42b83fb90a3620583976b6e1402216))


### Bug Fixes

* **activity:** render notification source attribution ([#2601](https://github.com/lobu-ai/lobu/issues/2601)) ([6168afa](https://github.com/lobu-ai/lobu/commit/6168afa2515869e2f26f46818ea3e34e836a51aa))
* **mcp:** harden production app readiness ([#2607](https://github.com/lobu-ai/lobu/issues/2607)) ([5481500](https://github.com/lobu-ai/lobu/commit/5481500a9a4658fb8d906ed821289b0041ecf0f8))
* **mcp:** preserve Apps negotiation across replicas ([#2610](https://github.com/lobu-ai/lobu/issues/2610)) ([230111f](https://github.com/lobu-ai/lobu/commit/230111f912ab2c75ce0d61e7479d6ce86e1c602d))
* **server:** attach a Behavior run's transcript by conversation id ([#2587](https://github.com/lobu-ai/lobu/issues/2587)) ([d7a01ae](https://github.com/lobu-ai/lobu/commit/d7a01ae0e041e930ff645d14411adfe06b69eb12))
* **server:** publish complete MCP safety metadata ([#2608](https://github.com/lobu-ai/lobu/issues/2608)) ([cceda8f](https://github.com/lobu-ai/lobu/commit/cceda8f21cf872e75eaf25c265a44cd7fa17ffe9))

## [14.18.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.17.2...lobu-v14.18.0) (2026-08-08)


### Features

* **server:** promote a Behavior run into a reusable eval case ([#2584](https://github.com/lobu-ai/lobu/issues/2584)) ([b2b86eb](https://github.com/lobu-ai/lobu/commit/b2b86eb818717b0b31738154547a7f5ba8b9d122))
* **server:** score eval replays and answer whether a Behavior regressed ([#2591](https://github.com/lobu-ai/lobu/issues/2591)) ([6bd280a](https://github.com/lobu-ai/lobu/commit/6bd280ab90da9934639dfa2fb347a27506661ace))


### Bug Fixes

* **agent-worker:** route an agent's model pin that arrives via defaultModel ([#2586](https://github.com/lobu-ai/lobu/issues/2586)) ([d743d27](https://github.com/lobu-ai/lobu/commit/d743d275ec8fa367ed5e667377e9f8a20f844a91))
* **db:** repair Behavior output stamped at its window end ([#2594](https://github.com/lobu-ai/lobu/issues/2594)) ([107be7f](https://github.com/lobu-ai/lobu/commit/107be7f50eb80457180141f678d15b0b8d786820))
* **examples:** resolve radar staging browser via the connections SDK ([#2596](https://github.com/lobu-ai/lobu/issues/2596)) ([989f390](https://github.com/lobu-ai/lobu/commit/989f390dc63ea3d0929abbe3812b0889e4f108e4))
* **server:** apply analyzed_by_behavior_id on the read paths that dropped it ([#2595](https://github.com/lobu-ai/lobu/issues/2595)) ([9c2a9bc](https://github.com/lobu-ai/lobu/commit/9c2a9bc98494555716e8498a2e566f0dca582425))
* **server:** clarify Slack app-install setup guidance for external CLI users ([#2597](https://github.com/lobu-ai/lobu/issues/2597)) ([ed02be5](https://github.com/lobu-ai/lobu/commit/ed02be5eacaebe9317dce88e4cfca5c0432ae15b))
* **server:** make a Behavior's own output visible without feeding it back ([#2590](https://github.com/lobu-ai/lobu/issues/2590)) ([6c290b5](https://github.com/lobu-ai/lobu/commit/6c290b596762f558b08351aadfb965f904ab39bd))
* **server:** route an org provider whose slug differs from its kind ([#2588](https://github.com/lobu-ai/lobu/issues/2588)) ([77cbb6c](https://github.com/lobu-ai/lobu/commit/77cbb6cc25b85f175e688f3d870c8c754b8cdb41))

## [14.17.2](https://github.com/lobu-ai/lobu/compare/lobu-v14.17.1...lobu-v14.17.2) (2026-08-07)


### Bug Fixes

* **core:** stop a capture token from silently becoming a live one ([#2581](https://github.com/lobu-ai/lobu/issues/2581)) ([1b964a5](https://github.com/lobu-ai/lobu/commit/1b964a58f04b2006bbb2e1c9ac456e8d44d97f00))
* **server:** serve the onboarding skill as raw markdown ([#2583](https://github.com/lobu-ai/lobu/issues/2583)) ([cdf3bb5](https://github.com/lobu-ai/lobu/commit/cdf3bb5f7ca560d8c20c649c03ce3911393bdff7))

## [14.17.1](https://github.com/lobu-ai/lobu/compare/lobu-v14.17.0...lobu-v14.17.1) (2026-08-07)


### Bug Fixes

* **server:** converge session-cookie scope so a stale twin can't brick login ([#2558](https://github.com/lobu-ai/lobu/issues/2558)) ([934ae95](https://github.com/lobu-ai/lobu/commit/934ae95bb479e0d1fe5a1011cb73e7f75e9d8f7f))
* **server:** record the side effects a capture run suppresses ([#2576](https://github.com/lobu-ai/lobu/issues/2576)) ([a73e8a1](https://github.com/lobu-ai/lobu/commit/a73e8a1abba7b5f12df7c794f39696dcd87b481c))
* **server:** stop cookie order deciding which session authenticates ([#2578](https://github.com/lobu-ai/lobu/issues/2578)) ([cc51e66](https://github.com/lobu-ai/lobu/commit/cc51e660778781d06e15bbe1446260602232d7d5))

## [14.17.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.16.0...lobu-v14.17.0) (2026-08-07)


### Features

* **server:** give keyed Behavior event outputs a stable identity ([#2563](https://github.com/lobu-ai/lobu/issues/2563)) ([d34cc8a](https://github.com/lobu-ai/lobu/commit/d34cc8acdef3a0f22c415da56f1016e48ca21920))
* **server:** replay a Behavior run as a captured eval ([#2569](https://github.com/lobu-ai/lobu/issues/2569)) ([e3f95be](https://github.com/lobu-ai/lobu/commit/e3f95be3ad489519f4162680c8447462e9d4054d))
* **server:** stamp runs.outcome taxonomy at every Behavior terminal writer ([#2566](https://github.com/lobu-ai/lobu/issues/2566)) ([b019839](https://github.com/lobu-ai/lobu/commit/b0198396435532692892588069f1067bfcd89cb5))


### Bug Fixes

* **agent-worker:** route real OpenAI dynamic models through the Responses API ([#2556](https://github.com/lobu-ai/lobu/issues/2556)) ([c8b9056](https://github.com/lobu-ai/lobu/commit/c8b90563cd45c334a3e2f39ef11a93b6ad0dbf27))
* **cli:** stop lobu apply from erasing out-of-band metadata_schema keys ([#2570](https://github.com/lobu-ai/lobu/issues/2570)) ([8c2bb27](https://github.com/lobu-ai/lobu/commit/8c2bb27f525e2c6bcdabfd0823bf79ef4b904b67))
* **connectors:** emit calendar_event from google.calendar ([#2573](https://github.com/lobu-ai/lobu/issues/2573)) ([5f6b587](https://github.com/lobu-ai/lobu/commit/5f6b5872cd54ae04b83f878fb54d22a863794f21))
* **core:** reserve top-level SPA routes so path parsing never reads them as org slugs ([#2567](https://github.com/lobu-ai/lobu/issues/2567)) ([e7c5b11](https://github.com/lobu-ai/lobu/commit/e7c5b11d92aa1f521ac5116630a418b91fb074f3))
* **examples:** stop restating first-class event fields in the radar's metadata ([#2560](https://github.com/lobu-ai/lobu/issues/2560)) ([ce325ea](https://github.com/lobu-ai/lobu/commit/ce325ea4b94e98161cefea0a308895a61c50ce6f))
* **personal-agent:** correct X author handle in voice-profile source ([#2568](https://github.com/lobu-ai/lobu/issues/2568)) ([ad6d45f](https://github.com/lobu-ai/lobu/commit/ad6d45f4048d93f593ca37b8ff4be7a4cba736ee))
* **server:** derive Behavior event-output origin_id from source identity ([#2559](https://github.com/lobu-ai/lobu/issues/2559)) ([bb2dcba](https://github.com/lobu-ai/lobu/commit/bb2dcba04d5951b9ba7c9c77947e4e74f13075d6))
* **server:** let an explicit model ref outrank the deployment default provider ([#2554](https://github.com/lobu-ai/lobu/issues/2554)) ([1c31e06](https://github.com/lobu-ai/lobu/commit/1c31e06e83ed482c3b59bd5eba7c43e485c06675))
* **server:** resolve unreviewable pending approvals as expired ([#2565](https://github.com/lobu-ai/lobu/issues/2565)) ([ac5570c](https://github.com/lobu-ai/lobu/commit/ac5570c4785b101f2db7af1f23bd12724940b255))
* **server:** surface the Behavior completion stamp on the behaviors listing ([#2571](https://github.com/lobu-ai/lobu/issues/2571)) ([e21a2fb](https://github.com/lobu-ai/lobu/commit/e21a2fbfeba2a933f0bbeeff907f5553c992f8b8))
* **ui:** stop the activity feed freezing when the second page loads ([#2574](https://github.com/lobu-ai/lobu/issues/2574)) ([15bdfef](https://github.com/lobu-ai/lobu/commit/15bdfefdbf17c627fad05b621c99ac250671be46))

## [14.16.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.15.1...lobu-v14.16.0) (2026-08-06)


### Features

* **server:** let an agent ask a human a question via notify.send ([#2544](https://github.com/lobu-ai/lobu/issues/2544)) ([3192199](https://github.com/lobu-ai/lobu/commit/31921998350d0eebcba77f97570af1eb30e4512c))

## [14.15.1](https://github.com/lobu-ai/lobu/compare/lobu-v14.15.0...lobu-v14.15.1) (2026-08-06)


### Bug Fixes

* **charts:** scope the app topology spread to one ReplicaSet revision ([#2548](https://github.com/lobu-ai/lobu/issues/2548)) ([50b15d7](https://github.com/lobu-ai/lobu/commit/50b15d7d83eb151005de02c926ba6e913e0d6aa7))
* **owletto:** bump pointer for the bounded native AX walk on Mac ([#2552](https://github.com/lobu-ai/lobu/issues/2552)) ([dc78673](https://github.com/lobu-ai/lobu/commit/dc78673bf4cefe81cb879ba49c198b57ddebccbe))
* **server:** honour an explicit provider/model ref from any config layer ([#2547](https://github.com/lobu-ai/lobu/issues/2547)) ([1f0c004](https://github.com/lobu-ai/lobu/commit/1f0c004b9188e05ff9303d1a2530a48a2033b007))

## [14.15.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.14.0...lobu-v14.15.0) (2026-08-06)


### Features

* **behaviors:** subscribe one trigger to several connector events ([#2515](https://github.com/lobu-ai/lobu/issues/2515)) ([24af73a](https://github.com/lobu-ai/lobu/commit/24af73afb91510645a576242ff2e2b74284a5cfb))
* **behaviors:** tell a completer when its payload was discarded ([#2510](https://github.com/lobu-ai/lobu/issues/2510)) ([e9e5b82](https://github.com/lobu-ai/lobu/commit/e9e5b82e46c6d45378c05d1b6b98275e1fc20c7a))
* **behaviors:** workspace-level Behaviors with one executor (agent/device/manual) ([#2499](https://github.com/lobu-ai/lobu/issues/2499)) ([317323f](https://github.com/lobu-ai/lobu/commit/317323f704f2b3e4ded6989e5748b2a1d35440c2))
* **chart:** alert on zero available replicas and spread them across nodes ([#2545](https://github.com/lobu-ai/lobu/issues/2545)) ([e74bffd](https://github.com/lobu-ai/lobu/commit/e74bffdf3aad47b692f34e23f445ac4468c58984))
* **config:** add Qwen / DashScope as a connectable provider ([#2522](https://github.com/lobu-ai/lobu/issues/2522)) ([848dfcb](https://github.com/lobu-ai/lobu/commit/848dfcb0ebb0d709df57895768edd9d38c9a3b20))
* **config:** add qwen3.8-max tiers and document the Token Plan upstream host ([#2532](https://github.com/lobu-ai/lobu/issues/2532)) ([6e8d1e0](https://github.com/lobu-ai/lobu/commit/6e8d1e03b7eb3a174b4c5b2d22b71978d5a0872c))
* **review:** support pi CLI as an explicit third reviewer ([#2486](https://github.com/lobu-ai/lobu/issues/2486)) ([9014a7b](https://github.com/lobu-ai/lobu/commit/9014a7b67c750e80ae04ef96c9e1a2f9ec186739))
* **server:** add onboarding playbook to the lobu skill ([#2531](https://github.com/lobu-ai/lobu/issues/2531)) ([85a0246](https://github.com/lobu-ai/lobu/commit/85a02464eddd621530a5297878201d48eb45e21d))
* **server:** decide provider health on the upstream HTTP status in the secret proxy ([#2529](https://github.com/lobu-ai/lobu/issues/2529)) ([7f434dc](https://github.com/lobu-ai/lobu/commit/7f434dc3ed0937e72c0f6f37eae3144fd1f30406))
* **server:** expose onboarding skill over HTTP + concise agent copy-prompt ([#2524](https://github.com/lobu-ai/lobu/issues/2524)) ([06417d9](https://github.com/lobu-ai/lobu/commit/06417d932b86151ba4df7dba37cdfc7fe246092f))
* **server:** keyed supersede for Behavior event outputs ([#2530](https://github.com/lobu-ai/lobu/issues/2530)) ([4a7bc93](https://github.com/lobu-ai/lobu/commit/4a7bc93f0d695b143ecd446dcaabc93d2aea9ee2))
* **server:** record inference-provider health from terminal worker turns ([#2525](https://github.com/lobu-ai/lobu/issues/2525)) ([65b2b3a](https://github.com/lobu-ai/lobu/commit/65b2b3a871584b6269fddc6c9f79ae6afbb09042))
* **server:** retain declared literal args on generic audit rows ([#2505](https://github.com/lobu-ai/lobu/issues/2505)) ([0a40109](https://github.com/lobu-ai/lobu/commit/0a401094692940641223200324545ad45e3e537c))
* **server:** surface a retained tool request from the activity UI ([#2509](https://github.com/lobu-ai/lobu/issues/2509)) ([1d6a1b1](https://github.com/lobu-ai/lobu/commit/1d6a1b1cb3da0ee52a4ced8c3fe786b7b6ba376c))
* **server:** surface Slack self-install app deep link in connection setup ([#2533](https://github.com/lobu-ai/lobu/issues/2533)) ([4ac586c](https://github.com/lobu-ai/lobu/commit/4ac586c80a1aef3ee1b28ce0dbfc0e5d88138dcf))


### Bug Fixes

* **behaviors:** drop scheduler_client_id from the get_behavior response ([#2507](https://github.com/lobu-ai/lobu/issues/2507)) ([2ddb03f](https://github.com/lobu-ai/lobu/commit/2ddb03ff5273628a051b2d8d36781de8685cffbc))
* **behaviors:** list resolves org slug for org-scoped Behaviors ([#2506](https://github.com/lobu-ai/lobu/issues/2506)) ([f58e793](https://github.com/lobu-ai/lobu/commit/f58e79324aefbea02eaa24e25de0eea9b54b2839))
* **behaviors:** reject event triggers on connectors that can never fire ([#2516](https://github.com/lobu-ai/lobu/issues/2516)) ([9224fce](https://github.com/lobu-ai/lobu/commit/9224fce7779650c8f63c71ea75a95f85900e103b))
* **behaviors:** templates-first create form, prompt-derived sources ([#2511](https://github.com/lobu-ai/lobu/issues/2511)) ([f706149](https://github.com/lobu-ai/lobu/commit/f70614955afea9fafe5c365be5746c1750680dfd))
* **chart:** skip the pre-upgrade quiesce when no migration is pending ([#2543](https://github.com/lobu-ai/lobu/issues/2543)) ([8c5d46f](https://github.com/lobu-ai/lobu/commit/8c5d46f783649f5fc223f28d6af61f2ff3eaafe1))
* **ci:** download registry asset under its checksummed filename ([#2497](https://github.com/lobu-ai/lobu/issues/2497)) ([49c9cb8](https://github.com/lobu-ai/lobu/commit/49c9cb816e96ab68dd60271a40725c39d111f702))
* **ci:** key each UI review proof to the Lobu PR that owns it ([#2520](https://github.com/lobu-ai/lobu/issues/2520)) ([53fbd02](https://github.com/lobu-ai/lobu/commit/53fbd02ae9c10f20ff363952c36deef578fbc662))
* **cli:** mint hosted-chat link codes after the gateway is reachable ([#2540](https://github.com/lobu-ai/lobu/issues/2540)) ([442fc26](https://github.com/lobu-ai/lobu/commit/442fc26b5fafb5fa1e14d08a7859162897b3e192))
* **core:** share the provider balance-exhaustion vocabulary with the worker classifier ([#2527](https://github.com/lobu-ai/lobu/issues/2527)) ([2b6e493](https://github.com/lobu-ai/lobu/commit/2b6e493e02e031ec18b1db67a4f77dfd3a3b92fa))
* **core:** validate agent_kind against the device executor registry ([#2539](https://github.com/lobu-ai/lobu/issues/2539)) ([e82584f](https://github.com/lobu-ai/lobu/commit/e82584fb7ed2aa8c5245d76f854f1805eaf7950c))
* **server:** apply the future-event guard to classification stats too ([#2537](https://github.com/lobu-ai/lobu/issues/2537)) ([e64ced6](https://github.com/lobu-ai/lobu/commit/e64ced6af7a355a485892da883d3535f244c671a))
* **server:** bound every event source by limit, not just the primary ([#2512](https://github.com/lobu-ai/lobu/issues/2512)) ([458f9be](https://github.com/lobu-ai/lobu/commit/458f9be6b66ec2e6e96c27f9eb076376e806697c))
* **server:** floor the Behavior window at one period so lag cannot freeze ([#2542](https://github.com/lobu-ai/lobu/issues/2542)) ([eddf0c9](https://github.com/lobu-ai/lobu/commit/eddf0c9391957b19f5713cafb4bf8e22eda68b66))
* **server:** keep NULL and future-dated events off the top of the activity feed ([#2535](https://github.com/lobu-ai/lobu/issues/2535)) ([b302a64](https://github.com/lobu-ai/lobu/commit/b302a645e30b8e2b024ce880edeb16d45212f252))
* **server:** make the events_client_id FK retry survive the supersede transaction ([#2534](https://github.com/lobu-ai/lobu/issues/2534)) ([695c8f3](https://github.com/lobu-ai/lobu/commit/695c8f302f18e87d636a127f249655f2b6c0122e))
* **server:** park a Behavior for a day when the provider balance is empty ([#2521](https://github.com/lobu-ai/lobu/issues/2521)) ([f0443c2](https://github.com/lobu-ai/lobu/commit/f0443c285440ffb05994f32f9bd3b0f2df0a9e3b))
* **server:** report device liveness truthfully instead of a 20-minute guess ([#2513](https://github.com/lobu-ai/lobu/issues/2513)) ([dc76334](https://github.com/lobu-ai/lobu/commit/dc76334b9d875e90f1130562bf9699f665d35f8f))


### Performance Improvements

* **server:** cut derived counts + double scans from hot list paths ([#2488](https://github.com/lobu-ai/lobu/issues/2488)) ([1724dd5](https://github.com/lobu-ai/lobu/commit/1724dd58d575aa62fa1fb69b979266fd5e58ab3c))
* **server:** denormalize org-scope bridge into events.linked_org_ids ([#2490](https://github.com/lobu-ai/lobu/issues/2490)) ([574ad6e](https://github.com/lobu-ai/lobu/commit/574ad6e1d7df99d327377021345a6081ced6a1e6))
* **server:** query cost-attribution ledger + runs retention index ([#2496](https://github.com/lobu-ai/lobu/issues/2496)) ([9085c6a](https://github.com/lobu-ai/lobu/commit/9085c6a361cd308603bd8da9ad3dbb73134613eb))

## [14.14.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.13.0...lobu-v14.14.0) (2026-08-04)


### Features

* **repo:** require human UI proof before release ([#2478](https://github.com/lobu-ai/lobu/issues/2478)) ([6155791](https://github.com/lobu-ai/lobu/commit/6155791de5a679c7190a935713d9481d09050e84))
* **ui:** simplify agent onboarding surfaces ([#2481](https://github.com/lobu-ai/lobu/issues/2481)) ([e997b5e](https://github.com/lobu-ai/lobu/commit/e997b5e48eb813a34e10e305e3282b36225a1359))


### Bug Fixes

* **embeddings:** exit the forked server when its parent dies ([#2480](https://github.com/lobu-ai/lobu/issues/2480)) ([411497a](https://github.com/lobu-ai/lobu/commit/411497aef5c464c04acdb22c9ce9b401c3258528))
* **server:** pair admin allowlist with its canonical actor ([#2427](https://github.com/lobu-ai/lobu/issues/2427)) ([f6418d0](https://github.com/lobu-ai/lobu/commit/f6418d0e4fe2a599f89f235468ba6c39d1f027d4))
* **server:** park Behaviors until provider quota reset ([#2467](https://github.com/lobu-ai/lobu/issues/2467)) ([0bf2c43](https://github.com/lobu-ai/lobu/commit/0bf2c43d6ab45ad36fd9b4c1829f92056aca295e))
* **server:** secure first managed OAuth connect ([#2469](https://github.com/lobu-ai/lobu/issues/2469)) ([d928e6c](https://github.com/lobu-ai/lobu/commit/d928e6c24a90f0659c9ea8cb7bf6fb870baa0dde))
* **slack:** clarify and fence hosted workspace linking ([#2482](https://github.com/lobu-ai/lobu/issues/2482)) ([5867a6b](https://github.com/lobu-ai/lobu/commit/5867a6b5dd24773cf86d50aad51edd748ecd3313))

## [14.13.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.12.0...lobu-v14.13.0) (2026-08-04)


### Features

* **server:** show exact MCP client activity ([#2473](https://github.com/lobu-ai/lobu/issues/2473)) ([32a3f96](https://github.com/lobu-ai/lobu/commit/32a3f96eb0fa9f43a8ae189d22d6aa1dc4da10d1))


### Bug Fixes

* **cli:** make onboarding runnable end to end ([#2477](https://github.com/lobu-ai/lobu/issues/2477)) ([546ea2b](https://github.com/lobu-ai/lobu/commit/546ea2b5d9ec6e93dc9ece312f4eeda4b2243f63))
* **db:** apply skipped Behavior output migration [dup-version-rename] ([#2472](https://github.com/lobu-ai/lobu/issues/2472)) ([a8705c1](https://github.com/lobu-ai/lobu/commit/a8705c194f78e667d2465361149bc0f6b0b68c5d))
* **example:** preserve Behavior source linkage ([#2474](https://github.com/lobu-ai/lobu/issues/2474)) ([3f7ac7b](https://github.com/lobu-ai/lobu/commit/3f7ac7b36b16e2ec1ba4c494c2826480529463ac))
* **server:** close MCP discovery contract gaps ([#2466](https://github.com/lobu-ai/lobu/issues/2466)) ([648b4dd](https://github.com/lobu-ai/lobu/commit/648b4dd920387eca86bc3735306c7f37d49395cc))
* **server:** preserve backslashes in score filters ([#2462](https://github.com/lobu-ai/lobu/issues/2462)) ([e53af13](https://github.com/lobu-ai/lobu/commit/e53af131d6a79d9555db1f2aa580f0d7d7416e4e))

## [14.12.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.11.0...lobu-v14.12.0) (2026-08-03)


### Features

* add durable Behavior outputs ([#2461](https://github.com/lobu-ai/lobu/issues/2461)) ([a1aa7f1](https://github.com/lobu-ai/lobu/commit/a1aa7f192898692fb346dc6574152d30011d8beb))
* **server:** add managed auth onboarding ([#2470](https://github.com/lobu-ai/lobu/issues/2470)) ([861db9c](https://github.com/lobu-ai/lobu/commit/861db9ca3b23a1f28dbdb8b39f27a8f5924c44c4))


### Bug Fixes

* **ci:** fail closed on private Helm chart ([#2459](https://github.com/lobu-ai/lobu/issues/2459)) ([d69b897](https://github.com/lobu-ai/lobu/commit/d69b897cae4cb97da7d8b3c74472a25a069d8d47))

## [14.11.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.10.0...lobu-v14.11.0) (2026-08-03)


### Features

* **behaviors:** persist social radar event threads ([#2435](https://github.com/lobu-ai/lobu/issues/2435)) ([6eeb341](https://github.com/lobu-ai/lobu/commit/6eeb341434af10618ca3ecdd22c1015741766679))
* **connectors:** min_scrolls jitter for X/LinkedIn home feeds ([#2356](https://github.com/lobu-ai/lobu/issues/2356)) ([ae791ad](https://github.com/lobu-ai/lobu/commit/ae791ad495fa974b46c8c96a3b3b8f7a893bad58))
* **connectors:** stage X reply drafts via prepare_reply ([#2437](https://github.com/lobu-ai/lobu/issues/2437)) ([598f394](https://github.com/lobu-ai/lobu/commit/598f39400f9aa8adfa4bc180ef8e8185d89bf77b))
* **server:** materialize recent conversation context ([#2441](https://github.com/lobu-ai/lobu/issues/2441)) ([19928ef](https://github.com/lobu-ai/lobu/commit/19928eff8f1cbb8b197e40f350b2253fccdccbd8))


### Bug Fixes

* **ci:** publish packages after image smoke ([#2453](https://github.com/lobu-ai/lobu/issues/2453)) ([b5cf43a](https://github.com/lobu-ai/lobu/commit/b5cf43aef5a0c9e42bcb319702f7a9ff18219c77))
* **server:** authenticate approved tool execution ([#2426](https://github.com/lobu-ai/lobu/issues/2426)) ([56c5de9](https://github.com/lobu-ai/lobu/commit/56c5de91d1ad7c4e56c578f07411f432b5e83510))
* **server:** bind builder admin grants to auth actors ([#2422](https://github.com/lobu-ai/lobu/issues/2422)) ([a7f7446](https://github.com/lobu-ai/lobu/commit/a7f74461baadff8ad68eddeb862ab883283d9ae1))
* **server:** bound tool request hydration ([#2445](https://github.com/lobu-ai/lobu/issues/2445)) ([052f0a3](https://github.com/lobu-ai/lobu/commit/052f0a36a56e4064642c8e7544cc1c49fdfd40b7))
* **server:** exclude command sessions from Recent ([#2457](https://github.com/lobu-ai/lobu/issues/2457)) ([87e4506](https://github.com/lobu-ai/lobu/commit/87e45063fbb35e3dc96c98e1b407f604d338f63f))
* **server:** normalize canonical chat channel ids ([#2423](https://github.com/lobu-ai/lobu/issues/2423)) ([f0969f7](https://github.com/lobu-ai/lobu/commit/f0969f73e35f60dcc53bf24cd9c6b824c31c2d49))
* **server:** preserve command-session classification ([#2458](https://github.com/lobu-ai/lobu/issues/2458)) ([a699df4](https://github.com/lobu-ai/lobu/commit/a699df44f9911529bedbc2d01658020b6e05514e))
* **server:** route Grid interactive approvals ([#2424](https://github.com/lobu-ai/lobu/issues/2424)) ([c7e9489](https://github.com/lobu-ai/lobu/commit/c7e9489a4435971eadb6374b5d32787581fac816))
* **server:** route same-org Grid install aliases ([#2425](https://github.com/lobu-ai/lobu/issues/2425)) ([18711a6](https://github.com/lobu-ai/lobu/commit/18711a6c0a458c8eeddda6a4249af38523c2c5c0))
* **server:** route scoped hosted preview delivery ([#2428](https://github.com/lobu-ai/lobu/issues/2428)) ([5958685](https://github.com/lobu-ai/lobu/commit/5958685495138a63386bdc0b0b2a3aa0f4dbaf7c))
* **server:** secure root embedded Postgres traversal ([#2444](https://github.com/lobu-ai/lobu/issues/2444)) ([e44b0ee](https://github.com/lobu-ai/lobu/commit/e44b0ee1e85db84386c28d5110825700fec2b12f))
* **server:** stop minting chat identity from a redeemed preview code ([#2418](https://github.com/lobu-ai/lobu/issues/2418)) ([d3834b8](https://github.com/lobu-ai/lobu/commit/d3834b88dc060f7e06b86e750dbfbd8b1fa6cff0))
* **server:** surface cross-workspace GitHub installs ([#2450](https://github.com/lobu-ai/lobu/issues/2450)) ([61211c0](https://github.com/lobu-ai/lobu/commit/61211c06a16236c84c794a70f26d79a95d1b5056))
* **server:** type keying_config and split entity display name from its stable key ([#2421](https://github.com/lobu-ai/lobu/issues/2421)) ([eb7a522](https://github.com/lobu-ai/lobu/commit/eb7a5229b1947c268b27a42a10d412ec410a7b53))
* **skills:** align Lobu guidance with SDK workflows ([#2443](https://github.com/lobu-ai/lobu/issues/2443)) ([c3b2bb4](https://github.com/lobu-ai/lobu/commit/c3b2bb4bb721b8bde806dc0e2f12c70e54756238))
* **submodule:** align owletto behavior contracts ([#2454](https://github.com/lobu-ai/lobu/issues/2454)) ([92955a6](https://github.com/lobu-ai/lobu/commit/92955a6971707823383e4a6e5f7b839762d1baaf))
* **ui:** expose MCP client attribution ([#2433](https://github.com/lobu-ai/lobu/issues/2433)) ([f608afd](https://github.com/lobu-ai/lobu/commit/f608afd7f37560aa87eb822a9c2457d18f62cae5))


### Performance Improvements

* **ci:** parallelize integration and package builds ([#2442](https://github.com/lobu-ai/lobu/issues/2442)) ([ad2d42a](https://github.com/lobu-ai/lobu/commit/ad2d42a4e52e53daeee21862fd96c8d1928c38e4))
* **ci:** reduce merge-gate latency ([#2455](https://github.com/lobu-ai/lobu/issues/2455)) ([0664c19](https://github.com/lobu-ai/lobu/commit/0664c19f4dfeee708e17fb1c3970bd5d405c285b))

## [14.10.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.9.0...lobu-v14.10.0) (2026-08-01)


### Features

* **server:** let a caller choose the embedding model instead of one global ([#2409](https://github.com/lobu-ai/lobu/issues/2409)) ([28945fe](https://github.com/lobu-ai/lobu/commit/28945fec6f073451267047596d082d1ae2e5dc01))


### Bug Fixes

* **server:** resolve ACL members safely — skip deleted entities, fail closed on ambiguity ([#2411](https://github.com/lobu-ai/lobu/issues/2411)) ([d1d862c](https://github.com/lobu-ai/lobu/commit/d1d862cf958be9d94056c4485c60db29b2062091))
* **server:** roll Behavior windows forward instead of re-completing the same period ([#2412](https://github.com/lobu-ai/lobu/issues/2412)) ([ef554e2](https://github.com/lobu-ai/lobu/commit/ef554e24d3be8135e6c84186ac72683884039045))

## [14.9.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.8.0...lobu-v14.9.0) (2026-07-31)


### Features

* **server:** org-scope the classification engine and expose it as manage_classifiers apply ([#2389](https://github.com/lobu-ai/lobu/issues/2389)) ([eac0468](https://github.com/lobu-ai/lobu/commit/eac0468da2b8e6b58287007743ca10d17e2536d2))
* **server:** surface trigger_feed's dry_run on the ClientSDK ([#2397](https://github.com/lobu-ai/lobu/issues/2397)) ([a8fe130](https://github.com/lobu-ai/lobu/commit/a8fe130ffacf48b174c69b33d716e52aa4d7efce))


### Bug Fixes

* **agent-worker:** report why exec-sandbox is unavailable instead of guessing ([#2395](https://github.com/lobu-ai/lobu/issues/2395)) ([ea850ad](https://github.com/lobu-ai/lobu/commit/ea850ad756283df6c20e9b705f79321590c4bc13))
* **chat:** stop double-posting when the agent already answered in-band ([#2403](https://github.com/lobu-ai/lobu/issues/2403)) ([63ba944](https://github.com/lobu-ai/lobu/commit/63ba9442ff9e135f1fdac019841eb602821c6e0a))
* **mac-release:** stamp CFBundleVersion so Sparkle stops re-staging every release ([6411c50](https://github.com/lobu-ai/lobu/commit/6411c507a092249b6f09bfc7e77411d49593bb6c))
* **owletto:** unify agent sub-page layout and make entity views opt-in ([#2400](https://github.com/lobu-ai/lobu/issues/2400)) ([fe4220e](https://github.com/lobu-ai/lobu/commit/fe4220ea2925e543fa9e36ee6d2bbb7d9abe063c))
* **server:** let a Behavior define its own classifier ([#2405](https://github.com/lobu-ai/lobu/issues/2405)) ([c12a4d0](https://github.com/lobu-ai/lobu/commit/c12a4d02d9a6db871578ba19896ade8de3e41b26))
* **server:** make classifications visible exactly when their event is ([#2402](https://github.com/lobu-ai/lobu/issues/2402)) ([1801528](https://github.com/lobu-ai/lobu/commit/1801528e33267a9ceca34893e6c69530ed7282fb))
* **server:** make the classification engine reachable by agents ([#2394](https://github.com/lobu-ai/lobu/issues/2394)) ([3ac8ba1](https://github.com/lobu-ai/lobu/commit/3ac8ba127493be3e6c6143e72b9fa093779d33be))
* **server:** model-stamp classifier label vectors so a swap can't compare across spaces ([#2407](https://github.com/lobu-ai/lobu/issues/2407)) ([6b54e95](https://github.com/lobu-ai/lobu/commit/6b54e9585ff0434590959a6b0143ae49ae5536ac))
* **server:** retry the device-connector wire when its slug races a sibling ([#2399](https://github.com/lobu-ai/lobu/issues/2399)) ([bae1e0f](https://github.com/lobu-ai/lobu/commit/bae1e0f11c3a264d52603dcca8e9209094fa665d))
* **server:** scope classifier slug uniqueness to the organization ([#2406](https://github.com/lobu-ai/lobu/issues/2406)) ([c605b8d](https://github.com/lobu-ai/lobu/commit/c605b8d733490833c2f641590109b92ce527690b))
* **server:** stop the catalog scan warning about files that were never connectors ([#2393](https://github.com/lobu-ai/lobu/issues/2393)) ([d8a22a9](https://github.com/lobu-ai/lobu/commit/d8a22a96713045a0ce27c06612bbd0f729b9a253))
* **server:** tell the caller why no sync run was queued ([#2398](https://github.com/lobu-ai/lobu/issues/2398)) ([a63c21a](https://github.com/lobu-ai/lobu/commit/a63c21ac0a4403df9de7334406d0739c251dbf85))

## [14.8.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.7.1...lobu-v14.8.0) (2026-07-31)


### Features

* **agent-worker:** tell the agent which agent, conversation and Lobu it is in ([#2322](https://github.com/lobu-ai/lobu/issues/2322)) ([8c97066](https://github.com/lobu-ai/lobu/commit/8c9706632427b7febec8d063802b2325ecfc208d))
* **cli,server:** compile Behavior skills[] into frozen prompt at apply ([#2331](https://github.com/lobu-ai/lobu/issues/2331)) ([847768a](https://github.com/lobu-ai/lobu/commit/847768a8e5b43a40398dae069cc36c482dd064a9))
* **connectors:** virtual Jira/Linear issues + OAuth cloud_id stamp ([#2333](https://github.com/lobu-ai/lobu/issues/2333)) ([84b3bc5](https://github.com/lobu-ai/lobu/commit/84b3bc59bee10dbe33656cd0bd9388560b34cddd))
* **server:** device Behavior complete-behavior resume + Mac CLI path ([#2361](https://github.com/lobu-ai/lobu/issues/2361)) ([a23ad74](https://github.com/lobu-ai/lobu/commit/a23ad740f6f11b28892628037b295ddbe601d112))
* **server:** dry-run feed syncs that execute for real and persist nothing ([#2390](https://github.com/lobu-ai/lobu/issues/2390)) ([8811a76](https://github.com/lobu-ai/lobu/commit/8811a765403344a97021013baa9f866d5be1ef8f))
* **server:** feed.auto_paused signal; delete connector repair-agent ([#2351](https://github.com/lobu-ai/lobu/issues/2351)) ([84821ec](https://github.com/lobu-ai/lobu/commit/84821ec46a1571b3db0f0142d263e42a1c5f860b))
* **server:** pin Behavior skills as version snapshots and deliver them as files ([#2371](https://github.com/lobu-ai/lobu/issues/2371)) ([84b86a6](https://github.com/lobu-ai/lobu/commit/84b86a6a724d6d07264083005ca2f49d48ad3bc4))
* **server:** record and show what a merge re-check changed ([#2337](https://github.com/lobu-ai/lobu/issues/2337)) ([f302083](https://github.com/lobu-ai/lobu/commit/f3020833504154a985e882834fe727262934507c))
* **server:** reject a prompt that references an unpinned skill ([#2374](https://github.com/lobu-ai/lobu/issues/2374)) ([48bc4c1](https://github.com/lobu-ai/lobu/commit/48bc4c1c8175b85da026ceffd36726b488ef2df9))


### Bug Fixes

* **agent-worker:** stop every installed CLI agent turn crashing on __filename ([#2375](https://github.com/lobu-ai/lobu/issues/2375)) ([8f13ad8](https://github.com/lobu-ai/lobu/commit/8f13ad825024e2633de8f9c3ef17ccff1bbd2ab3))
* **ci:** give the app-image smoke an ENCRYPTION_KEY, and time the boot window off a blank DB ([#2383](https://github.com/lobu-ai/lobu/issues/2383)) ([0f62f5c](https://github.com/lobu-ai/lobu/commit/0f62f5c4c6b6ef19d4f0e8253b6806bc177821d8))
* **mac:** stop TCC probes blocking the main actor and lying about capability ([#2373](https://github.com/lobu-ai/lobu/issues/2373)) ([9dc5986](https://github.com/lobu-ai/lobu/commit/9dc5986c2ccacd775431c04544f8b097d74a6d80))
* **pgvector-embedded:** build Linux prebuilts on glibc 2.31, not the runner's ([#2376](https://github.com/lobu-ai/lobu/issues/2376)) ([c964865](https://github.com/lobu-ai/lobu/commit/c9648654295b1bc14c9610e04028a9b16aa7cb72))
* **review:** make the review harness survive a single-CLI outage ([#2372](https://github.com/lobu-ai/lobu/issues/2372)) ([377d24c](https://github.com/lobu-ai/lobu/commit/377d24c46ec06828d8e24e849f4638e98f7f15de))
* **server:** advance a Behavior's cron cursor when its run fails ([#2326](https://github.com/lobu-ai/lobu/issues/2326)) ([4527ebe](https://github.com/lobu-ai/lobu/commit/4527ebe809f4900815bf0035bf73b0c952f1553e))
* **server:** apply a re-checked merge on one approval when evidence strengthened ([#2330](https://github.com/lobu-ai/lobu/issues/2330)) ([fa04035](https://github.com/lobu-ai/lobu/commit/fa04035b4e943f770c54d3035030c136cbbe91a5))
* **server:** honour min_cooldown_seconds on event-triggered Behaviors ([#2341](https://github.com/lobu-ai/lobu/issues/2341)) ([b348aa8](https://github.com/lobu-ai/lobu/commit/b348aa899328023408fc3307fff1c8f578eb3710))
* **server:** keep the live skill library out of Behavior runs ([#2342](https://github.com/lobu-ai/lobu/issues/2342)) ([18a5f34](https://github.com/lobu-ai/lobu/commit/18a5f3432c476350e4ce9b8bb65adfd48402d554))
* **server:** let `lobu run` boot embedded Postgres in a root shell ([#2377](https://github.com/lobu-ai/lobu/issues/2377)) ([fdb1a75](https://github.com/lobu-ai/lobu/commit/fdb1a7505adb214327f9b51f44c3c33417300285))
* **server:** let public orgs answer declared read-only REST proxies ([#2364](https://github.com/lobu-ai/lobu/issues/2364)) ([7765124](https://github.com/lobu-ai/lobu/commit/77651247127780f898b927383ce71b86657bde7b))
* **server:** make DM conversations visible to the workspace owner ([#2362](https://github.com/lobu-ai/lobu/issues/2362)) ([bab0801](https://github.com/lobu-ai/lobu/commit/bab0801a287aae1c3f11ee054d7af28cc232f21a))
* **server:** name the approval gate in a Behavior finalize failure, and share the carve-out ([#2335](https://github.com/lobu-ai/lobu/issues/2335)) ([ce4725e](https://github.com/lobu-ai/lobu/commit/ce4725e0d4195363f9c927ed56b14d469e635468))
* **server:** parse oauth_clients array columns at the read boundary ([#2381](https://github.com/lobu-ai/lobu/issues/2381)) ([5cdb555](https://github.com/lobu-ai/lobu/commit/5cdb555259e4539a5d2c884aa86bb218f343d5ea))
* **server:** pass connection-visibility principal into Behavior knowledge.read ([#2354](https://github.com/lobu-ai/lobu/issues/2354)) ([85bedf0](https://github.com/lobu-ai/lobu/commit/85bedf0f08cdd34c52ea843f7bf5e885de76db2e))
* **server:** re-present a merge whose fingerprint format changed, not dead-end it ([#2325](https://github.com/lobu-ai/lobu/issues/2325)) ([7c27a13](https://github.com/lobu-ai/lobu/commit/7c27a1377f4432465f0d12c04b3f70b63610e122))
* **server:** recycle stale agent deployments at the dispatch chokepoint ([#2315](https://github.com/lobu-ai/lobu/issues/2315)) ([b8f1e92](https://github.com/lobu-ai/lobu/commit/b8f1e922c121295c38d546693e55d43a76c3c924))
* **server:** remove Handlebars templating from Behavior prompts ([#2327](https://github.com/lobu-ai/lobu/issues/2327)) ([f5a5661](https://github.com/lobu-ai/lobu/commit/f5a5661d64a210b3d18266ac73d0df3b6f92fbb9))
* **server:** report an MCP client's registered name, not its driver ([#2380](https://github.com/lobu-ai/lobu/issues/2380)) ([e08636f](https://github.com/lobu-ai/lobu/commit/e08636f1df02aa10bb7369451255bcabc4113686))
* **server:** stop a Behavior's instruction text from authoring its sources ([#2345](https://github.com/lobu-ai/lobu/issues/2345)) ([db32432](https://github.com/lobu-ai/lobu/commit/db32432a7fab64cccd36bf5d4906817a72daaefa))
* **server:** stop caller input overriding server-fixed tool discriminators ([#2360](https://github.com/lobu-ai/lobu/issues/2360)) ([0b641f5](https://github.com/lobu-ai/lobu/commit/0b641f5c7a8614de614035f07e8fa4e3121157b0))
* **server:** stop server-dispatched Behavior runs reporting an external executor ([#2352](https://github.com/lobu-ai/lobu/issues/2352)) ([5215f53](https://github.com/lobu-ai/lobu/commit/5215f5377caa841660be3a97d4685b0bc6771601))
* **server:** verify behavior_run session intent and reserve the Behavior conversation suffix ([#2340](https://github.com/lobu-ai/lobu/issues/2340)) ([1016092](https://github.com/lobu-ai/lobu/commit/101609279e9fc9b9a7b9d592f274245f2530da6a))
* **server:** withhold connection credentials and identity from non-members ([#2363](https://github.com/lobu-ai/lobu/issues/2363)) ([de1af49](https://github.com/lobu-ai/lobu/commit/de1af49e290bfdde774e670df6ad81cdddab538b))


### Performance Improvements

* **server:** order Behaviors by a stored stamp instead of aggregating run history ([#2370](https://github.com/lobu-ai/lobu/issues/2370)) ([48ce061](https://github.com/lobu-ai/lobu/commit/48ce061566e91bc0d37a7c9829d9b4948839a250))

## [14.7.1](https://github.com/lobu-ai/lobu/compare/lobu-v14.7.0...lobu-v14.7.1) (2026-07-29)


### Bug Fixes

* **agent-worker:** deliver Lobu's system prompt to the model ([#2319](https://github.com/lobu-ai/lobu/issues/2319)) ([b8e66f0](https://github.com/lobu-ai/lobu/commit/b8e66f022a18d491d405ad19e844a9527d0b5560))
* **agent-worker:** stop pi discovering resources from the agent's workspace ([#2313](https://github.com/lobu-ai/lobu/issues/2313)) ([99b50cc](https://github.com/lobu-ai/lobu/commit/99b50cc65ea3ca7e4183276dec35ed36857a63d6))
* **ci:** refuse to post a review verdict onto a superseded commit ([#2311](https://github.com/lobu-ai/lobu/issues/2311)) ([01e1a07](https://github.com/lobu-ai/lobu/commit/01e1a07521cac6491c361720aa6c0b132c9c70cf))
* **ci:** stop the reviewer's own sandbox from blocking merges ([#2308](https://github.com/lobu-ai/lobu/issues/2308)) ([468c398](https://github.com/lobu-ai/lobu/commit/468c39888a9c8851bf9fa3e741ad0bee779f8e11))
* **server:** reclaim expired chat-state claims instead of blocking forever ([#2314](https://github.com/lobu-ai/lobu/issues/2314)) ([0862364](https://github.com/lobu-ai/lobu/commit/0862364360475219258973c1f5c3adab85e50847))
* **server:** record why a merge was proposed, not just who ([#2321](https://github.com/lobu-ai/lobu/issues/2321)) ([4bdae93](https://github.com/lobu-ai/lobu/commit/4bdae93c4f1812679fda54f442765235c27a65a9))
* **server:** stop provider rows being created unroutable, and log the fallback ([#2316](https://github.com/lobu-ai/lobu/issues/2316)) ([92f8c38](https://github.com/lobu-ai/lobu/commit/92f8c3855c446ef565664bd34ef7af0ab50763d7))
* **server:** tell every chat agent it is a participant, not an observer ([#2318](https://github.com/lobu-ai/lobu/issues/2318)) ([30a4bd8](https://github.com/lobu-ai/lobu/commit/30a4bd836fefb14569e20e7edac7e1055f5c9b7a))

## [14.7.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.6.0...lobu-v14.7.0) (2026-07-29)


### Features

* **owletto:** reach the cluster index on narrow viewports ([#2278](https://github.com/lobu-ai/lobu/issues/2278)) ([8db0ee2](https://github.com/lobu-ai/lobu/commit/8db0ee25fbad0b4572186d7d33c6e397e5f1310c))
* **server:** provision connector-contributed nix packages on remote runtimes ([#2249](https://github.com/lobu-ai/lobu/issues/2249)) ([0ccfe6c](https://github.com/lobu-ai/lobu/commit/0ccfe6c754ee3d691b9eecd73beeceeab3830a74))


### Bug Fixes

* **agent-worker:** deny new-style nix CLI and ad-hoc package runners ([#2259](https://github.com/lobu-ai/lobu/issues/2259)) ([81c5eb5](https://github.com/lobu-ai/lobu/commit/81c5eb5935da44ffb1b0064e2cf583e1692e9b75))
* **agent-worker:** stop counting a package manager consumed as argument data ([#2294](https://github.com/lobu-ai/lobu/issues/2294)) ([6d63e0f](https://github.com/lobu-ai/lobu/commit/6d63e0f93e41df80f2ab7ab29b2d8bb80183da7e))
* **ci:** publish arm64 alongside amd64 on releases ([#2296](https://github.com/lobu-ai/lobu/issues/2296)) ([54676bc](https://github.com/lobu-ai/lobu/commit/54676bcc9c544968478e671897c652c673299385))
* **ci:** stop the merge-integrity sweep crashing on an unresolvable commit ([#2303](https://github.com/lobu-ai/lobu/issues/2303)) ([e1a1594](https://github.com/lobu-ai/lobu/commit/e1a15948607bb1761d157111deedfd60baae22db))
* **scripts:** restore every workspace manifest the bump test rewrites ([#2306](https://github.com/lobu-ai/lobu/issues/2306)) ([2595f23](https://github.com/lobu-ai/lobu/commit/2595f239a6656f905641b643fc5cf8c4dbe772c2))
* **server:** clear every stale device pin, not just the selected row ([#2299](https://github.com/lobu-ai/lobu/issues/2299)) ([4a707ac](https://github.com/lobu-ai/lobu/commit/4a707ac7a4679057924c81c51e59972abafc85be))
* **server:** close MCP recall, Behavior exposure, and connector-health gaps ([#2298](https://github.com/lobu-ai/lobu/issues/2298)) ([32ab462](https://github.com/lobu-ai/lobu/commit/32ab462af3d57ec0e3146274e0c0ba4dd58813b4))
* **server:** let members read a single auth profile, matching list ([#2304](https://github.com/lobu-ai/lobu/issues/2304)) ([2df9eb5](https://github.com/lobu-ai/lobu/commit/2df9eb5fbc59f287e8151875cfd227308c96fc66))
* **server:** make org scoping fail closed instead of dropping the filter ([#2292](https://github.com/lobu-ai/lobu/issues/2292)) ([f54cc39](https://github.com/lobu-ai/lobu/commit/f54cc39a83b60111c3984ac5d9d88a42fc08b0ea))
* **server:** make the SDK access-tier drift guard fail closed ([#2283](https://github.com/lobu-ai/lobu/issues/2283)) ([87650ce](https://github.com/lobu-ai/lobu/commit/87650cee2767eeaa2f7ae427435433713ceb8bec))
* **server:** name the provider in error bodies and unwrap the JSON envelope ([#2280](https://github.com/lobu-ai/lobu/issues/2280)) ([77c3e8a](https://github.com/lobu-ai/lobu/commit/77c3e8a81b2b1eb9f0ba13dab66ed85bbed87c8a))
* **server:** never steal a device pin another live connection holds ([#2286](https://github.com/lobu-ai/lobu/issues/2286)) ([eeda0f3](https://github.com/lobu-ai/lobu/commit/eeda0f399316a452bd21adf492f4558904610e87))
* **server:** pre-flight the device pin on connection update ([#2300](https://github.com/lobu-ai/lobu/issues/2300)) ([df4c976](https://github.com/lobu-ai/lobu/commit/df4c976589674ea9833344c156d71b50a33aa4c4))
* **server:** prove the tenant before scoping org-less agent history ([#2284](https://github.com/lobu-ai/lobu/issues/2284)) ([7b38e5a](https://github.com/lobu-ai/lobu/commit/7b38e5a6e5ce1e2ac2b7c7c452a6ce470abd3f11))
* **server:** read a conversation by its stored id, fenced on its row ([#2302](https://github.com/lobu-ai/lobu/issues/2302)) ([cc26933](https://github.com/lobu-ai/lobu/commit/cc269333e7470e602000fc50d52d1083fe310f5a))
* **server:** scope org-less agent config reads to a proven tenant ([#2287](https://github.com/lobu-ai/lobu/issues/2287)) ([6fa34e0](https://github.com/lobu-ai/lobu/commit/6fa34e0e1cc4f306e9d44ec771a5b9b86481fbff))
* **server:** stop a throttled sandbox from reading as a failed command ([#2281](https://github.com/lobu-ai/lobu/issues/2281)) ([aa91965](https://github.com/lobu-ai/lobu/commit/aa91965f132bffe95aa413c4f569417553b6a87f))
* **server:** stop the Chat SDK history cache from dropping inbound messages ([#2305](https://github.com/lobu-ai/lobu/issues/2305)) ([63c7dd5](https://github.com/lobu-ai/lobu/commit/63c7dd519bccb4ec8d4792c8885fa9e8264a419b))
* **server:** validate guardrails carried on skills at the write boundary ([#2285](https://github.com/lobu-ai/lobu/issues/2285)) ([a5869d8](https://github.com/lobu-ai/lobu/commit/a5869d88173697e30cba4f0fb0d910086bda4069))

## [14.6.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.5.0...lobu-v14.6.0) (2026-07-28)


### Features

* **owletto:** make the workspace schema map readable ([#2270](https://github.com/lobu-ai/lobu/issues/2270)) ([33390cc](https://github.com/lobu-ai/lobu/commit/33390cc98e018f84f41d5cdd71f4dc3772e81423))


### Bug Fixes

* **agent-worker:** forward NIX_PACKAGES so declared tooling resolves in agent bash ([#2274](https://github.com/lobu-ai/lobu/issues/2274)) ([f20f854](https://github.com/lobu-ai/lobu/commit/f20f8541f52efbfd6adea98e0f937fb73eba0c4b))
* **ci:** apply biome formatting to the gateway LLM gate script ([#2265](https://github.com/lobu-ai/lobu/issues/2265)) ([73ebb49](https://github.com/lobu-ai/lobu/commit/73ebb49944d6ddc6f8cbf6400d08abb0bc381861))
* **owletto:** keep the HTTP status on a failed request ([#2272](https://github.com/lobu-ai/lobu/issues/2272)) ([2373d5a](https://github.com/lobu-ai/lobu/commit/2373d5a2f54d9c42a93d0535870332302ce2cbe6))
* **worker:** stop dead-credential and personal-connection failures from surfacing as raw crashes ([#2268](https://github.com/lobu-ai/lobu/issues/2268)) ([85720b7](https://github.com/lobu-ai/lobu/commit/85720b7bc76618f7803e3c4f767e00923574e9b7))

## [14.5.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.4.1...lobu-v14.5.0) (2026-07-28)


### Features

* **ci:** audit that the newest stable release is actually served by ghcr ([#2256](https://github.com/lobu-ai/lobu/issues/2256)) ([f62d25b](https://github.com/lobu-ai/lobu/commit/f62d25bef495788103fbc94f898954a9ab7e8aa8))
* **web:** fold agent config behind Configure tabs and preview an empty Activity feed ([#2264](https://github.com/lobu-ai/lobu/issues/2264)) ([bc76d85](https://github.com/lobu-ai/lobu/commit/bc76d85ffee2ca2754f1f0ff1b58ce003dd67cbb))


### Bug Fixes

* **ci:** stop main pushes from evicting a queued release build ([#2250](https://github.com/lobu-ai/lobu/issues/2250)) ([124bc14](https://github.com/lobu-ai/lobu/commit/124bc14854f13bd98cc2c1ff4b848586191f7c8a))
* **docker:** ship the lobu CLI in the app image ([#2258](https://github.com/lobu-ai/lobu/issues/2258)) ([0a80acd](https://github.com/lobu-ai/lobu/commit/0a80acd3216974441d80b8f68c77dba1fa835beb))
* **server:** keep an org's default inference provider populated ([#2240](https://github.com/lobu-ai/lobu/issues/2240)) ([db15b96](https://github.com/lobu-ai/lobu/commit/db15b964418c8fbb193405a24572483d1e1409d1))
* **server:** one gateway LLM client, org-resolved credentials ([#2246](https://github.com/lobu-ai/lobu/issues/2246)) ([c1b324d](https://github.com/lobu-ai/lobu/commit/c1b324d272fb5a31b37ac0ae565cd7d938d81a87))
* **server:** reply with an unlinked notice on non-Slack platforms instead of dropping ([#2257](https://github.com/lobu-ai/lobu/issues/2257)) ([5bc4590](https://github.com/lobu-ai/lobu/commit/5bc4590848032f21c0322896121f366bc0fa85fa))
* **worker:** allowlist the agent environment and split the egress proxy credential ([#2263](https://github.com/lobu-ai/lobu/issues/2263)) ([ca4e737](https://github.com/lobu-ai/lobu/commit/ca4e737ad3ef1a9a9b06ade80eb2ab53bae62fac))

## [14.4.1](https://github.com/lobu-ai/lobu/compare/lobu-v14.4.0...lobu-v14.4.1) (2026-07-28)


### Bug Fixes

* **scripts:** stop attempting to publish the two inline-only plugin packages ([#2252](https://github.com/lobu-ai/lobu/issues/2252)) ([097cd64](https://github.com/lobu-ai/lobu/commit/097cd6489dd025c4de4f13e64a20f92d0c023ae6))
* **server:** declare the subdomain zone to the SPA at runtime ([#2247](https://github.com/lobu-ai/lobu/issues/2247)) ([70145d2](https://github.com/lobu-ai/lobu/commit/70145d2253f6fdc9b4005cb5e2abc54d3f22b9a8))

## [14.4.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.3.0...lobu-v14.4.0) (2026-07-28)


### Features

* **approvals:** expire undecided approvals and add scoped bulk decisions ([#2193](https://github.com/lobu-ai/lobu/issues/2193)) ([728e5d1](https://github.com/lobu-ai/lobu/commit/728e5d10446cc1a23002d21a51cfa58b8f9398ea))
* **chat:** suggested actions across web, Slack, and Telegram ([#2201](https://github.com/lobu-ai/lobu/issues/2201)) ([c29deba](https://github.com/lobu-ai/lobu/commit/c29deba5d5d0bf6ccde6a3b98fe0b0e9eedb9832))
* **client:** agent config UI cleanup — Permissions into Guardrails, Goal label (owletto[#612](https://github.com/lobu-ai/lobu/issues/612)) ([#2228](https://github.com/lobu-ai/lobu/issues/2228)) ([040623b](https://github.com/lobu-ai/lobu/commit/040623be342aedfba1eb037cd8c7d3cfb6324575))
* **guardrails:** require-tool + suggest-followups enrichment ([#2226](https://github.com/lobu-ai/lobu/issues/2226)) ([fc4df6f](https://github.com/lobu-ai/lobu/commit/fc4df6fad904bf96b891aca98c146b128ff005a0))
* **memory:** show entity types as an ERD instead of a flat list ([#2190](https://github.com/lobu-ai/lobu/issues/2190)) ([e79e559](https://github.com/lobu-ai/lobu/commit/e79e5590217727c620066ed8310b29ece952668c))
* **server:** audit every external tool invocation with its MCP session id ([#2233](https://github.com/lobu-ai/lobu/issues/2233)) ([eedb135](https://github.com/lobu-ai/lobu/commit/eedb1352095ba02f48dc71c5e18f6e9a5b604225))
* **server:** Connected apps inventory with owner-scoped MCP revocation ([#2219](https://github.com/lobu-ai/lobu/issues/2219)) ([2e50529](https://github.com/lobu-ai/lobu/commit/2e505295edd9fed8caa001b3211171eed3122a9f))
* **server:** connector-contributed agent tooling with credential leases ([#2243](https://github.com/lobu-ai/lobu/issues/2243)) ([932ccf5](https://github.com/lobu-ai/lobu/commit/932ccf51cb748950080d0c81d6894573c1296b79))
* **server:** org-level MCP session activity endpoint + session-stamped approval events ([#2239](https://github.com/lobu-ai/lobu/issues/2239)) ([c1af191](https://github.com/lobu-ai/lobu/commit/c1af1912eeb9608533f939bbcb038fc6be1adaf5))
* **server:** resolve approval notifications to live run state via their proposal-event pointer ([#2216](https://github.com/lobu-ai/lobu/issues/2216)) ([93ff79b](https://github.com/lobu-ai/lobu/commit/93ff79b92690c4c2985ff6832027d8a2e54568f2))
* **server:** surface runtime credential fields and route provider CTAs at connector detail ([#2236](https://github.com/lobu-ai/lobu/issues/2236)) ([1da1404](https://github.com/lobu-ai/lobu/commit/1da14045c40b7fcfae94c54b64458e8a2206b434))


### Bug Fixes

* **agent-history:** scope platform conversation reads to the ambient org too ([#2181](https://github.com/lobu-ai/lobu/issues/2181)) ([4a0dfbe](https://github.com/lobu-ai/lobu/commit/4a0dfbe097f9619c71d912a571913ddf2452c075))
* **agents:** make every agent-create path produce a runnable agent ([#2192](https://github.com/lobu-ai/lobu/issues/2192)) ([abbe5e7](https://github.com/lobu-ai/lobu/commit/abbe5e78695ad7b2b60fdd607dc7027de28dd4a9))
* **api:** expose behavior IDs in operation responses ([#2227](https://github.com/lobu-ai/lobu/issues/2227)) ([c08185b](https://github.com/lobu-ai/lobu/commit/c08185b8a9a9a5cd0615dab545a612db47815376))
* **chat:** materialize chat-link on connection-owner fallback so grid channels are visible ([#2188](https://github.com/lobu-ai/lobu/issues/2188)) ([a2fcbec](https://github.com/lobu-ai/lobu/commit/a2fcbec0a9d723d39c121bff0ac69a5bfc26c23b))
* **ci:** tag docker images to releases instead of every main push ([#2241](https://github.com/lobu-ai/lobu/issues/2241)) ([8d6146e](https://github.com/lobu-ai/lobu/commit/8d6146e7853fe3ef09147a1893bc548577723f70))
* **connections:** carry fallback agent_id across a Slack Grid enterprise supersede ([#2189](https://github.com/lobu-ai/lobu/issues/2189)) ([c025018](https://github.com/lobu-ai/lobu/commit/c025018f60fd73ab72db7a5d21dd5beab2a490fb))
* **scripts:** refuse to publish a package whose [@lobu](https://github.com/lobu) dependency is unpublished ([#2235](https://github.com/lobu-ai/lobu/issues/2235)) ([debf9e4](https://github.com/lobu-ai/lobu/commit/debf9e46ab90811a730a71b60e4d33eb9ad85b14))
* **search:** gate search_memory connections on the shared visibility predicate ([#2191](https://github.com/lobu-ai/lobu/issues/2191)) ([8cd1fd8](https://github.com/lobu-ai/lobu/commit/8cd1fd8c1c33f8087cddd8bda1f18f14751d7b17))
* **security:** encrypt env auth-profile credentials at rest ([#2198](https://github.com/lobu-ai/lobu/issues/2198)) ([53f1e50](https://github.com/lobu-ai/lobu/commit/53f1e50279645d58490a91ecdfdb84e662db4ede))
* **security:** stop leaking connection/feed config secrets on every read path ([#2195](https://github.com/lobu-ai/lobu/issues/2195)) ([bc24c50](https://github.com/lobu-ai/lobu/commit/bc24c50e926d225c87dcf94576456aa1da4ad8a2))
* **server:** archive device connector definitions the fleet no longer serves ([#2213](https://github.com/lobu-ai/lobu/issues/2213)) ([fc62394](https://github.com/lobu-ai/lobu/commit/fc62394d36c6d15bde2af22ba654090208bd6fdb))
* **server:** escape notification bodies per surface, not with Slack entities ([#2210](https://github.com/lobu-ai/lobu/issues/2210)) ([0dd712b](https://github.com/lobu-ai/lobu/commit/0dd712b7411679c0428fbd91b0aa5703ffd0ef59))
* **server:** filter events by OAuth client id, and stop dropping filters on the score path ([#2211](https://github.com/lobu-ai/lobu/issues/2211)) ([7d41b71](https://github.com/lobu-ai/lobu/commit/7d41b710fc554d9d579b5b72a3bf9b866b7df7c5))
* **server:** stop classification_filters dropping entity-less events ([#2215](https://github.com/lobu-ai/lobu/issues/2215)) ([7ccce4e](https://github.com/lobu-ai/lobu/commit/7ccce4ea4b356b1f404cf497e4d8fbe71d3f6e4e))
* **server:** surface pending approvals hidden by the ACL resource gate + stop persisting NULL occurred_at ([#2229](https://github.com/lobu-ai/lobu/issues/2229)) ([50bd1ab](https://github.com/lobu-ai/lobu/commit/50bd1abaa3a362654cb2ff60f3b4f744e9ebd1e4))
* **server:** surface query_sql unknown-table errors instead of an empty result ([#2203](https://github.com/lobu-ai/lobu/issues/2203)) ([b089cd5](https://github.com/lobu-ai/lobu/commit/b089cd56aa092d2d63ce8b8007eb4a13d441c0ee))
* **server:** union nix packages at resolve time so skill/request deps reach the worker ([#2218](https://github.com/lobu-ai/lobu/issues/2218)) ([f9771ab](https://github.com/lobu-ai/lobu/commit/f9771ab155a732637b7b277cb522478109e505bd))
* **web:** make connector detail usable when empty, and fix App install URL ([#2204](https://github.com/lobu-ai/lobu/issues/2204)) ([2c557aa](https://github.com/lobu-ai/lobu/commit/2c557aa613e048b4908d004d2535f6f4a55fdeef))

## [14.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.2.0...lobu-v14.3.0) (2026-07-24)


### Features

* **agents:** schema-driven model config on manage_agents ([#2047](https://github.com/lobu-ai/lobu/issues/2047)) ([#2053](https://github.com/lobu-ai/lobu/issues/2053)) ([e83522e](https://github.com/lobu-ai/lobu/commit/e83522e6760e6cfde69186dc7a7f257bfe23956c))
* **behaviors:** multi-trigger editor (owletto[#581](https://github.com/lobu-ai/lobu/issues/581)) ([#2174](https://github.com/lobu-ai/lobu/issues/2174)) ([5f828dd](https://github.com/lobu-ai/lobu/commit/5f828ddfeb3516b83811eac406be85533b7e23a6))
* **behaviors:** seed an editable default prompt from the chosen trigger ([#2167](https://github.com/lobu-ai/lobu/issues/2167)) ([48a8fae](https://github.com/lobu-ai/lobu/commit/48a8fae19b502738294ff09bf8aa1a72e2d6932e))
* **chat:** link Slack replies to Lobu transcripts ([#2137](https://github.com/lobu-ai/lobu/issues/2137)) ([f02d029](https://github.com/lobu-ai/lobu/commit/f02d029e7546b9842bd14d45bd91b3cb80da5b7f))
* **connectors:** backfill org ownership + retire shared custom writes ([#2045](https://github.com/lobu-ai/lobu/issues/2045)) ([#2066](https://github.com/lobu-ai/lobu/issues/2066)) ([4a71ab8](https://github.com/lobu-ai/lobu/commit/4a71ab8f7daf6f67a744ce05653fc1d5fbf45a30))
* **connectors:** connector source lifecycle via manage_connections ([#2045](https://github.com/lobu-ai/lobu/issues/2045)) ([#2058](https://github.com/lobu-ai/lobu/issues/2058)) ([bf343c1](https://github.com/lobu-ai/lobu/commit/bf343c1bdd44ae804d35f63e7c484e1439f1de2f))
* **connectors:** operator allow-host list for DB egress under cloud mode ([#2158](https://github.com/lobu-ai/lobu/issues/2158)) ([11f3a2f](https://github.com/lobu-ai/lobu/commit/11f3a2f51f06d36b91bd1dca51c506b5c69fd30a))
* **connectors:** org-preferring resolution + cross-org fence ([#2045](https://github.com/lobu-ai/lobu/issues/2045), step 2/3) ([#2065](https://github.com/lobu-ai/lobu/issues/2065)) ([e06692f](https://github.com/lobu-ai/lobu/commit/e06692f7a7fa40f9f7dbfd89600904c893ca06ff))
* **connectors:** org-scoped connector_versions — migration + dual-write ([#2045](https://github.com/lobu-ai/lobu/issues/2045) follow-up, step 1/3) ([#2064](https://github.com/lobu-ai/lobu/issues/2064)) ([25b8165](https://github.com/lobu-ai/lobu/commit/25b816577c59af9684301c0478cb2a88e9de1fea))
* **connectors:** validate_connector_source surfaces extracted action policy ([#2087](https://github.com/lobu-ai/lobu/issues/2087)) ([31f699d](https://github.com/lobu-ai/lobu/commit/31f699d3b6a781d57c0c31b50cf07f823533feac))
* **deploy:** deployment snapshots + lobu rollback + promotions pause ([#2045](https://github.com/lobu-ai/lobu/issues/2045) capstone) ([#2068](https://github.com/lobu-ai/lobu/issues/2068)) ([bc7b22d](https://github.com/lobu-ai/lobu/commit/bc7b22da2dd0a78018c6c115b8ec5a2d0c613682))
* **errors:** structured connector/query error taxonomy + auto-retry ([#2051](https://github.com/lobu-ai/lobu/issues/2051)) ([#2074](https://github.com/lobu-ai/lobu/issues/2074)) ([db67b7b](https://github.com/lobu-ai/lobu/commit/db67b7b854b42bce19dbacb44fbb9ff1063697de))
* **examples:** attribute LinkedIn home-feed authors by name, not link order ([#2130](https://github.com/lobu-ai/lobu/issues/2130)) ([8530e24](https://github.com/lobu-ai/lobu/commit/8530e247184297dc784167432aa5109289238507))
* **examples:** mint author and engager people from LinkedIn home-feed cards ([#2123](https://github.com/lobu-ai/lobu/issues/2123)) ([7dfd140](https://github.com/lobu-ai/lobu/commit/7dfd1404fc0b3193e7833a52d327af0720a69bc9))
* landing-page theme on public pages + owletto bump ([#2169](https://github.com/lobu-ai/lobu/issues/2169)) ([b578734](https://github.com/lobu-ai/lobu/commit/b57873424d933a01227aa7a6c5c572e2bef664c7))
* **linkedin:** prepare_comment stages draft (never auto-posts) ([#2125](https://github.com/lobu-ai/lobu/issues/2125)) ([3cb0e46](https://github.com/lobu-ai/lobu/commit/3cb0e466be116d2615e7cda2375ab118e6328acb))
* **linkedin:** verify_staged_comment + conversation handoff stamps ([#2129](https://github.com/lobu-ai/lobu/issues/2129)) ([45699ec](https://github.com/lobu-ai/lobu/commit/45699ecede2672d8a9baf5f7fc371e41b5ebb239))
* **provenance:** send a Behavior's run link to its drill-down ([#2160](https://github.com/lobu-ai/lobu/issues/2160)) ([990dbbf](https://github.com/lobu-ai/lobu/commit/990dbbffc886e0210f347b1e8f5684f02e9bf4ca))
* **sdk:** notifications.list + notifications.markRead ([#2109](https://github.com/lobu-ai/lobu/issues/2109)) ([06a5deb](https://github.com/lobu-ai/lobu/commit/06a5deb9848fc0a63b0b652e7628921625d92d68))
* **server:** allowlist entity_relationships for sandbox/query_sql ([#2124](https://github.com/lobu-ai/lobu/issues/2124)) ([a716d9c](https://github.com/lobu-ai/lobu/commit/a716d9cb83ba78d0dfff04e40e917218fdfdeae7))
* **server:** operational list_runs filters + metric_series time bounds ([#2051](https://github.com/lobu-ai/lobu/issues/2051)) ([#2059](https://github.com/lobu-ai/lobu/issues/2059)) ([eaeff80](https://github.com/lobu-ai/lobu/commit/eaeff808e33c7e66683febeba3bea92c0e248e87))
* **worker:** inject shell-runtime limits for local vs remote sandbox pins ([#2185](https://github.com/lobu-ai/lobu/issues/2185)) ([3beddc6](https://github.com/lobu-ai/lobu/commit/3beddc63ec8319fc6746751199781185f6478c61))


### Bug Fixes

* **agent-history:** scope threads to the ambient org, not ownership-first ([#2176](https://github.com/lobu-ai/lobu/issues/2176)) ([df48c19](https://github.com/lobu-ai/lobu/commit/df48c19246ee4456997bfe07e4ed033a568f4830))
* **agents:** direct agents to query workspace data before deflecting to chat-only ([#2168](https://github.com/lobu-ai/lobu/issues/2168)) ([3d1e538](https://github.com/lobu-ai/lobu/commit/3d1e538cc789452803545f12b320b120f934acfa))
* **authz:** don't stamp inviter identity onto invitee placeholder $member ([#2126](https://github.com/lobu-ai/lobu/issues/2126)) ([9a12c08](https://github.com/lobu-ai/lobu/commit/9a12c08cb6bb7ceb2a2f9443606a68ef0c815fd1))
* **authz:** grant Builder admin tools for Slack installers ([#2136](https://github.com/lobu-ai/lobu/issues/2136)) ([f7cc981](https://github.com/lobu-ai/lobu/commit/f7cc9811eb9ff15dad708bebc5e1389eb81e684e))
* **authz:** provision $member atomically — no claimless orphan, throw on mismatch ([#2177](https://github.com/lobu-ai/lobu/issues/2177)) ([138220f](https://github.com/lobu-ai/lobu/commit/138220f2fc1d79f36bdd86a759f6d9a39609b92c))
* **authz:** target Slack identity per-member-org and adopt person-owned claims ([#2131](https://github.com/lobu-ai/lobu/issues/2131)) ([f2ff8a8](https://github.com/lobu-ai/lobu/commit/f2ff8a83cd5ec56cc2188b17c1e1f50206c1ab44))
* **behaviors:** bind promoted-entity provenance to the window's granted content ([#2106](https://github.com/lobu-ai/lobu/issues/2106)) ([64dd844](https://github.com/lobu-ai/lobu/commit/64dd84461fe98b9aef9f589f032209dc4a346933))
* **behaviors:** clearer error when update has no patchable field ([#2089](https://github.com/lobu-ai/lobu/issues/2089)) ([1c2cd07](https://github.com/lobu-ai/lobu/commit/1c2cd07abd079fc16ee59b32050bd0243bd2cea2))
* **behaviors:** create_version explicit source replacement, no silent inherit ([#2048](https://github.com/lobu-ai/lobu/issues/2048)) ([#2054](https://github.com/lobu-ai/lobu/issues/2054)) ([e4e621c](https://github.com/lobu-ai/lobu/commit/e4e621c9b609ac99c264e73926d3446df6524bfa))
* **behaviors:** don't drop sources when only the prompt text is edited ([#2099](https://github.com/lobu-ai/lobu/issues/2099)) ([f6c5c32](https://github.com/lobu-ai/lobu/commit/f6c5c32fda724bc903488ab4d553450f233d6b49))
* **behaviors:** failed runs degrade health; fix update doc + vocab leak ([#2082](https://github.com/lobu-ai/lobu/issues/2082)) ([44a54f5](https://github.com/lobu-ai/lobu/commit/44a54f5f5ebb8e5222e4ebb712ef87faf05bd7ff))
* **behaviors:** read renamed behavior_run_* columns in manage_behaviors list health ([#2041](https://github.com/lobu-ai/lobu/issues/2041)) ([0d2e7b2](https://github.com/lobu-ai/lobu/commit/0d2e7b2067f75ebd27bfaf49452e62ccb43dbe2d))
* **behaviors:** reject custom-SQL sources referencing a non-existent table ([#2093](https://github.com/lobu-ai/lobu/issues/2093)) ([e96cb3c](https://github.com/lobu-ai/lobu/commit/e96cb3c8aa1649121908cb1a78d2be0aabdcee2d))
* **behaviors:** validate cloned sources on create_from_version ([#2102](https://github.com/lobu-ai/lobu/issues/2102)) ([d568dca](https://github.com/lobu-ai/lobu/commit/d568dca9b01eb5edaa9491ad1f04f364beebfc1e))
* **behaviors:** validate custom-SQL sources at save time ([#2088](https://github.com/lobu-ai/lobu/issues/2088)) ([043291a](https://github.com/lobu-ai/lobu/commit/043291a03c137d2cba706c0fbfacd3dade23bdc2))
* **canvas:** bind canvas entities to a built-in $canvas type, not $member ([#2101](https://github.com/lobu-ai/lobu/issues/2101)) ([568f011](https://github.com/lobu-ai/lobu/commit/568f0112a1334214098cbc5c3ffa2a3157277795))
* **catalog:** stop advertising a 'channels' installed kind that list_installed rejects ([#2120](https://github.com/lobu-ai/lobu/issues/2120)) ([130cd47](https://github.com/lobu-ai/lobu/commit/130cd47b887362eb7beef677ba46682fe937ef66))
* **chat:** retire streaming chat feeds leaked onto retired connections ([#2157](https://github.com/lobu-ai/lobu/issues/2157)) ([2f35b9d](https://github.com/lobu-ai/lobu/commit/2f35b9d5cb733a06e0e6326c214ce90ff7e7cae3))
* **chat:** retire streaming feeds when their connection is tombstoned ([#2163](https://github.com/lobu-ai/lobu/issues/2163)) ([c4b1998](https://github.com/lobu-ai/lobu/commit/c4b1998f42ec72aa942d5d31522b59d995050a60))
* **chat:** supersede stale org-wide Grid connections on per-workspace reinstall ([#2166](https://github.com/lobu-ai/lobu/issues/2166)) ([28f45fe](https://github.com/lobu-ai/lobu/commit/28f45fe4054e8bea5585aa3ed86c074641ee0380))
* **cli:** clear message on unsupported Node instead of undici crash ([#2175](https://github.com/lobu-ai/lobu/issues/2175)) ([a60e30d](https://github.com/lobu-ai/lobu/commit/a60e30da7fe994a777d1d81459207a5abe2a2e97))
* **cli:** friendly ENCRYPTION_KEY setup message on bare lobu run ([#2182](https://github.com/lobu-ai/lobu/issues/2182)) ([ecad0d0](https://github.com/lobu-ai/lobu/commit/ecad0d0593809b78c08fe12a49fcdef19a32344a))
* **cli:** surface Node 25 sandbox-unavailable warning upfront in lobu run ([#2178](https://github.com/lobu-ai/lobu/issues/2178)) ([5600fdd](https://github.com/lobu-ai/lobu/commit/5600fdd9d5b6eb21292a8cec8c566949228bbff2))
* **connections:** device-aware connections.test + accurate result types ([#2083](https://github.com/lobu-ai/lobu/issues/2083)) ([1ddd223](https://github.com/lobu-ai/lobu/commit/1ddd22378145acd4ff322820f73fefc49b6ff863))
* **connectors:** skip bundled (NULL-org) definitions in connector_versions backfill ([#2067](https://github.com/lobu-ai/lobu/issues/2067)) ([#2071](https://github.com/lobu-ai/lobu/issues/2071)) ([af29895](https://github.com/lobu-ai/lobu/commit/af29895db1937beb5e40ef4890a797dab1de3f4f))
* **core:** single-source the interaction-envelope wire literals ([#2110](https://github.com/lobu-ai/lobu/issues/2110)) ([5e536d4](https://github.com/lobu-ai/lobu/commit/5e536d42a3af6118d098bab28e53b3525e0e8d10))
* **deployments:** emit behavior, not watcher, in counts_by_kind ([#2113](https://github.com/lobu-ai/lobu/issues/2113)) ([d9610b3](https://github.com/lobu-ai/lobu/commit/d9610b32d44575df447850f4be0a633d59cba967))
* **entities:** force_delete_tree detaches event references instead of blocking, adds dry_run preflight ([#2057](https://github.com/lobu-ai/lobu/issues/2057)) ([6487e51](https://github.com/lobu-ai/lobu/commit/6487e51f591a43cd25387d5683852396efa7739d))
* **events:** canonicalize legacy watcher resourceKind on supersede ([#2114](https://github.com/lobu-ai/lobu/issues/2114)) ([ab59a98](https://github.com/lobu-ai/lobu/commit/ab59a98e7999d7c2ead0e71d390656cb2296199d))
* **events:** reject mis-bound handler props in agent-authored templates ([#2096](https://github.com/lobu-ai/lobu/issues/2096)) ([89bbc7c](https://github.com/lobu-ai/lobu/commit/89bbc7c075a444f4e7188c63a500ee58b6e46c00))
* **examples:** strip social-context banners from LinkedIn home-feed authors ([#2122](https://github.com/lobu-ai/lobu/issues/2122)) ([0588aa9](https://github.com/lobu-ai/lobu/commit/0588aa9ea6999d2e7569cf59dc650cb3edc3ebc1))
* **feeds:** true total + has_more and a health filter for list_feeds ([#2080](https://github.com/lobu-ai/lobu/issues/2080)) ([380844a](https://github.com/lobu-ai/lobu/commit/380844aa02a53984a91ab687a746041caac0d56d))
* **knowledge:** exact content_ids read surfaces applied classifications ([#2050](https://github.com/lobu-ai/lobu/issues/2050)) ([#2056](https://github.com/lobu-ai/lobu/issues/2056)) ([cfdc790](https://github.com/lobu-ai/lobu/commit/cfdc7901ce87e787ff2e68e05b670942747ef9d2))
* **mcp:** auth-free connection test, classifier list default, honest knowledge indexing status ([#2051](https://github.com/lobu-ai/lobu/issues/2051)) ([#2072](https://github.com/lobu-ai/lobu/issues/2072)) ([e974fde](https://github.com/lobu-ai/lobu/commit/e974fdec06cc6e449fca850f760713c84ddb8f69))
* **mcp:** bind the worker token's verified agent identity to the MCP session ([#2128](https://github.com/lobu-ai/lobu/issues/2128)) ([23c99b2](https://github.com/lobu-ai/lobu/commit/23c99b28744e45dddcd790e1b72d93964c5fea9e))
* **memory:** entity-type settings gear + derived entity_count ([#2138](https://github.com/lobu-ai/lobu/issues/2138)) ([a3d1e40](https://github.com/lobu-ai/lobu/commit/a3d1e40012d8a370fa70ad984ad049764ada468c))
* **merge:** make merge approval cards reviewable, and let the proposer explain itself ([#2142](https://github.com/lobu-ai/lobu/issues/2142)) ([15423ea](https://github.com/lobu-ai/lobu/commit/15423ea0a356236e5d09f0be4d067536225d2bae))
* **operations:** expose recorded initiator through list_runs and get_run ([#2164](https://github.com/lobu-ai/lobu/issues/2164)) ([af1e2de](https://github.com/lobu-ai/lobu/commit/af1e2defce28bd269c2efdf483c411b926a1a72d))
* **operations:** get_run can fetch internal runs, not only action runs ([#2084](https://github.com/lobu-ai/lobu/issues/2084)) ([3ac3a5a](https://github.com/lobu-ai/lobu/commit/3ac3a5a4a4f543bf037c21b9d5c3cbdbcd4754b8))
* **operations:** get_run resolves any listed run_type, not just action+internal ([#2086](https://github.com/lobu-ai/lobu/issues/2086)) ([6dd31e2](https://github.com/lobu-ai/lobu/commit/6dd31e2a1d5a831ed19df79d83cd793448b042ed))
* **operations:** scope-aware readiness for connector actions ([#2079](https://github.com/lobu-ai/lobu/issues/2079)) ([367d6cc](https://github.com/lobu-ai/lobu/commit/367d6cc551b4ef18b43465c411a7acac33c1cd4d))
* **owletto:** restore page scrolling on all owner routes ([#2091](https://github.com/lobu-ai/lobu/issues/2091)) ([dfe3dc8](https://github.com/lobu-ai/lobu/commit/dfe3dc8411eddb8e50bd78c2a6d691aad53ef5f3))
* **plugin-mcp:** approval cards must emit resourceKind/attribution 'behavior', not 'watcher' ([#2105](https://github.com/lobu-ai/lobu/issues/2105)) ([a727478](https://github.com/lobu-ai/lobu/commit/a727478c18d30e85ec60e1f4637406336cdd7008))
* **public-pages:** exclude $-prefixed system entity types from public pages and sitemap ([#2104](https://github.com/lobu-ai/lobu/issues/2104)) ([ae90883](https://github.com/lobu-ai/lobu/commit/ae908835d9fa51e9620ae01e00dc7c9a9cf010c5))
* **publish:** surface first-publish 404s instead of aborting the release ([#2062](https://github.com/lobu-ai/lobu/issues/2062)) ([166bc6f](https://github.com/lobu-ai/lobu/commit/166bc6f8835f69ead46f8043ae8f3a9e3ecf142b))
* **resolution:** read entity_identities, not just metadata, when proving duplicates ([#2152](https://github.com/lobu-ai/lobu/issues/2152)) ([7c190dd](https://github.com/lobu-ai/lobu/commit/7c190dd089c27b549660f74b6fddf179032822cb))
* **rest:** emit behavior_* on the public behavior-window route ([#2118](https://github.com/lobu-ai/lobu/issues/2118)) ([9da972d](https://github.com/lobu-ai/lobu/commit/9da972d90763a33cb1b00b0adae65c626c366bf5))
* **runs:** stale-run reaper must not time out human-approval-pending runs ([#2044](https://github.com/lobu-ai/lobu/issues/2044)) ([#2055](https://github.com/lobu-ai/lobu/issues/2055)) ([5e3b0f6](https://github.com/lobu-ai/lobu/commit/5e3b0f680db1e7a71540509d45cb96bbeb98a169))
* **sandbox:** make SDK discovery match runtime contract ([#2046](https://github.com/lobu-ai/lobu/issues/2046)) ([#2060](https://github.com/lobu-ai/lobu/issues/2060)) ([60b7598](https://github.com/lobu-ai/lobu/commit/60b7598ec0079bf17cb5222059c4f527f4f11cb8))

## [14.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.1.0...lobu-v14.2.0) (2026-07-21)


### Features

* consolidate reactive automation on Behaviors ([#2023](https://github.com/lobu-ai/lobu/issues/2023)) ([c3161a7](https://github.com/lobu-ai/lobu/commit/c3161a785c85222f808b06895908494ab04e33ad))
* **gmail:** mint contacts on outbound send, not receive-only ([#2027](https://github.com/lobu-ai/lobu/issues/2027)) ([22b0907](https://github.com/lobu-ai/lobu/commit/22b0907175b683e7fd519b98bf134c45f5231c02))
* integrate Midas connector and optimize Revolut schemas ([#2010](https://github.com/lobu-ai/lobu/issues/2010)) ([aae5688](https://github.com/lobu-ai/lobu/commit/aae56884033b6882824a2d7a7f3850cd874c594d))
* list_activity feed + Home + agent attention inject ([#2022](https://github.com/lobu-ai/lobu/issues/2022)) ([f4858e1](https://github.com/lobu-ai/lobu/commit/f4858e119ac542d25cde5e833ff4b2fd6b6e0034))


### Bug Fixes

* **cli:** correct GitHub connection auth + dead example ref in AGENTS.md template ([#2029](https://github.com/lobu-ai/lobu/issues/2029)) ([d324524](https://github.com/lobu-ai/lobu/commit/d32452476c23e85bb490bdce2600e47259e48883))
* **compiler:** AST-level import validation, self-contained catalog sources, hard feed errors ([#2042](https://github.com/lobu-ai/lobu/issues/2042), [#2043](https://github.com/lobu-ai/lobu/issues/2043)) ([75a59d4](https://github.com/lobu-ai/lobu/commit/75a59d465e9610bac6f55f7a070220ec09d76263))
* **feeds:** omit schedule means manual-only, clear default 6h ([#2021](https://github.com/lobu-ai/lobu/issues/2021)) ([df7dd93](https://github.com/lobu-ai/lobu/commit/df7dd93bc58bc040ce2aa1e1c563397bf49ad99b))
* **gateway:** heartbeat-only ACKs no longer pin the worker idle clock ([#1999](https://github.com/lobu-ai/lobu/issues/1999)) ([#2026](https://github.com/lobu-ai/lobu/issues/2026)) ([6032152](https://github.com/lobu-ai/lobu/commit/6032152f77d614f5a2f1cd4a495d58b0241872fa))
* **gmail:** require gmail.compose so create_draft is authorized ([#2061](https://github.com/lobu-ai/lobu/issues/2061)) ([4006999](https://github.com/lobu-ai/lobu/commit/4006999b3490acf4ef4d2badedf8a9c9de32bd2e))
* **migrations:** split DO-heal from CONCURRENTLY so dbmate can apply them [migration-never-applied] ([#2032](https://github.com/lobu-ai/lobu/issues/2032)) ([cf25980](https://github.com/lobu-ai/lobu/commit/cf25980443bc6a68c1c13b4f120e318bcddfc8d5))
* **p0:** classifier value round-trip + repair migration, atomic approval-event tx, readiness capability probe ([#2033](https://github.com/lobu-ai/lobu/issues/2033)) ([#2037](https://github.com/lobu-ai/lobu/issues/2037)) ([df0b2d5](https://github.com/lobu-ai/lobu/commit/df0b2d5848387930a9fb6354de79c48ca6df6969))
* **personal-agent:** buremba schema source of truth + prune ([#2013](https://github.com/lobu-ai/lobu/issues/2013)) ([c18a794](https://github.com/lobu-ai/lobu/commit/c18a79495759b49165a3654ca69e57937194267b))
* **personal-agent:** use chrome_dispatcher for Midas connector ([#2018](https://github.com/lobu-ai/lobu/issues/2018)) ([a3214b7](https://github.com/lobu-ai/lobu/commit/a3214b7a3d5bc9e403ab2347be6d2720994aed45))
* **personal-agent:** use chrome_dispatcher for Midas connector ([#2018](https://github.com/lobu-ai/lobu/issues/2018)) ([a3214b7](https://github.com/lobu-ai/lobu/commit/a3214b7a3d5bc9e403ab2347be6d2720994aed45))
* remove redundant financial_asset entity ([#2012](https://github.com/lobu-ai/lobu/issues/2012)) ([547fdbb](https://github.com/lobu-ai/lobu/commit/547fdbbaf02432d8b49aafac4e2f49cbc42d1a0e))
* resolve Claude PreToolUse hooks from project root ([#2024](https://github.com/lobu-ai/lobu/issues/2024)) ([d247a57](https://github.com/lobu-ai/lobu/commit/d247a57d40c93c0bac42d0b3950a2638a9ec44b9))
* **scheduler:** feed failure backoff + auto-pause, behavior health surfacing, github empty-body guard ([#2033](https://github.com/lobu-ai/lobu/issues/2033)) ([#2035](https://github.com/lobu-ai/lobu/issues/2035)) ([976c41c](https://github.com/lobu-ai/lobu/commit/976c41c815dd97a662123314bf6e17649c11e8e9))
* **sdk:** consistent knowledge delete key, honor include_deleted, expose enums, read-mode admin lists ([#2033](https://github.com/lobu-ai/lobu/issues/2033)) ([#2036](https://github.com/lobu-ai/lobu/issues/2036)) ([d42916a](https://github.com/lobu-ai/lobu/commit/d42916aaa56832111ffc21991d34ba4f0a7d2328))

## [14.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v14.0.0...lobu-v14.1.0) (2026-07-16)


### Features

* **agents:** merge defaultModel+installedProviders into one ordered models allow-list ([#1839](https://github.com/lobu-ai/lobu/issues/1839)) ([d2bb92b](https://github.com/lobu-ai/lobu/commit/d2bb92ba6b4cd971e5042c80dad5fbc897a8b5f9))
* **authz:** generalized write-gate policy — per-principal, run change-set, batched approvals ([#1827](https://github.com/lobu-ai/lobu/issues/1827)) ([9955830](https://github.com/lobu-ai/lobu/commit/99558304bc4ed843d4233554d82f8926a707b984))
* **bang-bash:** run `!command` as shell in the conversation's pinned sandbox (PR-D4) ([#1987](https://github.com/lobu-ai/lobu/issues/1987)) ([73ca450](https://github.com/lobu-ai/lobu/commit/73ca450952cf9e246b7bccc79f66e673d9150da8))
* **cli:** config-less infra commands — providers, environments, clients ([#1862](https://github.com/lobu-ai/lobu/issues/1862)) ([a0a0153](https://github.com/lobu-ai/lobu/commit/a0a0153326894679a14cfe64205404c859656730))
* **cli:** declare virtual (federated) feeds in lobu.config.ts ([#1899](https://github.com/lobu-ai/lobu/issues/1899)) ([#1920](https://github.com/lobu-ai/lobu/issues/1920)) ([8406f0d](https://github.com/lobu-ai/lobu/commit/8406f0d69c6b11513a16530e3f477ea9f8dffb37))
* **config-prefill:** approve builder config changes via a prefilled deep link (WI-0.3) ([#1918](https://github.com/lobu-ai/lobu/issues/1918)) ([9e819d4](https://github.com/lobu-ai/lobu/commit/9e819d496c6f7e7234a72ef906e62b00c81d2ff2))
* **connectors:** cloud egress hardening for DB connectors — IP pinning + forced TLS; open postgres cloud gate ([#1896](https://github.com/lobu-ai/lobu/issues/1896)) ([d8a2f9e](https://github.com/lobu-ai/lobu/commit/d8a2f9eec71a3811c0e9b876cad9dff5edb43fc4))
* **connectors:** connector-scoped chat facet + shared UI shell (bump owletto) ([#1828](https://github.com/lobu-ai/lobu/issues/1828)) ([aa32973](https://github.com/lobu-ai/lobu/commit/aa32973d139901ae120b52036fb90ef274d7559c))
* **conversations:** conversations SDK namespace (list/get/send) ([#1952](https://github.com/lobu-ai/lobu/issues/1952)) ([3f6cce4](https://github.com/lobu-ai/lobu/commit/3f6cce42e55c71b995c17a9a6653fe4668768447))
* **conversations:** first-class conversations entity as single listing source ([#1947](https://github.com/lobu-ai/lobu/issues/1947)) ([75577e3](https://github.com/lobu-ai/lobu/commit/75577e3f2c06df36bd8563db22e20375954f8ed6))
* **core:** AgentSettings TypeBox schema — single source for all surfaces ([#1942](https://github.com/lobu-ai/lobu/issues/1942)) ([46657b0](https://github.com/lobu-ai/lobu/commit/46657b045cc97099b336e13981b542129ae5d871))
* **core:** collapse plugin-types + GuardrailStage to single source ([#1945](https://github.com/lobu-ai/lobu/issues/1945)) ([#1945](https://github.com/lobu-ai/lobu/issues/1945)) ([2f76eb4](https://github.com/lobu-ai/lobu/commit/2f76eb43798344b21cd8aab57c473919c8ff1029))
* exhaustive AgentSettings converters — compile-time drift guarantee ([#1943](https://github.com/lobu-ai/lobu/issues/1943)) ([5acee92](https://github.com/lobu-ai/lobu/commit/5acee92b49c5e9cc08fc9c077e0dd590b219eb16))
* **mcp:** source-blind connector discovery + public SDK error normalization ([#1950](https://github.com/lobu-ai/lobu/issues/1950)) ([9687f6b](https://github.com/lobu-ai/lobu/commit/9687f6b7575c34ecc33a0225f8fc9eb681410235))
* **memory:** org guidance events + render authored context into agent prompts ([#1895](https://github.com/lobu-ai/lobu/issues/1895)) ([d0cb30d](https://github.com/lobu-ai/lobu/commit/d0cb30de0080b63134a3728b9042b4bd2a186991))
* **oauth:** config-driven subscription OAuth + SuperGrok ([#1821](https://github.com/lobu-ai/lobu/issues/1821)) ([9d73b6f](https://github.com/lobu-ai/lobu/commit/9d73b6f498f3a6a397bfca544fca68376f2c664d))
* **providers:** unify sandboxes onto the providers surface + cut vestigial env scope ([#1914](https://github.com/lobu-ai/lobu/issues/1914)) ([2711b0a](https://github.com/lobu-ai/lobu/commit/2711b0a83779502e423521719dddeb99c3102bc8))
* rename devices + sticky chrome pin for multi-extension orgs ([#1823](https://github.com/lobu-ai/lobu/issues/1823)) ([08f8ca3](https://github.com/lobu-ai/lobu/commit/08f8ca363232bdd2896d74877210e3b92db2d894))
* **sandbox-pin:** pin each conversation's runtime realm; drive bash from the pin ([#1948](https://github.com/lobu-ai/lobu/issues/1948)) ([0a135fc](https://github.com/lobu-ai/lobu/commit/0a135fccc4f1cb29c82104de2a32fb1aa45ebdcf))
* **schedules:** timezone-aware crons, until_at bound, idempotent create ([#1866](https://github.com/lobu-ai/lobu/issues/1866)) ([d26c695](https://github.com/lobu-ai/lobu/commit/d26c695e0435d13cb8e16b0794ddd233687b048b))
* **server:** one TypeBox-sourced OpenAPI document for the typed client ([#1957](https://github.com/lobu-ai/lobu/issues/1957)) ([6e11834](https://github.com/lobu-ai/lobu/commit/6e11834849ece5debd7901430741ad25263587a2))
* **watcher-prefill:** watcher config-approval producer + review endpoint (WI-0.3 parity) ([#1924](https://github.com/lobu-ai/lobu/issues/1924)) ([69be863](https://github.com/lobu-ai/lobu/commit/69be8637aeba294779264bc25f28c2cdac84d336))
* **watchers,feeds:** timezone-aware schedule evaluation ([#1879](https://github.com/lobu-ai/lobu/issues/1879)) ([a78cf51](https://github.com/lobu-ai/lobu/commit/a78cf51cec03e52d0dc0c8a555bbef30f8ecb4c8))
* **watchers:** context:true SQL source for entity dedup windows ([#1818](https://github.com/lobu-ai/lobu/issues/1818)) ([06bc05d](https://github.com/lobu-ai/lobu/commit/06bc05db37aaa9de7617facf5d66a15d3b3d77ca))
* **watchers:** queue watcher-definition writes for approval (WI-0.1) ([#1903](https://github.com/lobu-ai/lobu/issues/1903)) ([5e5e80e](https://github.com/lobu-ai/lobu/commit/5e5e80ed3c9348756c4650a14d528c00e54b5650))
* **write-gate:** action/effect model — child table + manifest ([#1834](https://github.com/lobu-ai/lobu/issues/1834)) ([252a6d1](https://github.com/lobu-ai/lobu/commit/252a6d144ab1af6a2ec0df638d955574bcaabd3a))
* **write-gate:** agent-envelope — per-agent write-permission matrix ([#1837](https://github.com/lobu-ai/lobu/issues/1837)) ([4504637](https://github.com/lobu-ai/lobu/commit/45046378214bfab8013105c6042e22fe53d092d1))
* **write-gate:** per-operation connector_action scope ([#1838](https://github.com/lobu-ai/lobu/issues/1838)) ([0e595bf](https://github.com/lobu-ai/lobu/commit/0e595bfdffba2499cd9c9d9c116a52ad50f4be4c))


### Bug Fixes

* **agents:** org-scope agent-id-keyed binding reads/deletes; drop shadowed route ([#1848](https://github.com/lobu-ai/lobu/issues/1848)) ([4866ba4](https://github.com/lobu-ai/lobu/commit/4866ba4319a49d07b1841af98011ad2ffb1575a9))
* **auth-profiles:** create_auth_profile auto-installs its connector ([#1898](https://github.com/lobu-ai/lobu/issues/1898)) ([#1919](https://github.com/lobu-ai/lobu/issues/1919)) ([f8f8f30](https://github.com/lobu-ai/lobu/commit/f8f8f3098eaaa550f29afb0afd7f63ed96fd8a0e))
* **auth:** clarify email device login approvals ([#1820](https://github.com/lobu-ai/lobu/issues/1820)) ([24c38d7](https://github.com/lobu-ai/lobu/commit/24c38d7153305f94b8a40c8ce7efc3779125e78a))
* **chat:** connect state adapter before off-instance history ops ([#1894](https://github.com/lobu-ai/lobu/issues/1894)) ([6f1d8aa](https://github.com/lobu-ai/lobu/commit/6f1d8aa29abbdf298fe62fbbb48f6f2bcb95d7f8))
* close MCP and ClientSDK contract gaps ([#1887](https://github.com/lobu-ai/lobu/issues/1887)) ([8afb7bf](https://github.com/lobu-ai/lobu/commit/8afb7bf1ce3c46dca9688ddba9ce1b17f18353c5))
* close MCP SDK consistency gaps ([#1882](https://github.com/lobu-ai/lobu/issues/1882)) ([fd4dacb](https://github.com/lobu-ai/lobu/commit/fd4dacb758feac206bc32af5036b34ac6ec80422))
* **connections:** reserve managed Slack stable IDs ([#1855](https://github.com/lobu-ai/lobu/issues/1855)) ([062d793](https://github.com/lobu-ai/lobu/commit/062d793d7af7f650135a824bc9576cbb921867c2))
* **connections:** retry same-org tenant swap deadlocks ([#1854](https://github.com/lobu-ai/lobu/issues/1854)) ([3455dee](https://github.com/lobu-ai/lobu/commit/3455deeff325eaa443100efa3c0993e513320599))
* **connections:** set fallback agent_id via manage_connections update + advisory lock ordering ([#1836](https://github.com/lobu-ai/lobu/issues/1836)) ([1c31d22](https://github.com/lobu-ai/lobu/commit/1c31d2222eb954fbd6628b084ed1f9d7ce92e1bd))
* **connector-worker:** invalidate compiled connector cache on compile-config change ([#1985](https://github.com/lobu-ai/lobu/issues/1985)) ([08fc470](https://github.com/lobu-ai/lobu/commit/08fc470b6a1eb823ab4ff49013f4515a1a7ef802))
* **connectors:** isolate DOM scrapes per action and reject wrong-site results ([#1830](https://github.com/lobu-ai/lobu/issues/1830)) ([248b2b6](https://github.com/lobu-ai/lobu/commit/248b2b65099bd4b7145ab6194f854e6514a314d6))
* **connectors:** surface per-feed fetch failures instead of silent empty syncs ([#1980](https://github.com/lobu-ai/lobu/issues/1980)) ([5a4b20d](https://github.com/lobu-ai/lobu/commit/5a4b20d84335c6560a099baab7fe53c5340ac1e5))
* **core:** remove dead mcpInstallNotified AgentSettings field ([#1939](https://github.com/lobu-ai/lobu/issues/1939)) ([4c17da7](https://github.com/lobu-ai/lobu/commit/4c17da7b4ec6685083c5e39c666786b210e2f262))
* **create-handlers:** close check-then-insert races (getNextNumericId + slug indexes) ([#1967](https://github.com/lobu-ai/lobu/issues/1967)) ([e6797a2](https://github.com/lobu-ai/lobu/commit/e6797a2fd45543c0f9d6358c1bc972ccc3e22b5a))
* current catalog models + GPT-5.6 shortlist ([#1833](https://github.com/lobu-ai/lobu/issues/1833)) ([d44b9d0](https://github.com/lobu-ai/lobu/commit/d44b9d017b3f19ee20a2ccaf72fa53500ea8a910))
* **db:** dedicated advisory-lock pool — group-lock holders no longer starve the main pool ([#1979](https://github.com/lobu-ai/lobu/issues/1979)) ([5cb0fda](https://github.com/lobu-ai/lobu/commit/5cb0fda94a28be2e5acc77db72e11e8b1f32c8d4))
* **device-connectors:** re-sync connector_definitions when a device manifest changes ([#1976](https://github.com/lobu-ai/lobu/issues/1976)) ([1905389](https://github.com/lobu-ai/lobu/commit/190538962f21a6a774d4ed2863b10eef2cde0542))
* **egress:** enforce per-agent deniedDomains, deny-before-judge precedence, any-depth wildcard grants ([#1973](https://github.com/lobu-ai/lobu/issues/1973)) ([4557d5b](https://github.com/lobu-ai/lobu/commit/4557d5b25a08e3b097666bd89b815f8c71bfead2))
* **entity-schema:** createType/createRelType survive the concurrent-create race ([#1962](https://github.com/lobu-ai/lobu/issues/1962)) ([cc4102a](https://github.com/lobu-ai/lobu/commit/cc4102ada292a0e9b84c988df93dca05844950b5))
* **errors:** consolidate the "no usable model" CTA across all surfaces ([#1844](https://github.com/lobu-ai/lobu/issues/1844)) ([58bcd8d](https://github.com/lobu-ai/lobu/commit/58bcd8d75f8f1baa37a623ba0928ae9f6cfad30a))
* harden entity merge approvals ([#2000](https://github.com/lobu-ai/lobu/issues/2000)) ([94bfc54](https://github.com/lobu-ai/lobu/commit/94bfc54d57d4b2dd8802bea68f48ed017c40e4c7))
* keep agent history available on replay errors ([#1857](https://github.com/lobu-ai/lobu/issues/1857)) ([5eee9a4](https://github.com/lobu-ai/lobu/commit/5eee9a47ce11311b295c87b3b6de155c7bb9802e))
* **knowledge:** stop forwarding include_classifications into read_knowledge ([#1888](https://github.com/lobu-ai/lobu/issues/1888)) ([cb89262](https://github.com/lobu-ai/lobu/commit/cb892627f2b9d4bbf51ebbd514123544ad6fc09e))
* make agent error recovery actions durable ([#1847](https://github.com/lobu-ai/lobu/issues/1847)) ([8e3aecf](https://github.com/lobu-ai/lobu/commit/8e3aecf8e1ba247720ab5cda2ace3ace6b8c5d1e))
* **manage_entity_schema:** reject is_symmetric on update instead of silently dropping ([#1941](https://github.com/lobu-ai/lobu/issues/1941)) ([838e9b7](https://github.com/lobu-ai/lobu/commit/838e9b76fe45b8a40b934c781b3b4ed489fb731c))
* **manage_watchers:** reject version-owned fields on update instead of silently dropping ([#1940](https://github.com/lobu-ai/lobu/issues/1940)) ([a64655a](https://github.com/lobu-ai/lobu/commit/a64655ab5e256b94e241c7c2661d8db1005c78e7))
* **mcp:** connector discovery is read-tier, not admin ([#1955](https://github.com/lobu-ai/lobu/issues/1955)) ([130f65c](https://github.com/lobu-ai/lobu/commit/130f65c3fa91b3ccdb66079c7d05306a7df4b103))
* **mcp:** don't suppress connector discovery for scoped-endpoint members ([#1951](https://github.com/lobu-ai/lobu/issues/1951)) ([691361c](https://github.com/lobu-ai/lobu/commit/691361cdb812876c64be4c34370aa96277ccbfce))
* **mcp:** resolve membership role on scoped /mcp/{slug} sessions ([#1953](https://github.com/lobu-ai/lobu/issues/1953)) ([9fa6980](https://github.com/lobu-ai/lobu/commit/9fa6980f683b934873f9d46c52ea7125d5e5d942))
* **oauth:** grant over-requested scopes on auth-code for Slack MCP ([#1907](https://github.com/lobu-ai/lobu/issues/1907)) ([44e68f3](https://github.com/lobu-ai/lobu/commit/44e68f3c03918c7000ec1ee393b8bdd86d91da3a))
* **oauth:** make device-code URL prefill provider-config driven ([#1825](https://github.com/lobu-ai/lobu/issues/1825)) ([6ff2665](https://github.com/lobu-ai/lobu/commit/6ff26659370055cdb9b2250b3aab0136389a09a1))
* **oauth:** never CDN-cache OAuth discovery metadata ([#1905](https://github.com/lobu-ai/lobu/issues/1905)) ([c43a629](https://github.com/lobu-ai/lobu/commit/c43a6298606ca6e3144e1a9210fb70190e15d407))
* **oauth:** prefill device-code verification URLs with user_code ([#1824](https://github.com/lobu-ai/lobu/issues/1824)) ([f1d9eed](https://github.com/lobu-ai/lobu/commit/f1d9eedb361de59376aa6e4ae8567b9cedaf06df))
* **oauth:** stop advertising device-only scopes to third-party MCP clients ([#1901](https://github.com/lobu-ai/lobu/issues/1901)) ([f049d75](https://github.com/lobu-ai/lobu/commit/f049d754738d1c84863adfb7875bf95f52a4df5e))
* prod OOM (4Gi) + gateway test process pollution ([#1996](https://github.com/lobu-ai/lobu/issues/1996)) ([756efc4](https://github.com/lobu-ai/lobu/commit/756efc4783944330b90822d41dc601044f3c943f))
* recover stale pending watcher runs ([#1885](https://github.com/lobu-ai/lobu/issues/1885)) ([d40ec56](https://github.com/lobu-ai/lobu/commit/d40ec56454db91100d512d0c61cbe5a331f53d53))
* **review:** default Herdr tabs off; stream Codex progress when on ([#1890](https://github.com/lobu-ai/lobu/issues/1890)) ([2105585](https://github.com/lobu-ai/lobu/commit/2105585f960706ffac85cb78626bcd73f238dcec))
* **review:** isolate runs and use Herdr tabs ([#1832](https://github.com/lobu-ai/lobu/issues/1832)) ([5863709](https://github.com/lobu-ai/lobu/commit/5863709ec3982d2ae67b7e783ad2d961917031d5))
* **review:** select cross-harness reviewer ([#1843](https://github.com/lobu-ai/lobu/issues/1843)) ([d41833e](https://github.com/lobu-ai/lobu/commit/d41833e2029ee63459ac9242f42a7384df0ba8c6))
* **runtime:** delete environment credentials atomically on row deletion + sweep orphans ([#1902](https://github.com/lobu-ai/lobu/issues/1902)) ([af70a68](https://github.com/lobu-ai/lobu/commit/af70a68bea39a6ce8424334eceecac8bc73bda2c))
* **server:** chrome-extension pins mean browser affinity, not job host ([#1826](https://github.com/lobu-ai/lobu/issues/1826)) ([b6f7670](https://github.com/lobu-ai/lobu/commit/b6f7670a60f8027124e3f61941b33b407b48e044))
* **server:** correct MCP discovery docs + save_memory exact_read shape ([#1984](https://github.com/lobu-ai/lobu/issues/1984)) ([e7a3a88](https://github.com/lobu-ai/lobu/commit/e7a3a883c1c09f68a6c37f39c779d86d0466ed3a))
* **server:** error loudly when operations.listAvailable gets a hidden or unknown connection_id ([#1982](https://github.com/lobu-ai/lobu/issues/1982)) ([dc224ed](https://github.com/lobu-ai/lobu/commit/dc224eddcec859ff91582f46d1aa710649e3739f))
* **server:** multi-chrome resolveOnlineChromeConnection pin selection ([#1995](https://github.com/lobu-ai/lobu/issues/1995)) ([77226d3](https://github.com/lobu-ai/lobu/commit/77226d3248073ef4b4e3e34cab517c6a918f9b45))
* **server:** one connection-visibility predicate across list and operations ([#1981](https://github.com/lobu-ai/lobu/issues/1981)) ([74485af](https://github.com/lobu-ai/lobu/commit/74485af64374ffc41be0149acf4afe190d30fdc2))
* **server:** restore lobu request logging ([#1841](https://github.com/lobu-ai/lobu/issues/1841)) ([e047d06](https://github.com/lobu-ai/lobu/commit/e047d060afd101cb49d63a707c1e9ce6fca4ac34))
* **server:** unblock Docker tsc for manage_watchers write-gate ([#1908](https://github.com/lobu-ai/lobu/issues/1908)) ([290ed30](https://github.com/lobu-ai/lobu/commit/290ed30f16c64d77ce177a399433eeb8d951af8c))
* **server:** validate feed config against connector configSchema on create/update ([#1983](https://github.com/lobu-ai/lobu/issues/1983)) ([543ded9](https://github.com/lobu-ai/lobu/commit/543ded9980d33e43df25b51ec4f73f245954a133))
* **slack:** atomically claim pending installs ([#1831](https://github.com/lobu-ai/lobu/issues/1831)) ([6a1c41a](https://github.com/lobu-ai/lobu/commit/6a1c41ac15ce878d62452817e5e4d5e4c13eaeec))
* **slack:** binding team_id is always the workspace team (T…), never the Grid enterprise id ([#1850](https://github.com/lobu-ai/lobu/issues/1850)) ([919fb13](https://github.com/lobu-ai/lobu/commit/919fb13be099b7acee813f9e743bbed28b183364))
* **slack:** key channel-about edges on the real workspace team (T…), never the Grid enterprise id (E…) ([#1852](https://github.com/lobu-ai/lobu/issues/1852)) ([dcc26a8](https://github.com/lobu-ai/lobu/commit/dcc26a8ca87f81a27ccf3d4db3ff039484c08862))
* **slack:** org-wide Grid install (oauth.v2.access no team id) + sibling pending routing ([#1816](https://github.com/lobu-ai/lobu/issues/1816)) ([3ef4876](https://github.com/lobu-ai/lobu/commit/3ef487638ed59ff5f7c4d0e3fdb708ad917047b9))
* **slack:** preserve org install on workspace uninstall ([#1829](https://github.com/lobu-ai/lobu/issues/1829)) ([89d1e41](https://github.com/lobu-ai/lobu/commit/89d1e41fd748bee3b53920f9f3357d82d61da60c))
* **slack:** recognize linked identity during claim ([#1840](https://github.com/lobu-ai/lobu/issues/1840)) ([7510802](https://github.com/lobu-ai/lobu/commit/75108021383be1698bf2e82f65861404cab2fc58))
* **slack:** request MCP install scope ([#1917](https://github.com/lobu-ai/lobu/issues/1917)) ([99b3e32](https://github.com/lobu-ai/lobu/commit/99b3e32ffcce2e8e3bdab0769704a8562775aea5))
* **slack:** stop the install on an app_uninstalled/app_deleted event ([#1819](https://github.com/lobu-ai/lobu/issues/1819)) ([9ca30a8](https://github.com/lobu-ai/lobu/commit/9ca30a81460ad13e90db7003ee031d49692bcca5))
* **slack:** typed cross-org claim fence (stop over-matching Grid enterprise siblings) ([#1849](https://github.com/lobu-ai/lobu/issues/1849)) ([8fc1704](https://github.com/lobu-ai/lobu/commit/8fc1704032fb85788b0a79470a6ebc3554e41233))
* support atomic watcher template reactions ([#2001](https://github.com/lobu-ai/lobu/issues/2001)) ([c683be5](https://github.com/lobu-ai/lobu/commit/c683be5f52d141eb7578692fa8557759e67c84bb))
* **watcher-review:** single-source the update write-normalization (displayed == applied) ([#1928](https://github.com/lobu-ai/lobu/issues/1928)) ([d78f23d](https://github.com/lobu-ai/lobu/commit/d78f23dedad2439fd7ebd4aef4033055a4cf24a7))
* **watchers:** analyze source-only payloads ([#2003](https://github.com/lobu-ai/lobu/issues/2003)) ([e49f2af](https://github.com/lobu-ai/lobu/commit/e49f2af0985ae7d9cca63c8c47aca5ea8adcaf8f))
* **watchers:** close create_from_version id/slug race + make the fan-out atomic ([#1969](https://github.com/lobu-ai/lobu/issues/1969)) ([8e07313](https://github.com/lobu-ai/lobu/commit/8e0731360bb164d85a89d2d0900e2897e7bb5dd9))
* **worker:** route built-in curl/wget through the gateway egress proxy ([#1970](https://github.com/lobu-ai/lobu/issues/1970)) ([ed3415a](https://github.com/lobu-ai/lobu/commit/ed3415aba084f805e5adebeb4a85be77b8f7097a))

## [14.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v13.4.1...lobu-v14.0.0) (2026-07-08)


### ⚠ BREAKING CHANGES

* **watchers:** drop watcher_windows + retire the wwff feedback-id sequence (canvas-on-events Phase 3b) ([#1703](https://github.com/lobu-ai/lobu/issues/1703))
* **watchers:** retire legacy watcher_windows write path (canvas-on-events Phase 3a) ([#1699](https://github.com/lobu-ai/lobu/issues/1699))
* **classifiers:** collapse classifier version model — classify_facet is the sole config table (P4) ([#1483](https://github.com/lobu-ai/lobu/issues/1483))
* **slack:** drop bespoke Slack install table/store — fully on app_installations (contract) ([#1471](https://github.com/lobu-ai/lobu/issues/1471))
* **connectors:** remove cookie-cloning; move Revolut to extension ([#1258](https://github.com/lobu-ai/lobu/issues/1258))

### Features

* add Mac computer-use connector actions ([#1743](https://github.com/lobu-ai/lobu/issues/1743)) ([8924b16](https://github.com/lobu-ai/lobu/commit/8924b166b0298d62a25179ba775bb204c20bd794))
* agent UX consolidation + cross-platform conversations (server + owletto) ([#1595](https://github.com/lobu-ai/lobu/issues/1595)) ([3704c1e](https://github.com/lobu-ai/lobu/commit/3704c1e69ce6f1e316a23f5fbad2a5fdb71ab7eb))
* **agents:** backend-persisted agent thread list API ([#1524](https://github.com/lobu-ai/lobu/issues/1524)) ([b2ef525](https://github.com/lobu-ai/lobu/commit/b2ef525a70159e246bc20816243624283fa21106))
* **agents:** builder agent — manage the workspace from chat ([#1409](https://github.com/lobu-ai/lobu/issues/1409)) ([8bf373d](https://github.com/lobu-ai/lobu/commit/8bf373d98fcef5528d1a16ffa2a296e2f5c7e4dc))
* **api:** pending-approvals endpoint + interactive approval cards (owletto pointer bump) ([#1486](https://github.com/lobu-ai/lobu/issues/1486)) ([3d36dd2](https://github.com/lobu-ai/lobu/commit/3d36dd27a69b365d6cd82a3c69dca7753213b673))
* **auth:** stamp slack_user_id on Slack sign-in so ACL collapses onto $member ([#1646](https://github.com/lobu-ai/lobu/issues/1646)) ([edfb379](https://github.com/lobu-ai/lobu/commit/edfb379b3d20668cd578fb1ec03aa867fe6710db))
* **authz:** channel audience read + Reach endpoint; fix Slack read-method encoding ([#1600](https://github.com/lobu-ai/lobu/issues/1600)) ([604b33f](https://github.com/lobu-ai/lobu/commit/604b33fe4bc71a8af4d04c596a65dfc31f00435e))
* **authz:** generic access-graph engine + GitHub repo source + in-Slack requester resolution ([#1590](https://github.com/lobu-ai/lobu/issues/1590)) ([0c4cec5](https://github.com/lobu-ai/lobu/commit/0c4cec56c3be920525f9ee0604e260a8da6995b3))
* **behaviors:** server support for unified Behaviors surface ([#1673](https://github.com/lobu-ai/lobu/issues/1673)) ([87ad42f](https://github.com/lobu-ai/lobu/commit/87ad42f76b64b3230f88a1c5169bb96105585f57))
* **catalog:** add watchers as a global catalog kind with bundled templates ([#1535](https://github.com/lobu-ai/lobu/issues/1535)) ([c798452](https://github.com/lobu-ai/lobu/commit/c79845216cac703cd80b8f509af06ba9e0edffbd))
* **catalog:** consolidate build pipeline and server-side merge ([#1521](https://github.com/lobu-ai/lobu/issues/1521)) ([b5ae4cc](https://github.com/lobu-ai/lobu/commit/b5ae4cc404298e2ad292ef976ee82e2778660867))
* **catalog:** unify catalog discovery under LOBU_CATALOG_URIS ([#1518](https://github.com/lobu-ai/lobu/issues/1518)) ([d519ff9](https://github.com/lobu-ai/lobu/commit/d519ff9ae957ad645c7401d83e1c8e51df0fb3ba))
* **chat:** per-channel about links for business entity context ([#1767](https://github.com/lobu-ai/lobu/issues/1767)) ([55c0f03](https://github.com/lobu-ai/lobu/commit/55c0f035f4818b2a122b413c4641132b17a1e833))
* **chat:** WS-A keystone — Slack senders attributed + managed installs recallable ([#1648](https://github.com/lobu-ai/lobu/issues/1648)) ([120bc08](https://github.com/lobu-ai/lobu/commit/120bc085e683300234601e1b7e3a87699edc527b))
* **chrome:** reduce orphan tab lifetime via run-scoped ownership ([#1649](https://github.com/lobu-ai/lobu/issues/1649)) ([9fdfa41](https://github.com/lobu-ai/lobu/commit/9fdfa413ff8bbbb96d91841f15e2cb95c9a66a0c))
* **classifiers:** collapse classifier version model — classify_facet is the sole config table (P4) ([#1483](https://github.com/lobu-ai/lobu/issues/1483)) ([e77d2b0](https://github.com/lobu-ai/lobu/commit/e77d2b08ad7edfa1746aae5fcc30e221d052e9ac))
* **cli:** hosted Lobu bot via tokenless slack/telegram platform entry ([#1387](https://github.com/lobu-ai/lobu/issues/1387)) ([d8476e7](https://github.com/lobu-ai/lobu/commit/d8476e77ef253e6d6b3d6596968d93f09f2244d3))
* **cli:** whoami --json + Mac CLI auth delegation ([#263](https://github.com/lobu-ai/lobu/issues/263)) ([#1531](https://github.com/lobu-ai/lobu/issues/1531)) ([14d963f](https://github.com/lobu-ai/lobu/commit/14d963f59f585b121a5b1f226f5cb85941ddb725))
* **connections:** consolidate chat channels into connections ([#1714](https://github.com/lobu-ai/lobu/issues/1714)) ([d9cd0d1](https://github.com/lobu-ai/lobu/commit/d9cd0d1510c10c97684a06a760c9f29d825c2af9))
* **connections:** facets + list_reach + managed revoke (Stage 2b backend) ([#1608](https://github.com/lobu-ai/lobu/issues/1608)) ([49ae445](https://github.com/lobu-ai/lobu/commit/49ae4454536fefaa740d0727625ef5fd765baf7a))
* **connections:** move feeds into a left rail like the memory page ([#1534](https://github.com/lobu-ai/lobu/issues/1534)) ([e7fc795](https://github.com/lobu-ai/lobu/commit/e7fc795288a5530684da60bee29066f5fbdc5962))
* **connections:** single-table cutover — drop agent_connections ([#1623](https://github.com/lobu-ai/lobu/issues/1623)) ([d76de19](https://github.com/lobu-ai/lobu/commit/d76de19f9b07a4e9786cf0237c031fa1befc1dfd))
* **connections:** unify model — Stage 1 expand/backfill (additive, no cutover) ([#1604](https://github.com/lobu-ai/lobu/issues/1604)) ([24b03d8](https://github.com/lobu-ai/lobu/commit/24b03d82c7b20ca526dfa7fabeb584ccf4d3b5b9))
* **connector-sdk:** app_installation auth method + installation context + webhook delivery mode ([#1428](https://github.com/lobu-ai/lobu/issues/1428)) ([2b8e0cc](https://github.com/lobu-ai/lobu/commit/2b8e0cc1101232a525b0bffab5a013bceb56826f))
* **connectors+gateway:** GitHub App install flow + device_worker_id serverless fix + tenancy audit ([#1435](https://github.com/lobu-ai/lobu/issues/1435)) ([39ddd77](https://github.com/lobu-ai/lobu/commit/39ddd77f9bae91011b904538e1153d48d97773c4))
* **connectors:** add Sign in with Slack login provider ([#1562](https://github.com/lobu-ai/lobu/issues/1562)) ([627fe3b](https://github.com/lobu-ai/lobu/commit/627fe3b9a48b027fb67f3d69f8e9240f16e784b5))
* **connectors:** alert when a connector silently dies ([#1312](https://github.com/lobu-ai/lobu/issues/1312)) ([32eadce](https://github.com/lobu-ai/lobu/commit/32eadce94affe271f6bdbe83e2ad1751b746726e))
* **connectors:** connector actions can drive the Owletto extension; dynamic Deliveroo search/menu ([#1309](https://github.com/lobu-ai/lobu/issues/1309)) ([09175de](https://github.com/lobu-ai/lobu/commit/09175deb9b4414c5d8ea6da3c8803fe67f9f27e2))
* **connectors:** Gmail virtual feeds, YouTube personal sync + actions ([#1753](https://github.com/lobu-ai/lobu/issues/1753)) ([f29fc1a](https://github.com/lobu-ai/lobu/commit/f29fc1aa67b6c019db817c43fbc466c26c7727dd))
* **connectors:** harden install_connector source_url fetch (SSRF + allowlist) ([#1382](https://github.com/lobu-ai/lobu/issues/1382)) ([02cc93f](https://github.com/lobu-ai/lobu/commit/02cc93fdd6ed4da9473d7f295f88c82e3caa5f81))
* **connectors:** inbound webhook ingestion (extract-load) + GitHub self-service registration ([#1408](https://github.com/lobu-ai/lobu/issues/1408)) ([c0e647d](https://github.com/lobu-ai/lobu/commit/c0e647dea436c053381b5b33bd5b1eb03c2fe5dd))
* **connectors:** Mac+Chrome device connectors (watch v2, EventKit, system-audio) + owletto pointer ([#1487](https://github.com/lobu-ai/lobu/issues/1487)) ([31af160](https://github.com/lobu-ai/lobu/commit/31af160a455750ea20fb48e09ef2fa559efc9a3a))
* **connectors:** migrate X connector to Owletto extension + home-timeline feed ([#1611](https://github.com/lobu-ai/lobu/issues/1611)) ([dd009e8](https://github.com/lobu-ai/lobu/commit/dd009e807e34684e2ddcc0704539b0bdd34fd0b7))
* **connectors:** notify when Revolut needs browser sign-in ([553f1c3](https://github.com/lobu-ai/lobu/commit/553f1c3ed95e4c4be92b13ad5cf0afb5cb42aadd))
* **connectors:** refresh built-in connector defs across deploys + populate github webhook title/url ([#1467](https://github.com/lobu-ai/lobu/issues/1467)) ([ecba5d9](https://github.com/lobu-ai/lobu/commit/ecba5d96d69d7743ff1ef31aea970ae5a1124eab))
* **connectors:** self-service webhook ingestion + GitHub OAuth env creds ([#1418](https://github.com/lobu-ai/lobu/issues/1418)) ([693e3f8](https://github.com/lobu-ai/lobu/commit/693e3f8c5e6e54faebd0a8a1b0a883de72c5db5b))
* **connectors:** unbundle personal and brand-intel connectors from default catalog ([#1692](https://github.com/lobu-ai/lobu/issues/1692)) ([86e2651](https://github.com/lobu-ai/lobu/commit/86e26515ef2e22851b25ccabb29ed03b36317551))
* **connectors:** X my_tweets, liked_tweets, and bookmarks feeds ([#1752](https://github.com/lobu-ai/lobu/issues/1752)) ([8ffec18](https://github.com/lobu-ai/lobu/commit/8ffec184526db78d084b7df6712c8a59c242bd32))
* **contacts:** signal-gate person autoCreate + seed metric aliases on create ([#1630](https://github.com/lobu-ai/lobu/issues/1630)) ([8f989c3](https://github.com/lobu-ai/lobu/commit/8f989c3055cfe2593f1be11d77bf63f7b4450f3a))
* **corrections:** retire watcher_window_field_feedback onto correction events (P1, collapsed) ([#1512](https://github.com/lobu-ai/lobu/issues/1512)) ([5cee99e](https://github.com/lobu-ai/lobu/commit/5cee99e51b882892eea1ed83eed64bf50c1ff94b))
* **db:** app_installations table + store (reject/transfer install ownership) ([#1429](https://github.com/lobu-ai/lobu/issues/1429)) ([318066e](https://github.com/lobu-ai/lobu/commit/318066e12be397ab1bc6944d0952622f5ba550dc))
* **deployments:** config audit trail, deployments API, lobu apply threading ([#1736](https://github.com/lobu-ai/lobu/issues/1736)) ([f6a560a](https://github.com/lobu-ai/lobu/commit/f6a560ac3e4c6c84ce3c438ba5d319134d400037))
* **dev:** default `make dev` to shared brew Postgres@18, embedded opt-in ([#1496](https://github.com/lobu-ai/lobu/issues/1496)) ([a2ecfee](https://github.com/lobu-ai/lobu/commit/a2ecfeed88edba0545d1e595475fb80f25d5ec4d))
* **dev:** Herdr task workspaces and dev app URL ([#1742](https://github.com/lobu-ai/lobu/issues/1742)) ([abc60bf](https://github.com/lobu-ai/lobu/commit/abc60bf0123abc3f37a3beef83d5ca63efaaba3f))
* **device:** force personal-org binding for device clients ([#1728](https://github.com/lobu-ai/lobu/issues/1728)) ([c79974e](https://github.com/lobu-ai/lobu/commit/c79974e60dc645cdf54ce3e26c2f63e5fcd4ae8d))
* **dev:** make owletto-mac / owletto-mac-e2e build tooling ([#1798](https://github.com/lobu-ai/lobu/issues/1798)) ([9cfea0f](https://github.com/lobu-ai/lobu/commit/9cfea0fa2c5a8c6f347e2cc59ebd63763f33d291))
* **dev:** parallel local instances + DB-per-branch on local Postgres ([#1436](https://github.com/lobu-ai/lobu/issues/1436)) ([15921fc](https://github.com/lobu-ai/lobu/commit/15921fc42b4d034aca1bceb255b08b33e524a103))
* **entities:** entity merge — fold duplicates without rewriting events ([#1788](https://github.com/lobu-ai/lobu/issues/1788)) ([760f922](https://github.com/lobu-ai/lobu/commit/760f922eda42a20ead41fab3f2fe5da1f2a87c23))
* **entities:** event-sourced entity field projection (P5, collapsed) ([#1508](https://github.com/lobu-ai/lobu/issues/1508)) ([2e026e4](https://github.com/lobu-ai/lobu/commit/2e026e49681ccbc03a3d937484978552580899ff))
* **entities:** post the entity_field_change approval card end-to-end ([#1708](https://github.com/lobu-ai/lobu/issues/1708)) ([d669a6a](https://github.com/lobu-ai/lobu/commit/d669a6a56c98d6ced0d8c62682fb9a8ad471c3f0))
* **entities:** return authored type-level view templates from schema get ([#1744](https://github.com/lobu-ai/lobu/issues/1744)) ([ca298c1](https://github.com/lobu-ai/lobu/commit/ca298c1c82bb2b245890a3950a6c3aa1ded86837))
* **entities:** unify the edit event shape — one model for entity + watcher corrections ([#1515](https://github.com/lobu-ai/lobu/issues/1515)) ([01930fe](https://github.com/lobu-ai/lobu/commit/01930fe58d911943b33f2144466f641ce7e1277a))
* **examples:** add personal-agent example; move Revolut out of built-in connectors ([#1168](https://github.com/lobu-ai/lobu/issues/1168)) ([2c98d2b](https://github.com/lobu-ai/lobu/commit/2c98d2b9d6252ba594e662019e628a491f4040aa))
* **examples:** derive subscription and trip views in personal-agent ([#1242](https://github.com/lobu-ai/lobu/issues/1242)) ([8b38cca](https://github.com/lobu-ai/lobu/commit/8b38cca1f8b342ca3ef055420c93e42cee2b0fc2))
* **feeds+connections:** channels as streaming feeds + fold channel API into manage_connections ([#1651](https://github.com/lobu-ai/lobu/issues/1651)) ([010d1f3](https://github.com/lobu-ai/lobu/commit/010d1f386e2792413184f11cd631a4af7e79dc00))
* **feeds:** surface virtual feeds in search_memory recall + query_sql ([#1707](https://github.com/lobu-ai/lobu/issues/1707)) ([053bb2d](https://github.com/lobu-ai/lobu/commit/053bb2dce91912845096cb0eacd12b98976aa81e))
* **feeds:** virtual feed flag (Slice 2) — live-read declarable feeds ([#1581](https://github.com/lobu-ai/lobu/issues/1581)) ([73bd37c](https://github.com/lobu-ai/lobu/commit/73bd37cc8cecc27595a89f2a08b8838c014da46f))
* **gateway:** inbound webhook connections — push-source primitive ([#1235](https://github.com/lobu-ai/lobu/issues/1235)) ([#1237](https://github.com/lobu-ai/lobu/issues/1237)) ([9a6f0d2](https://github.com/lobu-ai/lobu/commit/9a6f0d27b5fb11e85c1a6798b6eba1693a43e0b7))
* **gateway:** InstallationTokenProvider + GitHub installation-token minting ([#1430](https://github.com/lobu-ai/lobu/issues/1430)) ([a383533](https://github.com/lobu-ai/lobu/commit/a383533e0b6052343711ab29f551af6ca1f07f66))
* **gateway:** make GitHub App install self-service + recoverable ([#1468](https://github.com/lobu-ai/lobu/issues/1468)) ([f419822](https://github.com/lobu-ai/lobu/commit/f4198228a293ea58270780a33edfb3e807ffbaa9))
* **gateway:** native conversation tools (list/read/send) for agents ([#1359](https://github.com/lobu-ai/lobu/issues/1359)) ([f85530e](https://github.com/lobu-ai/lobu/commit/f85530e671bab647e7e7c1406c11e78efdfc8ff1))
* **gateway:** provider-agnostic app-install + app-webhook engine ([#1553](https://github.com/lobu-ai/lobu/issues/1553)) ([63e2e83](https://github.com/lobu-ai/lobu/commit/63e2e83a2b55adb041174923790951e3a399ef3d))
* **gateway:** replay durable manage_agents approval cards on reload ([#1669](https://github.com/lobu-ai/lobu/issues/1669)) ([0e0a9e2](https://github.com/lobu-ai/lobu/commit/0e0a9e25fbb8e91a471388f256f36d148d8fe865))
* **gateway:** schema-driven app-webhook verify + register Jira/Linear plugins ([#1491](https://github.com/lobu-ai/lobu/issues/1491)) ([a98cb65](https://github.com/lobu-ai/lobu/commit/a98cb6557bb4c1353ce1c46325e6b651a3c36605))
* **gateway:** shared /app-webhooks/:provider router + GitHub verifier/extractor ([#1431](https://github.com/lobu-ai/lobu/issues/1431)) ([129d6ed](https://github.com/lobu-ai/lobu/commit/129d6ed4b2a7661f035c60205f6b57bd9eaa836a))
* **github:** add commits feed — attribute who committed when ([#1513](https://github.com/lobu-ai/lobu/issues/1513)) ([8fb57d1](https://github.com/lobu-ai/lobu/commit/8fb57d1672610ab202bae104b55ab6a16d5f178d))
* **github:** attribute member identity from connector ingest ([#1492](https://github.com/lobu-ai/lobu/issues/1492)) ([e69b19a](https://github.com/lobu-ai/lobu/commit/e69b19a851ccfaa62a760378deaa53061f94db84))
* **github:** build org-membership team graph on App install ([#1494](https://github.com/lobu-ai/lobu/issues/1494)) ([0aa65c7](https://github.com/lobu-ai/lobu/commit/0aa65c7bfc7ed5f5391c0afff98bd6c0bac49613))
* **github:** poll-canonical webhook triggers + direct-store for stars ([#1540](https://github.com/lobu-ai/lobu/issues/1540)) ([b84f9cd](https://github.com/lobu-ai/lobu/commit/b84f9cd2be50dd9cdbb65fda63cfe4e5160c7e14))
* **gmail:** virtual-feed pushdown + create/read surface ([#1702](https://github.com/lobu-ai/lobu/issues/1702)) ([1693e48](https://github.com/lobu-ai/lobu/commit/1693e481a6b8c3c10a2246d5ac075c6a6c7d3aa7))
* **guardrails:** custom inline-judge guardrails, trips API, env-only judge model ([#1565](https://github.com/lobu-ai/lobu/issues/1565)) ([fbccae9](https://github.com/lobu-ai/lobu/commit/fbccae975f1dc92ede9675c12a80338170349d0d))
* **identity:** derive email_domain facts and seed works_at inference ([#1782](https://github.com/lobu-ai/lobu/issues/1782)) ([713c2a5](https://github.com/lobu-ai/lobu/commit/713c2a5b4d3df9689101984e475eee78df89b903))
* **inference:** bundled provider catalog on the inference-providers page ([#1710](https://github.com/lobu-ai/lobu/issues/1710)) ([e3a84c6](https://github.com/lobu-ai/lobu/commit/e3a84c667d7032d640b0abc6724ee32157040add))
* **inference:** org-level LLM-provider OAuth, full consolidation ([#1715](https://github.com/lobu-ai/lobu/issues/1715)) ([e940d83](https://github.com/lobu-ai/lobu/commit/e940d837fcf7e5e1700b823ae6daced7bb2a3f1a))
* **inference:** org-owned inference providers with custom base URLs ([#1701](https://github.com/lobu-ai/lobu/issues/1701)) ([b356bf1](https://github.com/lobu-ai/lobu/commit/b356bf19c0869d0009c5cd65d7289a3e22e03b10))
* **instagram:** IG-internal identity dedup for the takeout connections feed ([#1812](https://github.com/lobu-ai/lobu/issues/1812)) ([be9808d](https://github.com/lobu-ai/lobu/commit/be9808d8147c888dbb32150011b7b71fef3e7bbf))
* **landing:** add the agent-loop-is-the-new-saas blog post ([292e625](https://github.com/lobu-ai/lobu/commit/292e6257f24b9236251e09d0f224bac3fd0d1720))
* **landing:** explanatory OG image — Watch → Understand → Act ([#1406](https://github.com/lobu-ai/lobu/issues/1406)) ([ea548db](https://github.com/lobu-ai/lobu/commit/ea548db79e6a7f52eab628c262069d656a0bf49d))
* **landing:** new Watch→Understand→Act loop OG image ([#1412](https://github.com/lobu-ai/lobu/issues/1412)) ([ee8c4a1](https://github.com/lobu-ai/lobu/commit/ee8c4a1c775bc776b3f6671405a330578c91ad5c))
* **landing:** rebuild operating-loop as a centered numbered timeline ([#1360](https://github.com/lobu-ai/lobu/issues/1360)) ([24cfeea](https://github.com/lobu-ai/lobu/commit/24cfeea1056a37ef7c32d04e18e0564c6db8b55f))
* **landing:** reposition hero subline + meta to open-source infra framing ([#1403](https://github.com/lobu-ai/lobu/issues/1403)) ([c1f538a](https://github.com/lobu-ai/lobu/commit/c1f538aab73a534756ec590ff59fd19a29245973))
* **landing:** simplify agent positioning ([#1260](https://github.com/lobu-ai/lobu/issues/1260)) ([8bf8dcd](https://github.com/lobu-ai/lobu/commit/8bf8dcd7ba49ba49cc02d566aa0cbbb5e38d1a29))
* **landing:** unify the operating-loop section across homepage and /for pages ([#1357](https://github.com/lobu-ai/lobu/issues/1357)) ([ed22bb0](https://github.com/lobu-ai/lobu/commit/ed22bb0a3c4d11b53be0898f726ee2b1d6314733))
* **linkedin:** emit primary member_id from the live post author ([#1806](https://github.com/lobu-ai/lobu/issues/1806)) ([503036e](https://github.com/lobu-ai/lobu/commit/503036e67f420959c02298cac732f21e1045c3ef))
* **linkedin:** identity-graph attributions for the takeout connector ([#1797](https://github.com/lobu-ai/lobu/issues/1797)) ([9646d18](https://github.com/lobu-ai/lobu/commit/9646d18f95a8de3479979f4f229130bd4848dc9a))
* **linkedin:** merge live + takeout into one connector ([#1801](https://github.com/lobu-ai/lobu/issues/1801)) ([d47b149](https://github.com/lobu-ai/lobu/commit/d47b1496f13355e1af2022775b368bd72b382b98))
* **lobu-crm:** enable hosted Slack preview for crm ([#1256](https://github.com/lobu-ai/lobu/issues/1256)) ([05e823e](https://github.com/lobu-ai/lobu/commit/05e823e98f49ca3fbf32bf34f71f29b4c798b3df))
* **mcp-apps:** render every interactive interaction through one MCP App host ([#1674](https://github.com/lobu-ai/lobu/issues/1674)) ([cf0d413](https://github.com/lobu-ai/lobu/commit/cf0d413baf0296b688457e99657241f54d3e63a2))
* **mcp:** make manage_* action surface self-describing on the wire ([#1730](https://github.com/lobu-ai/lobu/issues/1730)) ([c4625a0](https://github.com/lobu-ai/lobu/commit/c4625a05a1334ba7f5243280462f9022048c001c))
* **mcp:** slim tools/list to six agent tools with aligned SDK discovery ([#1733](https://github.com/lobu-ai/lobu/issues/1733)) ([97b3e8c](https://github.com/lobu-ai/lobu/commit/97b3e8c60d563a0831c42991237f95652d3e3137))
* **memory:** filter events by source connections ([#1532](https://github.com/lobu-ai/lobu/issues/1532)) ([6aa0f41](https://github.com/lobu-ai/lobu/commit/6aa0f41a7caab89af7da62bbcab15d0cdde99791))
* **memory:** guide the agent to supersede stored facts on update ([#1170](https://github.com/lobu-ai/lobu/issues/1170)) ([b39c61d](https://github.com/lobu-ai/lobu/commit/b39c61d12a8b32546ae978b3b2abe18b180a7dec))
* **memory:** multi-vector embeddings — contract phase (PK swap + decouple view) ([#1380](https://github.com/lobu-ai/lobu/issues/1380)) ([6c8e7e4](https://github.com/lobu-ai/lobu/commit/6c8e7e4b8a5cd2fb96f17e09575084fd32ca0766))
* **memory:** multi-vector embeddings — expand phase (schema + safe write/read paths) ([#1370](https://github.com/lobu-ai/lobu/issues/1370)) ([2c20144](https://github.com/lobu-ai/lobu/commit/2c201441e36e60d352901f2abd457d0a6744a4f8))
* **metrics:** entity-bound metric layer — contract, persistence, validation, federation hook ([#1262](https://github.com/lobu-ai/lobu/issues/1262)) ([ec26814](https://github.com/lobu-ai/lobu/commit/ec26814c76afe87587d3630fee1ca7794312df8f))
* **metrics:** metric compiler (alias resolver) + runMetric + golden test ([#1267](https://github.com/lobu-ai/lobu/issues/1267)) ([2397436](https://github.com/lobu-ai/lobu/commit/2397436175d48054f9587091c6e47c8ee40a8797))
* **metrics:** query_metric + list_metrics MCP tools (semantic-first routing) ([#1268](https://github.com/lobu-ai/lobu/issues/1268)) ([9a852f4](https://github.com/lobu-ai/lobu/commit/9a852f45742bc12a9911a242a3b159e504f3b15f))
* migrate personal example to buremba org ([#1775](https://github.com/lobu-ai/lobu/issues/1775)) ([242d00c](https://github.com/lobu-ai/lobu/commit/242d00cfcb66a9bb11db562cba6a464fee9c2df0))
* **model:** layered model selection — behavior → agent → org default ([#1723](https://github.com/lobu-ai/lobu/issues/1723)) ([69699f8](https://github.com/lobu-ai/lobu/commit/69699f8b7c5b006c6dffd2e07d719be91c84c318))
* **model:** require an explicit model — stop silently picking a provider default ([#1396](https://github.com/lobu-ai/lobu/issues/1396)) ([c6bb8a2](https://github.com/lobu-ai/lobu/commit/c6bb8a283283c3fe3de483338e6ab023fb0e48b1))
* **nav:** bump owletto to Infrastructure nav + reserve infrastructure segment ([#1718](https://github.com/lobu-ai/lobu/issues/1718)) ([1be0f16](https://github.com/lobu-ai/lobu/commit/1be0f16c01369dce0fda25b50835ac4144d56f94))
* **operations:** permalink chain resolve + run-aware timeline + approval attribution ([#1764](https://github.com/lobu-ai/lobu/issues/1764)) ([fe61961](https://github.com/lobu-ai/lobu/commit/fe61961da0a01b3c8f94934d344f1f92a6e82b24))
* **personal-agent:** signal-based subscriptions/trips + governed GBP spend metrics + goal/learning ([#1640](https://github.com/lobu-ai/lobu/issues/1640)) ([4ccba9b](https://github.com/lobu-ai/lobu/commit/4ccba9b1cdbd73e80074f8adbb2af841de616a6f))
* **personal-agent:** value USD/EUR-pocket spend at the user's realised rate (no more null GBP) ([#1642](https://github.com/lobu-ai/lobu/issues/1642)) ([772bcc4](https://github.com/lobu-ai/lobu/commit/772bcc41bae8fe58a62d948b077e7763c7e80aa6))
* remove agent MCP server settings ([#1614](https://github.com/lobu-ai/lobu/issues/1614)) ([65c3542](https://github.com/lobu-ai/lobu/commit/65c35424a175e441029bb57f6cbfaeadb5102736))
* **revolut:** full multi-account backfill via in-page ?to= replay + rich fields ([#1637](https://github.com/lobu-ai/lobu/issues/1637)) ([a3691bd](https://github.com/lobu-ai/lobu/commit/a3691bd648cec4259d266b30202f0b14d3b5f581))
* **revolut:** real scroll pagination + rich enrichment + wait-for-data poll ([#1632](https://github.com/lobu-ai/lobu/issues/1632)) ([3815a58](https://github.com/lobu-ai/lobu/commit/3815a580a55f5ccc762fc12ba0ee26d411561817))
* **runtime:** generic vault-backed RuntimeProvider + Environments ([#1618](https://github.com/lobu-ai/lobu/issues/1618)) ([4e60691](https://github.com/lobu-ai/lobu/commit/4e60691bea1b079563993760c7c497a83e46b630))
* **scheduled:** deliver wake_agent replies to the originating platform channel ([#1589](https://github.com/lobu-ai/lobu/issues/1589)) ([75abd21](https://github.com/lobu-ai/lobu/commit/75abd21b0771be99183e17d99049b93b1a2c200d))
* **server:** allow file-only messages + harden attachment transcript refs ([#1557](https://github.com/lobu-ai/lobu/issues/1557)) ([6df3575](https://github.com/lobu-ai/lobu/commit/6df35756bbe2498e73b0be376706ea49f7c52cd8))
* **server:** attribute egress guardrail trips to their conversation ([#1601](https://github.com/lobu-ai/lobu/issues/1601)) ([5eb48bd](https://github.com/lobu-ai/lobu/commit/5eb48bd8dc1aa2dd49c7301c6944e6d6ca78c718))
* **server:** authorization/ACL program — Slack channel visibility gate (vertical 1) ([#1586](https://github.com/lobu-ai/lobu/issues/1586)) ([9d4a298](https://github.com/lobu-ai/lobu/commit/9d4a298571e21ea4d330586b360fb05a053fd9cb))
* **server:** Builder confirm/diff gate for manage_agents ([#1485](https://github.com/lobu-ai/lobu/issues/1485)) ([7f2a829](https://github.com/lobu-ai/lobu/commit/7f2a8298121d26f9314aacadba010212fa09a72d))
* **server:** connections are rows, not processes — lazy hydration + exclusive-transport lease ([#1231](https://github.com/lobu-ai/lobu/issues/1231)) ([ac75e71](https://github.com/lobu-ai/lobu/commit/ac75e71af5953955a5ed6918e06f61fcda9d2b3f))
* **server:** drop the 4-field cap on x-table-column metadata fields ([#1386](https://github.com/lobu-ai/lobu/issues/1386)) ([6164657](https://github.com/lobu-ai/lobu/commit/61646574309cb013b4e08d718b07a895d544fcae))
* **server:** filter get_content by analyzed_by_watcher_id ([#1768](https://github.com/lobu-ai/lobu/issues/1768)) ([32192d0](https://github.com/lobu-ai/lobu/commit/32192d034d2012c0618d218a3bb55749825fa508))
* **server:** generic bind confirmation in chat channels ([#1763](https://github.com/lobu-ai/lobu/issues/1763)) ([a0aeaed](https://github.com/lobu-ai/lobu/commit/a0aeaed4bf7742930cb6dfa96ac20596b9b5ed87))
* **server:** home-chat file attachments (artifact ingest + /lobu downloadUrl fix) ([#1551](https://github.com/lobu-ai/lobu/issues/1551)) ([7e1c06c](https://github.com/lobu-ai/lobu/commit/7e1c06cece7c9afc29b435610ecdc35f6e656c07))
* **server:** per-user connection visibility on the SQL scoping seam ([#1574](https://github.com/lobu-ai/lobu/issues/1574)) ([c835e85](https://github.com/lobu-ai/lobu/commit/c835e8569b64b8281fc68f65be2fa1ebb1ceacd7))
* **server:** query_sql virtual-feed coverage hints + manage_feeds read_feeds batch ([#1745](https://github.com/lobu-ai/lobu/issues/1745)) ([eb88408](https://github.com/lobu-ai/lobu/commit/eb88408e1947ff86ac5305c5fa6833608dbc9335))
* **server:** read past channel conversation via search_memory; retire get_channel_history ([#1578](https://github.com/lobu-ai/lobu/issues/1578)) ([b767dca](https://github.com/lobu-ai/lobu/commit/b767dca244b6bcf9204a015e682adc06f777e1f1))
* **server:** replace opt-in rewrite_query param with auto on-miss recall rescue ([#1277](https://github.com/lobu-ai/lobu/issues/1277)) ([1e89c3c](https://github.com/lobu-ai/lobu/commit/1e89c3cc12119156bf96b9983249475412692c58))
* **server:** resolve and list derived entity rows like stored entities ([#1259](https://github.com/lobu-ai/lobu/issues/1259)) ([eed170b](https://github.com/lobu-ai/lobu/commit/eed170bdf76dca6528b96c4fbe535df2b336ebd3))
* **server:** Settings escape hatch on the extension bootstrap error card ([#1572](https://github.com/lobu-ai/lobu/issues/1572)) ([0e27794](https://github.com/lobu-ai/lobu/commit/0e27794ff3f18ca358cd0c74dadec690cf1602a5))
* **server:** shared system-provider resolution and managed platform metadata ([#1525](https://github.com/lobu-ai/lobu/issues/1525)) ([97c1c0a](https://github.com/lobu-ai/lobu/commit/97c1c0a6003cefd06bcb21e4c68c760d7198c147))
* **server:** wire entity_types filter for org-wide read_knowledge ([#1529](https://github.com/lobu-ai/lobu/issues/1529)) ([cd43281](https://github.com/lobu-ai/lobu/commit/cd43281e9db5e841ca1c6455718c629d67b8896c))
* **slack:** actionable unlinked-channel notice (list agents + Behaviors deep-links + CLI) ([#1687](https://github.com/lobu-ai/lobu/issues/1687)) ([bdfab0e](https://github.com/lobu-ai/lobu/commit/bdfab0e8a3291d308fe23107a0df101df6c77bde))
* **slack:** consolidate Slack installs onto app_installations (expand) ([#1470](https://github.com/lobu-ai/lobu/issues/1470)) ([d78e2b2](https://github.com/lobu-ai/lobu/commit/d78e2b2b8bdfa7ddd32fc9cc8f1ef71d1e0eab52))
* **slack:** dashboard deep-link, org counts, and recent activity on App Home ([#1537](https://github.com/lobu-ai/lobu/issues/1537)) ([0ce5616](https://github.com/lobu-ai/lobu/commit/0ce5616d78b7e9c543ad983c73d01da0f3c4a9ed))
* **slack:** drop bespoke Slack install table/store — fully on app_installations (contract) ([#1471](https://github.com/lobu-ai/lobu/issues/1471)) ([63d5704](https://github.com/lobu-ai/lobu/commit/63d5704de8fe4102e6590287264628d1dd8670a1))
* **slack:** expose Lobu MCP server + skill resource to Slackbot ([#1724](https://github.com/lobu-ai/lobu/issues/1724)) ([ac475a8](https://github.com/lobu-ai/lobu/commit/ac475a81435fd07f40ce6be032df96da47b6232c))
* **slack:** generic connector claim engine + builder DM auto-link ([#1779](https://github.com/lobu-ai/lobu/issues/1779)) ([2d0160b](https://github.com/lobu-ai/lobu/commit/2d0160b92f5eaca922452e634e83ec8bd1e14bd7))
* **slack:** marketplace / Slack-initiated install → pending claim flow ([#1663](https://github.com/lobu-ai/lobu/issues/1663)) ([4a01d91](https://github.com/lobu-ai/lobu/commit/4a01d914a1f78638f4d10731818ece853b65bb69))
* **slack:** message tools (react/edit/delete) + channel-entity save stamp ([#1681](https://github.com/lobu-ai/lobu/issues/1681)) ([604f406](https://github.com/lobu-ai/lobu/commit/604f406efbff5d8c0d869cb1bde5da59a53a8a63))
* **slack:** one-click multi-agent workspace installs (slack_installations store) ([#1394](https://github.com/lobu-ai/lobu/issues/1394)) ([26e24f8](https://github.com/lobu-ai/lobu/commit/26e24f8c03cb836bff4f53d05a226766301e8622))
* **slack:** personal notifications + agent setup link on App Home ([#1546](https://github.com/lobu-ai/lobu/issues/1546)) ([3ca71dc](https://github.com/lobu-ai/lobu/commit/3ca71dc07404a4a8c80be87f47e5fd6b13e5f314))
* **slack:** support both per-workspace and org-wide Grid installs + provider-fallback preflight ([#1811](https://github.com/lobu-ai/lobu/issues/1811)) ([a6dc40e](https://github.com/lobu-ai/lobu/commit/a6dc40e0fe58c55e11f097eac24e7c8ef34d43a0))
* **slack:** web-first connected-apps onboarding (server) ([#1568](https://github.com/lobu-ai/lobu/issues/1568)) ([b063c89](https://github.com/lobu-ai/lobu/commit/b063c89f016ea4cb95f24ef82aec7ef78f6e8cf0))
* support Node 22-24 and 26+ via dual isolated-vm builds ([#1378](https://github.com/lobu-ai/lobu/issues/1378)) ([252991e](https://github.com/lobu-ai/lobu/commit/252991e6eab65ef3b0ce67f8b5427eed24d27a42))
* **twitter:** identity attributions for the takeout connector ([#1805](https://github.com/lobu-ai/lobu/issues/1805)) ([fe8642e](https://github.com/lobu-ai/lobu/commit/fe8642e53d572ae67b227507f55c633a961684f4))
* **ui:** sidebar org cleanup and members consolidation ([#1751](https://github.com/lobu-ai/lobu/issues/1751)) ([85b9512](https://github.com/lobu-ai/lobu/commit/85b9512bbb96c343aeee6bed17c5793beb8b0961))
* **watchers:** @-reference sources + create-form picker ([#1655](https://github.com/lobu-ai/lobu/issues/1655)) ([45b2dc3](https://github.com/lobu-ai/lobu/commit/45b2dc37195222d11323956a5a33d5eec112115c))
* **watchers:** backend support for conversational watcher UX ([#1523](https://github.com/lobu-ai/lobu/issues/1523)) ([1e5e868](https://github.com/lobu-ai/lobu/commit/1e5e86805b82761b7d19b3a69347e2aab8310668))
* **watchers:** consolidate render+schema derivation onto entity types; reaction input contracts ([#1533](https://github.com/lobu-ai/lobu/issues/1533)) ([6ace3bf](https://github.com/lobu-ai/lobu/commit/6ace3bfa3a65aba9a74594f8cf15acdbb64da051))
* **watchers:** derive extraction schema from the entity type (schema lives on the type) ([#1514](https://github.com/lobu-ai/lobu/issues/1514)) ([3c6e40f](https://github.com/lobu-ai/lobu/commit/3c6e40f4c4e80377bb3fb99a194020aecdfdd975))
* **watchers:** derive watcher sources from prompt @-mention tokens ([#1731](https://github.com/lobu-ai/lobu/issues/1731)) ([329f64b](https://github.com/lobu-ai/lobu/commit/329f64b0cd70f1eac4ea56188bd6088f3689835c))
* **watchers:** derive window render from the entity type (P3 server) ([#1542](https://github.com/lobu-ai/lobu/issues/1542)) ([5468be9](https://github.com/lobu-ai/lobu/commit/5468be97a4f6b61630e783324c809e8aeb2fa26e))
* **watchers:** drop watcher_windows + retire the wwff feedback-id sequence (canvas-on-events Phase 3b) ([#1703](https://github.com/lobu-ai/lobu/issues/1703)) ([3bb8599](https://github.com/lobu-ai/lobu/commit/3bb8599d41b1b0e4700d02e285173603d6db7505))
* **watchers:** fold watcher windows into canvas_state event chains ([#1695](https://github.com/lobu-ai/lobu/issues/1695)) ([9ee0445](https://github.com/lobu-ai/lobu/commit/9ee04453c36890fb432afc2ed0713ed76d21d3bf))
* **watchers:** per-item recap feedback loop on the entity field-ownership plane ([#1661](https://github.com/lobu-ai/lobu/issues/1661)) ([0bad0d1](https://github.com/lobu-ai/lobu/commit/0bad0d13ab9b4c10d2499d62e349a675b5873e9a))
* **watchers:** promote keyed window rows into entities + observation events (P2 phase 1) ([#1502](https://github.com/lobu-ai/lobu/issues/1502)) ([80f64ad](https://github.com/lobu-ai/lobu/commit/80f64ade832a80ec18f5160d743e56bfc154aeeb))
* **watchers:** retire legacy watcher_windows write path (canvas-on-events Phase 3a) ([#1699](https://github.com/lobu-ai/lobu/issues/1699)) ([153ba24](https://github.com/lobu-ai/lobu/commit/153ba243d24aa108d596b77f119cfcff7a6e5d1a))
* **watchers:** streaming channel feed as a membership-gated [@feed](https://github.com/feed) source ([#1662](https://github.com/lobu-ai/lobu/issues/1662)) ([4565928](https://github.com/lobu-ai/lobu/commit/45659280082f827c1116dd58616b349138985dd3))
* **watchers:** sync extracted fields into entities + human-AI field ownership loop ([#1573](https://github.com/lobu-ai/lobu/issues/1573)) ([0d902a7](https://github.com/lobu-ai/lobu/commit/0d902a73078dfb883d9aa4925d1519903fd9b2b6))
* **web:** consolidate entity detail into entities browser + entity_id filters ([#1569](https://github.com/lobu-ai/lobu/issues/1569)) ([edf0ee1](https://github.com/lobu-ai/lobu/commit/edf0ee10e11375b60641d21af9c6bf80f4cac1c8))


### Bug Fixes

* **agent-worker:** route behavior model providers ([#1738](https://github.com/lobu-ai/lobu/issues/1738)) ([8098ef3](https://github.com/lobu-ai/lobu/commit/8098ef3b1e5c3e855016e9232e56d9679a3ec662))
* **agent:** validate model provider routing ([#1760](https://github.com/lobu-ai/lobu/issues/1760)) ([7dabcb3](https://github.com/lobu-ai/lobu/commit/7dabcb392f141f24a48251efa47cfb7a7dcedd44))
* **anthropic:** resolve auto-mode model from env key + run newest live models ([#1395](https://github.com/lobu-ai/lobu/issues/1395)) ([3584b38](https://github.com/lobu-ai/lobu/commit/3584b38e522ff0737b90d6d39e99064b7a5c7333))
* **apply:** re-apply a local connector whose feed set changed ([#1803](https://github.com/lobu-ai/lobu/issues/1803)) ([0d5d6fd](https://github.com/lobu-ai/lobu/commit/0d5d6fd30eb4b340692439edabb19eb56be27e9f))
* **authz:** graph BYO Slack connections + reconcile stale channel bindings ([#1683](https://github.com/lobu-ai/lobu/issues/1683)) ([cf1f407](https://github.com/lobu-ai/lobu/commit/cf1f407ed8983f578265c2b79e1f7cac6862cafe))
* **authz:** resource events gate fails closed on stale ACL state ([#1668](https://github.com/lobu-ai/lobu/issues/1668)) ([ccbc2bc](https://github.com/lobu-ai/lobu/commit/ccbc2bc5a971d985be6b07105ae79732c1cf121a))
* **authz:** rewire channel-about to connector-owned identity registry (unbreak main) ([#1792](https://github.com/lobu-ai/lobu/issues/1792)) ([0987f4c](https://github.com/lobu-ai/lobu/commit/0987f4c06134dc925749570e4e7c3e0fe36a9b7c))
* **authz:** self-heal teamId on BYO Slack connections via auth.test ([#1686](https://github.com/lobu-ai/lobu/issues/1686)) ([b706630](https://github.com/lobu-ai/lobu/commit/b706630657e92ef51637a0306dde1fdb10e8f662))
* **builder:** reliable builder provisioning — deterministic resolve + self-heal ([#1426](https://github.com/lobu-ai/lobu/issues/1426)) ([49c4f76](https://github.com/lobu-ai/lobu/commit/49c4f7661f642c0419d953e957cc4fbfafdb645d))
* **catalog:** address PR [#1518](https://github.com/lobu-ai/lobu/issues/1518) review findings ([#1519](https://github.com/lobu-ai/lobu/issues/1519)) ([671b8ed](https://github.com/lobu-ai/lobu/commit/671b8ed3c2ed7d008c4142c49180ef0d75eb1739))
* **chart:** bump to 13.4.1 to deploy app pod resource limits ([#1776](https://github.com/lobu-ai/lobu/issues/1776)) ([07cc0bc](https://github.com/lobu-ai/lobu/commit/07cc0bca1612e1543eff8212a712198207d22dc5))
* **chart:** numeric runAsUser/UID so runAsNonRoot validates (prod 11.2.0 rollout wedge) ([#1228](https://github.com/lobu-ai/lobu/issues/1228)) ([da5ace1](https://github.com/lobu-ai/lobu/commit/da5ace1e84f749fdb70104a32a3b18413237c471))
* **ci:** managed-e2e uses read_feed action (same dead get_feed as [#1671](https://github.com/lobu-ai/lobu/issues/1671)) ([#1672](https://github.com/lobu-ai/lobu/issues/1672)) ([466a7cb](https://github.com/lobu-ai/lobu/commit/466a7cb6a9b0997816dcafd8ac77101827f59a44))
* **ci:** sdk-e2e uses read_feed action + security guard matches cross-platform ([#1671](https://github.com/lobu-ai/lobu/issues/1671)) ([d0cd436](https://github.com/lobu-ai/lobu/commit/d0cd4363b59d78716f7e8339d2b373ba40d156b0))
* **cli:** drop scaffolded node_modules in smoke gates so the workspace connector-sdk is under test ([#1223](https://github.com/lobu-ai/lobu/issues/1223)) ([3cc9cc8](https://github.com/lobu-ai/lobu/commit/3cc9cc8f2e4492e4aead9790f51fa24eb4c45b87)), closes [#1222](https://github.com/lobu-ai/lobu/issues/1222)
* **cli:** whoami no longer reports 'Not logged in' on a stale refresh token ([#1795](https://github.com/lobu-ai/lobu/issues/1795)) ([af863a0](https://github.com/lobu-ai/lobu/commit/af863a0a493368fdda62d3a7e688d48eac233eb6))
* **connections:** align connector oauth contracts ([#1758](https://github.com/lobu-ai/lobu/issues/1758)) ([81c59fc](https://github.com/lobu-ai/lobu/commit/81c59fcfafaf63a0d8ef92b98f4344fe2b94110c))
* **connections:** backfill + hard DB guard for personal-credential visibility ([#1712](https://github.com/lobu-ai/lobu/issues/1712)) ([7615b5c](https://github.com/lobu-ai/lobu/commit/7615b5c66e8ff95e1f25a5d42b7d15345a2e78d2))
* **connections:** bounded retry for exclusive-start failures + claim cleanup + save_memory supersede TOCTOU ([#1344](https://github.com/lobu-ai/lobu/issues/1344)) ([7b76c8d](https://github.com/lobu-ai/lobu/commit/7b76c8d1bb2b78be37d3448e01f8e99439a5d314))
* **connections:** default personal-credential connections to private visibility ([#1711](https://github.com/lobu-ai/lobu/issues/1711)) ([e7387fb](https://github.com/lobu-ai/lobu/commit/e7387fb22a5d25a6a40101de7942bbdbb9dc2396))
* **connections:** reject unroutable model before enqueue ([#1762](https://github.com/lobu-ai/lobu/issues/1762)) ([23b4210](https://github.com/lobu-ai/lobu/commit/23b4210a7be430cc9d85ea35bad0eb700d0698b8))
* **connections:** resolve asserted auth-profile slug in app_installation guard ([#1488](https://github.com/lobu-ai/lobu/issues/1488)) ([29f1996](https://github.com/lobu-ai/lobu/commit/29f199668a42929083a11676ec05a50573d4798e))
* **connections:** resolve typecheck errors in [#1714](https://github.com/lobu-ai/lobu/issues/1714) channels consolidation ([#1716](https://github.com/lobu-ai/lobu/issues/1716)) ([4479daf](https://github.com/lobu-ai/lobu/commit/4479dafeac47d0420773f460ea4bda991d6c5e3c))
* **connector-worker:** stream worker_id + NUL-safe takeout checkpoint ([#1800](https://github.com/lobu-ai/lobu/issues/1800)) ([951606b](https://github.com/lobu-ai/lobu/commit/951606b8754acf22344443b263b8249207c084e3))
* connectors are unusable via lobu apply (connection/feed config scope) ([#1367](https://github.com/lobu-ai/lobu/issues/1367)) ([04770f2](https://github.com/lobu-ai/lobu/commit/04770f29f13985752d96edcd52ba450e55d6da17))
* **connectors:** resolve OAuth app client creds from env in the connect path ([#1427](https://github.com/lobu-ai/lobu/issues/1427)) ([8bba0db](https://github.com/lobu-ai/lobu/commit/8bba0dbd2a3e98264c7f400bcda0b7a1cd58ac2c))
* **data-sources:** mask excluded columns + gate admin tables in view-template/watcher queries ([#1329](https://github.com/lobu-ai/lobu/issues/1329)) ([1bf854d](https://github.com/lobu-ai/lobu/commit/1bf854dda761c037fe55a32bdd6ccbffce344054))
* **db:** resolve duplicate migration version 20260622000030 ([#1493](https://github.com/lobu-ai/lobu/issues/1493)) ([b763087](https://github.com/lobu-ai/lobu/commit/b76308730b8687f18d9a9de2b8e82aecee23ff82))
* **db:** resolve duplicate migration version 20260626000000 [dup-version-rename] ([#1588](https://github.com/lobu-ai/lobu/issues/1588)) ([09767c0](https://github.com/lobu-ai/lobu/commit/09767c0fd0ac5aeae84cfd62d31972632e5390bf))
* **db:** retry transient pooler connection drops on the worker-poll claim ([#1353](https://github.com/lobu-ai/lobu/issues/1353)) ([66cc355](https://github.com/lobu-ai/lobu/commit/66cc355f4e09a6117fc85ffa2895ca37827b8e10))
* deliver headless interaction cards (F12), harden secret-proxy throttle, trustworthy knip + dead-code ([#1271](https://github.com/lobu-ai/lobu/issues/1271)) ([7333123](https://github.com/lobu-ai/lobu/commit/7333123d386e2b90940da32e74c76d5d69cccd82))
* **deps:** bump vitest to ^3.2.6 (GHSA arbitrary file read via vitest UI server) ([#1230](https://github.com/lobu-ai/lobu/issues/1230)) ([570ef50](https://github.com/lobu-ai/lobu/commit/570ef50df604b8ccec6a43d070bd8081f257ddac))
* **deps:** force a single sharp ^0.34 via overrides to unbreak the app image build ([#1229](https://github.com/lobu-ai/lobu/issues/1229)) ([4a1521b](https://github.com/lobu-ai/lobu/commit/4a1521b7b4e1cae1cfff04880ef1ed408c638f12)), closes [#1225](https://github.com/lobu-ai/lobu/issues/1225)
* **dev:** drop per-branch dev DB on task-clean + clean-merged sweep ([#1457](https://github.com/lobu-ai/lobu/issues/1457)) ([9b09ed5](https://github.com/lobu-ai/lobu/commit/9b09ed567ea74fd72aa7b48b818d5638fb56e2fa))
* **dev:** make dev-db a walk-in single-user install (LOBU_SINGLE_USER=1) ([#1441](https://github.com/lobu-ai/lobu/issues/1441)) ([89b9cb0](https://github.com/lobu-ai/lobu/commit/89b9cb017c5bddbe9a8b4589b7b24e82325c4ab7))
* **docker:** pin PLAYWRIGHT_BROWSERS_PATH so browser connectors find Chromium ([#1313](https://github.com/lobu-ai/lobu/issues/1313)) ([a0b72a7](https://github.com/lobu-ai/lobu/commit/a0b72a7ef0aa18239be35f955632a5fb67d08523))
* **e2e:** tear down auto-provisioned personal orgs + add prod-host guard ([#1285](https://github.com/lobu-ai/lobu/issues/1285)) ([0a28925](https://github.com/lobu-ai/lobu/commit/0a2892504aba74ed32c5dc46af513d3057a053e2))
* **embeddings:** clamp oversized texts so backfill batches never silently drop ([#1289](https://github.com/lobu-ai/lobu/issues/1289)) ([406d6e5](https://github.com/lobu-ai/lobu/commit/406d6e5acb09b7e1525699adcbda6868510957c0))
* **embeddings:** serialize embed_backfill dispatch to one org per tick ([#1536](https://github.com/lobu-ai/lobu/issues/1536)) ([57652a8](https://github.com/lobu-ai/lobu/commit/57652a8ce7a604f5723716e8dbf393d978c6986e))
* **entities:** enforce field ownership on agent manage_entity writes ([#1705](https://github.com/lobu-ai/lobu/issues/1705)) ([7bd2ec0](https://github.com/lobu-ai/lobu/commit/7bd2ec02aeb40914b089a16c04c0f0804c0d117c))
* **errors:** unified agent-error taxonomy — thin catalog, one classifier, one renderer ([#1789](https://github.com/lobu-ai/lobu/issues/1789)) ([453de47](https://github.com/lobu-ai/lobu/commit/453de47331489594bce7920578b57fccc76bf866))
* **events:** serialize dedup insert per (connection_id, origin_id) to stop duplicate current rows ([#1286](https://github.com/lobu-ai/lobu/issues/1286)) ([c018e18](https://github.com/lobu-ai/lobu/commit/c018e18e5401b6580336b95150fd219fad07d790))
* **feeds:** channel-feed lifecycle fixes + read_feed consolidation ([#1660](https://github.com/lobu-ai/lobu/issues/1660)) ([26659eb](https://github.com/lobu-ai/lobu/commit/26659ebd7ddfcd54637d4a26aba3560445b908d3))
* **feeds:** thread search_term through read_feeds to virtual-feed search() ([#1780](https://github.com/lobu-ai/lobu/issues/1780)) ([7beca72](https://github.com/lobu-ai/lobu/commit/7beca724e97d412577a9323611ae4d32b17fdacb))
* **files:** bind worker upload destination to the verified token, not request headers ([#1330](https://github.com/lobu-ai/lobu/issues/1330)) ([936c239](https://github.com/lobu-ai/lobu/commit/936c239af98d4e443a099547a9442bfa07334e62))
* **gateway:** API status-message cross-pod fan-out + terminal finalText repair ([#1276](https://github.com/lobu-ai/lobu/issues/1276)) ([fddb490](https://github.com/lobu-ai/lobu/commit/fddb490dafa165abbae14201bfd0f7e75c26c4e5))
* **gateway:** close worker-token claim-class bugs + mint regression coverage ([#1282](https://github.com/lobu-ai/lobu/issues/1282)) ([ee28f32](https://github.com/lobu-ai/lobu/commit/ee28f32b38b745dce455742b0a5e7663ca0b0311))
* **gateway:** fan out chat interaction cards cross-pod (multi-replica ask_user) ([#1270](https://github.com/lobu-ai/lobu/issues/1270)) ([559c3ff](https://github.com/lobu-ai/lobu/commit/559c3ffd2cb317effce0abdaffd0520ff1c8db93))
* **gateway:** include connectionId in per-run worker token (ask_user 500 hotfix) ([#1274](https://github.com/lobu-ai/lobu/issues/1274)) ([94485b7](https://github.com/lobu-ai/lobu/commit/94485b7da774d945ad18ca7ae1faa1c419e2bb5b))
* **gateway:** multi-replica SSE delivery — headless owner-gate exemption, LISTEN/NOTIFY fan-out, API interaction-card source fix ([#1236](https://github.com/lobu-ai/lobu/issues/1236)) ([7a2f4ef](https://github.com/lobu-ai/lobu/commit/7a2f4ef119f44f69aae84e61994c146f0cb29d95))
* **gateway:** org-scope the /internal/status debug agent listing ([#1784](https://github.com/lobu-ai/lobu/issues/1784)) ([fd75094](https://github.com/lobu-ai/lobu/commit/fd75094d5e77eeebb2c7f734bb55d3dbbbb57554))
* **gateway:** org-scope the two deferred worker-path getSettings reads ([#1783](https://github.com/lobu-ai/lobu/issues/1783)) ([2ccc6f6](https://github.com/lobu-ai/lobu/commit/2ccc6f6eba528c5aab31d00cc845ecc16845639b))
* **gateway:** provider-driven model defaults + clean SSE status render ([#1390](https://github.com/lobu-ai/lobu/issues/1390)) ([d97acb3](https://github.com/lobu-ai/lobu/commit/d97acb386447eada1a7b9c1d1011ee56501d4655))
* **gateway:** SPA agent runs 403 — authorize by agent's resolved org, not ambient default org ([#1265](https://github.com/lobu-ai/lobu/issues/1265)) ([b6e7631](https://github.com/lobu-ai/lobu/commit/b6e7631f5a1b83c75cc3ad0a96ecf1ba59c65010))
* **gateway:** use deep config compare in agent-config update (stop spurious adapter restarts) ([#1299](https://github.com/lobu-ai/lobu/issues/1299)) ([4b0d0c4](https://github.com/lobu-ai/lobu/commit/4b0d0c476810614e71a29d62defd0c7b0577d668))
* **gateway:** worker poll rejects browser-session auth with 401 so the extension can refresh ([#1402](https://github.com/lobu-ai/lobu/issues/1402)) ([cbafc13](https://github.com/lobu-ai/lobu/commit/cbafc130229cd6e7a6983e7cc509c0e66b8ae74f))
* **guardrails:** enforce output guardrails on the API/SSE path ([#1326](https://github.com/lobu-ai/lobu/issues/1326)) ([d137f51](https://github.com/lobu-ai/lobu/commit/d137f51ee219f3ab51fe440a33953fe32035300e))
* **guardrails:** harden secret-scan coverage + always scan full completion text ([#1332](https://github.com/lobu-ai/lobu/issues/1332)) ([6d8f2b6](https://github.com/lobu-ai/lobu/commit/6d8f2b6f6334ec895c4dc30365399a089cff8cb6))
* harden worker-api auth, rate-limit IP source, and assorted correctness bugs ([#1266](https://github.com/lobu-ai/lobu/issues/1266)) ([fb62ecc](https://github.com/lobu-ai/lobu/commit/fb62ecc32b1cb9503b8100a37d299b3c301f5207))
* **inference-providers:** remove Gemini CLI provider module ([#1769](https://github.com/lobu-ai/lobu/issues/1769)) ([3a02650](https://github.com/lobu-ai/lobu/commit/3a026503e25a2197a407a6b8f939d6826ac177f1))
* **instagram:** recover the real handle from the /_u/ deeplink in following.html ([#1813](https://github.com/lobu-ai/lobu/issues/1813)) ([6082726](https://github.com/lobu-ai/lobu/commit/6082726359c9874f202cccf9ec2dc4297a0093b6))
* **instagram:** reject _u/_n deeplink markers in the username normalizer ([#1814](https://github.com/lobu-ai/lobu/issues/1814)) ([143d269](https://github.com/lobu-ai/lobu/commit/143d269e17d536fc9ccc735b04cd653682a265b8))
* **jira:** migrate sync to /rest/api/3/search/jql ([#1411](https://github.com/lobu-ai/lobu/issues/1411)) ([47d906f](https://github.com/lobu-ai/lobu/commit/47d906f3b50385385da95a476c12bd9d3e058480))
* **landing:** unblock format-lint (remove useless fragment in LandingPage) ([40659c8](https://github.com/lobu-ai/lobu/commit/40659c81f63c1f5322cd1cfe29b15d55f44b5878))
* **linkedin:** drop the unused optional oauth auth method ([#1807](https://github.com/lobu-ai/lobu/issues/1807)) ([c67d88c](https://github.com/lobu-ai/lobu/commit/c67d88cd627beff4fa12444a60aaacaf67b6916f))
* **lobu-crm:** switch crm agent to z-ai/glm-5.2 ([#1254](https://github.com/lobu-ai/lobu/issues/1254)) ([5f8d120](https://github.com/lobu-ai/lobu/commit/5f8d1205e39adaa83020667f499e0a57cf277a2b))
* **mac:** always show context row; opt-in task-setup context registration ([#1509](https://github.com/lobu-ai/lobu/issues/1509)) ([3d8407b](https://github.com/lobu-ai/lobu/commit/3d8407b93a4e5ff5e1066e5562b40bcadef7ffce))
* **mac:** resolve all token/deep-link URLs against the authenticated origin ([#1698](https://github.com/lobu-ai/lobu/issues/1698)) ([5289968](https://github.com/lobu-ai/lobu/commit/5289968221882fcaff23e91c7cd8b6555e126f9a))
* managed OAuth redirects ([#1790](https://github.com/lobu-ai/lobu/issues/1790)) ([793940e](https://github.com/lobu-ai/lobu/commit/793940e2fa13ed7fb39f26a67d114420db14b24f))
* **mcp,egress:** org-scope MCP caches and IDNA-normalize egress matching ([#1346](https://github.com/lobu-ai/lobu/issues/1346)) ([2bd6339](https://github.com/lobu-ai/lobu/commit/2bd6339276b93d5b0e18ad6ec396d31eab206b48))
* **mcp:** add outputSchema, structuredContent, and view-resource metadata ([#1719](https://github.com/lobu-ai/lobu/issues/1719)) ([05f201e](https://github.com/lobu-ai/lobu/commit/05f201e65c3f48f3feee27a993311b8bdbb14667))
* **mcp:** hide server-internal search_memory args from public schema ([#1726](https://github.com/lobu-ai/lobu/issues/1726)) ([238f8da](https://github.com/lobu-ai/lobu/commit/238f8dac58421fa645df672c9e15e6a76e9c9f3a))
* **mcp:** mark destructive admin tools destructiveHint=true ([#1725](https://github.com/lobu-ai/lobu/issues/1725)) ([bb91114](https://github.com/lobu-ai/lobu/commit/bb9111489780bf06a29323db5f3dae54be1c99ca))
* **mcp:** reject batched tools/call that bypasses pre-tool guardrails + approval ([#1328](https://github.com/lobu-ai/lobu/issues/1328)) ([4026e66](https://github.com/lobu-ai/lobu/commit/4026e667556d1980a0c3a9e009cb9b0e55187f90))
* **mcp:** validate structuredContent + fix outputSchema drift ([#1721](https://github.com/lobu-ai/lobu/issues/1721)) ([42bb2a7](https://github.com/lobu-ai/lobu/commit/42bb2a7cfc63a6560285c45f8cd004b07e6987af))
* **migrate:** fail fast when a pending SET NOT NULL has unbacked NULLs ([#1538](https://github.com/lobu-ai/lobu/issues/1538)) ([74c3d20](https://github.com/lobu-ai/lobu/commit/74c3d20de357341a00bfb8db6d10f67a316d11c9))
* **migrations:** collision-guard the 3b straggler re-key ([#1704](https://github.com/lobu-ai/lobu/issues/1704)) ([babc39b](https://github.com/lobu-ai/lobu/commit/babc39bfdd0e7e66fa5029f7ba5c026e80f00828))
* **model:** resolve provider-prefixed models + upgrade pi-ai for adaptive thinking ([#1434](https://github.com/lobu-ai/lobu/issues/1434)) ([06688d2](https://github.com/lobu-ai/lobu/commit/06688d2cf2a25cf2dd7bca09414e0c547641716f))
* **notifications:** deliver proactive notifications to preview-linked channels (cross-org) ([#1331](https://github.com/lobu-ai/lobu/issues/1331)) ([242014e](https://github.com/lobu-ai/lobu/commit/242014e4dcc844bc3ec64781cae6c9b919bc78b7))
* **oauth:** form-encode Claude token exchange to fix login ([#1305](https://github.com/lobu-ai/lobu/issues/1305)) ([64e1c8a](https://github.com/lobu-ai/lobu/commit/64e1c8a235e028a03d4d37ad8ae06f49bb4ee974))
* **oauth:** implement ChatGPT token refresh so device-code login self-heals ([#1317](https://github.com/lobu-ai/lobu/issues/1317)) ([de4d4dd](https://github.com/lobu-ai/lobu/commit/de4d4dd8f3032a08eb78082402a86162a317b0ac))
* **oauth:** match Claude exchange redirect_uri to the authorize step ([#1319](https://github.com/lobu-ai/lobu/issues/1319)) ([0eab2ad](https://github.com/lobu-ai/lobu/commit/0eab2adfb0db0b97fd2add14b5a89ce91f7a9448))
* **oauth:** pass userId when persisting the Claude OAuth profile ([#1321](https://github.com/lobu-ai/lobu/issues/1321)) ([2a9a0c7](https://github.com/lobu-ai/lobu/commit/2a9a0c79479f9880913233e1407fcbb291a2ff5c))
* **office-bot:** flat-allow Deliveroo instead of LLM-judged egress ([#1306](https://github.com/lobu-ai/lobu/issues/1306)) ([8301f6e](https://github.com/lobu-ai/lobu/commit/8301f6eb2694ec92dc80067fd6762497af278bfd))
* **orchestration:** kill the worker process group on teardown and bound the drain ([#1197](https://github.com/lobu-ai/lobu/issues/1197)) ([6193a9e](https://github.com/lobu-ai/lobu/commit/6193a9e2862c2738597a4aa15b7b5cf8a8843e77))
* **orchestrator:** gracefully fall back when nix-shell is absent ([#1297](https://github.com/lobu-ai/lobu/issues/1297)) ([84b6c7e](https://github.com/lobu-ai/lobu/commit/84b6c7e03709e371cdcd24a1e8090783db940eb6))
* **orchestrator:** make the systemd worker sandbox actually work, degrade safely where it can't ([#1407](https://github.com/lobu-ai/lobu/issues/1407)) ([fc2ea0e](https://github.com/lobu-ai/lobu/commit/fc2ea0ef642625dbb67500c51664593e1216ffcb))
* **personal-agent:** align Revolut auth profile with Mac browser session ([#1252](https://github.com/lobu-ai/lobu/issues/1252)) ([dd4d0d9](https://github.com/lobu-ai/lobu/commit/dd4d0d9f09f468255b7442351fe57525c1bda28d))
* pre-release onboarding fixes (initdb locale, auto-apply org, HN sync budget) ([#1369](https://github.com/lobu-ai/lobu/issues/1369)) ([f73f280](https://github.com/lobu-ai/lobu/commit/f73f28060fa7f4f2f28f823003f79d6d2b6c99fb))
* **preview:** working lobu.ai/slack front door for the Slack preview bot ([#1279](https://github.com/lobu-ai/lobu/issues/1279)) ([9e72fe0](https://github.com/lobu-ai/lobu/commit/9e72fe0e59620e5c698815aeaee88955e21afec0))
* prod-readiness pass — 9 bug fixes (6 security) + dedup (net −948 LOC product) ([#1272](https://github.com/lobu-ai/lobu/issues/1272)) ([349e74d](https://github.com/lobu-ai/lobu/commit/349e74d9e4045a5832d465129c38552bd040d62f))
* **providers:** authenticate proxy calls with worker token ([#1773](https://github.com/lobu-ai/lobu/issues/1773)) ([b42c6bd](https://github.com/lobu-ai/lobu/commit/b42c6bd8601554e53e695aca7acf8ea98f266759))
* **providers:** carry org scope in proxy routes ([#1771](https://github.com/lobu-ai/lobu/issues/1771)) ([5b75a94](https://github.com/lobu-ai/lobu/commit/5b75a94ded69ce03f84576bb99fe26b1c604eeab))
* **providers:** scope worker agent settings by org ([#1772](https://github.com/lobu-ai/lobu/issues/1772)) ([9ca074e](https://github.com/lobu-ai/lobu/commit/9ca074e7cfb463cc938586ebbb731e2c06ac8674))
* **provider:** stop the system/builder agent defaulting to an unusable provider ([#1481](https://github.com/lobu-ai/lobu/issues/1481)) ([a711992](https://github.com/lobu-ai/lobu/commit/a71199243d06ad0f8e476bea614a7557422f73fb))
* relabel current Herdr workspace on task-setup; fix task-clean teardown ([#1796](https://github.com/lobu-ai/lobu/issues/1796)) ([46f8a8d](https://github.com/lobu-ai/lobu/commit/46f8a8d7771c09333131c171927310ba5bde28f1))
* remove legacy UI routes and simplify routing ([#1652](https://github.com/lobu-ai/lobu/issues/1652)) ([e2b9748](https://github.com/lobu-ai/lobu/commit/e2b974823c4c9869f6cf7961f97dfd82ff56873e))
* resolve mcp credentials in worker org context ([af7e25d](https://github.com/lobu-ai/lobu/commit/af7e25df1468f46185e18d9135d59dfb29d26d6b))
* **revolut:** intercept retail API instead of scraping DOM (correct amounts) ([#1629](https://github.com/lobu-ai/lobu/issues/1629)) ([ce2c042](https://github.com/lobu-ai/lobu/commit/ce2c0421439137c7c931bcc47d3affcbcc1a0676))
* **revolut:** reliable extension scrape — fresh-window + fail-closed robustness (3.4.0) ([#1269](https://github.com/lobu-ai/lobu/issues/1269)) ([c908ce8](https://github.com/lobu-ai/lobu/commit/c908ce8d57adeef9f56ccee07be2b8fe2a794b6d))
* **runtime:** gateway-authoritative egress allowlist + propagate SSE abort ([#1631](https://github.com/lobu-ai/lobu/issues/1631)) ([1c21479](https://github.com/lobu-ai/lobu/commit/1c214796fb61e8971a085e51d0ac175394cdc9c6))
* **sentry:** default environment to development, not production ([#1354](https://github.com/lobu-ai/lobu/issues/1354)) ([b67dd6b](https://github.com/lobu-ai/lobu/commit/b67dd6b4ae7876bdee66e798c83c841b25d29d6f))
* **server:** accept SSE ?token= ticket at the agent API outer auth gate ([#1342](https://github.com/lobu-ai/lobu/issues/1342)) ([3d29ec1](https://github.com/lobu-ai/lobu/commit/3d29ec17b904bdacd7121e0e2d075ebf951b226b))
* **server:** accept SSE ?token= ticket on the invalidation events route ([#1347](https://github.com/lobu-ai/lobu/issues/1347)) ([616e5f4](https://github.com/lobu-ai/lobu/commit/616e5f4584f43ba86eff4d9af4958f2605285bd1))
* **server:** allow published Chrome Web Store extension ID in CSP + CORS ([#1547](https://github.com/lobu-ai/lobu/issues/1547)) ([f4cb94b](https://github.com/lobu-ai/lobu/commit/f4cb94ba1f8459a77d0676ea507ec55e18227896))
* **server:** annotate createAuth return type to unblock Docker image build ([#1294](https://github.com/lobu-ai/lobu/issues/1294)) ([3b9f4f4](https://github.com/lobu-ai/lobu/commit/3b9f4f4b602ebd2dabb51c7e6a4f6f62f1ee4928))
* **server:** auto-bind the chrome connection to the online extension on dispatch ([#1597](https://github.com/lobu-ai/lobu/issues/1597)) ([2b8119e](https://github.com/lobu-ai/lobu/commit/2b8119e8ded55530ffffcedfe7d3f1191fbd2348))
* **server:** Bearer-auth the embedded extension iframe; drop dead partitioned-cookie path ([#1336](https://github.com/lobu-ai/lobu/issues/1336)) ([4fcd43e](https://github.com/lobu-ai/lobu/commit/4fcd43efbf9caf4c81196fc605b9b5930b9c0e2a))
* **server:** bound embed-backfill discovery scan with statement_timeout ([#1462](https://github.com/lobu-ai/lobu/issues/1462)) ([805d8ae](https://github.com/lobu-ai/lobu/commit/805d8ae6727871bd6b98ede592a907769fe8ea3d))
* **server:** correct prod log level + consolidate nix sanitizer & JSON-body parsing ([#1293](https://github.com/lobu-ai/lobu/issues/1293)) ([629c7c3](https://github.com/lobu-ai/lobu/commit/629c7c30c940f35d1288d0dc45e652542dd3de95))
* **server:** drop dead connector_definitions.api_type column ([#1232](https://github.com/lobu-ai/lobu/issues/1232)) ([8a6600a](https://github.com/lobu-ai/lobu/commit/8a6600ad1d4a546313ed6a27d159e8ff888e8ed1))
* **server:** drop losing-replica worker spawn silently when conversation is owned by another pod ([#1257](https://github.com/lobu-ai/lobu/issues/1257)) ([a643f68](https://github.com/lobu-ai/lobu/commit/a643f688329c202a69b7b772b7eb85f16de5f731))
* **server:** enforce TypeBox arg validation for all tools at one chokepoint ([#1234](https://github.com/lobu-ai/lobu/issues/1234)) ([eee23e0](https://github.com/lobu-ai/lobu/commit/eee23e0e03343f20bdb9197e8d8ab3a48709bab0)), closes [#1137](https://github.com/lobu-ai/lobu/issues/1137)
* **server:** expected entity-schema tool faults throw ToolUserError, not Error ([#1302](https://github.com/lobu-ai/lobu/issues/1302)) ([e904fc4](https://github.com/lobu-ai/lobu/commit/e904fc4423101da9fb231f5b68c7a0aa272b6c2b))
* **server:** guardrail validation, Slack DM binding, non-OIDC OAuth (+owletto cleanup) ([#1579](https://github.com/lobu-ai/lobu/issues/1579)) ([cd47bfb](https://github.com/lobu-ai/lobu/commit/cd47bfbe69246fefff7b4e827d5a90024ca7cad7))
* **server:** hydrate embedded Postgres SONAME symlinks at boot ([#1371](https://github.com/lobu-ai/lobu/issues/1371)) ([#1376](https://github.com/lobu-ai/lobu/issues/1376)) ([c6c4bea](https://github.com/lobu-ai/lobu/commit/c6c4beaaba75ec4850e6ec823328e0d8a520a08d))
* **server:** loopback lobu-memory MCP + consolidate on PUBLIC_GATEWAY_URL ([#1678](https://github.com/lobu-ai/lobu/issues/1678)) ([a5b3b9d](https://github.com/lobu-ai/lobu/commit/a5b3b9d457c13f7a08a706b0c383cda11406425e)), closes [#1584](https://github.com/lobu-ai/lobu/issues/1584)
* **server:** make env-configured Anthropic API keys work (x-api-key + recognition) ([#1393](https://github.com/lobu-ai/lobu/issues/1393)) ([4dbec06](https://github.com/lobu-ai/lobu/commit/4dbec0664404d643c0add073aa680c1cc78c67fe))
* **server:** notify the user to re-login when a connector's site session expires ([#1596](https://github.com/lobu-ai/lobu/issues/1596)) ([b3c6502](https://github.com/lobu-ai/lobu/commit/b3c650268482b434a021b823956897686c9e03bd))
* **server:** read_knowledge 400 on queries with leading whitespace; add query fuzz guard ([#1281](https://github.com/lobu-ai/lobu/issues/1281)) ([232f7cd](https://github.com/lobu-ai/lobu/commit/232f7cd3e1b96da9ab185591a40ba47a9f3e91b8))
* **server:** recognize org inference credentials ([#1740](https://github.com/lobu-ai/lobu/issues/1740)) ([ef7bdfe](https://github.com/lobu-ai/lobu/commit/ef7bdfe14e05aa9a5033a41b8c67c166be41c569))
* **server:** remove dead api_type from query_sql allowlist ([#1226](https://github.com/lobu-ai/lobu/issues/1226)) ([99bde4a](https://github.com/lobu-ai/lobu/commit/99bde4a573450014d3aad84300af62e1bfde57a5))
* **server:** require explicit org selection when pairing a multi-org device ([#1594](https://github.com/lobu-ai/lobu/issues/1594)) ([1b308be](https://github.com/lobu-ai/lobu/commit/1b308be69cd3d7db4ae5c9da8603fe343831388f))
* **server:** resolve proxy network config per-server, not via a lazy global ([#1598](https://github.com/lobu-ai/lobu/issues/1598)) ([2191d23](https://github.com/lobu-ai/lobu/commit/2191d232bacc5c57bc9254a8c6ed18d3cb9b84ad))
* **server:** return 404 for expired/unknown MCP sessions so clients re-initialize ([#1616](https://github.com/lobu-ai/lobu/issues/1616)) ([940388f](https://github.com/lobu-ai/lobu/commit/940388fce7f7e3881b709685219fd00d0449773c))
* **server:** Slack OAuth redirect_uri must carry the /lobu gateway prefix ([#1389](https://github.com/lobu-ai/lobu/issues/1389)) ([feb8d03](https://github.com/lobu-ai/lobu/commit/feb8d03488145353a7c5a1f3537b59c7f2a8e50e))
* **server:** SSE auth ticket for embedded panel + bootstrap retry-on-failure ([#1340](https://github.com/lobu-ai/lobu/issues/1340)) ([6bec163](https://github.com/lobu-ai/lobu/commit/6bec163abe89dd55ac7f3d3504733a583b84532b))
* **server:** stop expected 4xx tool faults from creating Sentry issues ([#1295](https://github.com/lobu-ai/lobu/issues/1295)) ([809edac](https://github.com/lobu-ai/lobu/commit/809edac68ea8d37edb5cd3e2cdd5a53f8916fa08))
* **server:** stop orphaned embedded Postgres after bun:test runs ([#1255](https://github.com/lobu-ai/lobu/issues/1255)) ([adaad78](https://github.com/lobu-ai/lobu/commit/adaad788c9d49ce9a3494d129c94e7abbf93d57d))
* **server:** stop session_replication_role leaking across the test pool ([#1607](https://github.com/lobu-ai/lobu/issues/1607)) ([aae191c](https://github.com/lobu-ai/lobu/commit/aae191c1898cd158cdc65c37b0ea2effa270606c))
* **server:** strip NUL bytes from tool args + MCP tool-surface input fuzz harness ([#1283](https://github.com/lobu-ai/lobu/issues/1283)) ([461e428](https://github.com/lobu-ai/lobu/commit/461e428ac129ddd500daeb95678bceb4c058cbe6))
* **server:** truthful vitest exit codes, fail-closed CI gate, and the 8 red integration tests ([#1220](https://github.com/lobu-ai/lobu/issues/1220)) ([0235681](https://github.com/lobu-ai/lobu/commit/023568100f97d8c9b13fa2bbe3660338d15ded04))
* **server:** unblock app image build — align worker context with WorkerTokenData ([#1243](https://github.com/lobu-ai/lobu/issues/1243)) ([cfc7c17](https://github.com/lobu-ai/lobu/commit/cfc7c17d1d4939eede55aa7ca1a50cb37b50a54d))
* **server:** use catalog inference provider keys ([#1741](https://github.com/lobu-ai/lobu/issues/1741)) ([3c2fa38](https://github.com/lobu-ai/lobu/commit/3c2fa38d6e33bfca0a12c6b880fa4d05d27a4885))
* **server:** wire grant + policy stores into the HTTP egress proxy at boot ([#1599](https://github.com/lobu-ai/lobu/issues/1599)) ([3e2ecd0](https://github.com/lobu-ai/lobu/commit/3e2ecd0991b3884d7f11fccb30475894f3b83cbb))
* **server:** wire Mac computer_use device actions end-to-end ([#1750](https://github.com/lobu-ai/lobu/issues/1750)) ([abc983e](https://github.com/lobu-ai/lobu/commit/abc983e80b96a9b5e29d1d8dc1d0f0a7cb3d29dc))
* **slack:** authorize claim via linked Slack account, not just the identity graph ([#1804](https://github.com/lobu-ai/lobu/issues/1804)) ([167d270](https://github.com/lobu-ai/lobu/commit/167d27083c000d73d0ce4c2e17046a75606e9d41))
* **slack:** bind publishHomeView so the App Home tab publishes ([#1545](https://github.com/lobu-ai/lobu/issues/1545)) ([eabd81e](https://github.com/lobu-ai/lobu/commit/eabd81eae19d18783fef8fed45bc1d017cb4834e))
* **slack:** post model routing fallback as text ([#1765](https://github.com/lobu-ai/lobu/issues/1765)) ([5035411](https://github.com/lobu-ai/lobu/commit/5035411a3c2fd5b472569ae31f50bfaf0fac375b))
* **slack:** render agent links as mrkdwn in channel-link notice + confirm-bind card ([#1713](https://github.com/lobu-ai/lobu/issues/1713)) ([ad91d82](https://github.com/lobu-ai/lobu/commit/ad91d82562df61bbcff7fd1aca6469ef24af594b))
* **slack:** surface App Home publish errors in logs ([#1543](https://github.com/lobu-ai/lobu/issues/1543)) ([afad7e6](https://github.com/lobu-ai/lobu/commit/afad7e6892102b7500947fb9cf662e6fb5fbe4ec))
* **slack:** use setup link in provider routing errors ([#1766](https://github.com/lobu-ai/lobu/issues/1766)) ([d4a7598](https://github.com/lobu-ai/lobu/commit/d4a75982cb5ea6dd327180cd0f770d61d6100115))
* **spotify:** stable origin_id for id-less tracks + day-bucketed top-track snapshots ([#1287](https://github.com/lobu-ai/lobu/issues/1287)) ([205a31a](https://github.com/lobu-ai/lobu/commit/205a31a7fc4deb2b677c299befe8e9b332895722))
* stop duplicate chrome device rows on native re-pair + GC stale devices ([#1635](https://github.com/lobu-ai/lobu/issues/1635)) ([74efd22](https://github.com/lobu-ai/lobu/commit/74efd226b2045963af634b7e4cb76b6387c014c2))
* **task-clean:** never close the current Herdr workspace ([#1799](https://github.com/lobu-ai/lobu/issues/1799)) ([a586e16](https://github.com/lobu-ai/lobu/commit/a586e16ef4ceef93dfeba7b7420788d35d764b38))
* **test:** reap orphaned lobu-test-pg clusters (65G disk leak) ([#1291](https://github.com/lobu-ai/lobu/issues/1291)) ([f52a14a](https://github.com/lobu-ai/lobu/commit/f52a14a9a05cf74f6d9c592a652ffff3de3c1728))
* **test:** retry cleanup TRUNCATE on deadlock with co-running pollers ([#1609](https://github.com/lobu-ai/lobu/issues/1609)) ([a15212c](https://github.com/lobu-ai/lobu/commit/a15212c924887d040de2ee047d7d8d1bd8172930))
* **test:** stop leaking the exclusive-lease poller across integration tests ([#1610](https://github.com/lobu-ai/lobu/issues/1610)) ([22b62bd](https://github.com/lobu-ai/lobu/commit/22b62bd3083eafa09e84a515ae814f379c63e3b6))
* **turn-liveness:** keep active long-running workers alive on every worker signal ([#1343](https://github.com/lobu-ai/lobu/issues/1343)) ([f22145b](https://github.com/lobu-ai/lobu/commit/f22145baa1a23683b73c544a2ca59f0b8ae06bed))
* **ui:** memory page filter rail grid layout ([#1657](https://github.com/lobu-ai/lobu/issues/1657)) ([4f06062](https://github.com/lobu-ai/lobu/commit/4f06062b2039c904ce0fdbd51497f9198b0a8227))
* **watchers:** align device CLI completion with query_sdk/run_sdk ([#1734](https://github.com/lobu-ai/lobu/issues/1734)) ([2a32a22](https://github.com/lobu-ai/lobu/commit/2a32a22d595d9de0d9c7a174828ad4c8981cb808))
* **watchers:** idempotent schedule advance, save_memory occurred_at default, provenance-key metadata round-trip ([#1757](https://github.com/lobu-ai/lobu/issues/1757)) ([2152855](https://github.com/lobu-ai/lobu/commit/215285542e46dedf80296246039b9d9d234fcc40))
* **web:** bump owletto for Lobu favicon assets ([#1749](https://github.com/lobu-ai/lobu/issues/1749)) ([929f9ce](https://github.com/lobu-ai/lobu/commit/929f9ce74cd642ec56d032ac1be0bd4278dc5b24))
* **worker:** don't prepend a ref-context hint to the user prompt ([#1732](https://github.com/lobu-ai/lobu/issues/1732)) ([6e5e189](https://github.com/lobu-ai/lobu/commit/6e5e189f4c83ccc1b114332da22fc0d6503c2d2f))
* **worker:** expose customTools to the model (pi 0.73.x treats options.tools as a hard allowlist) ([#1484](https://github.com/lobu-ai/lobu/issues/1484)) ([cd974c8](https://github.com/lobu-ai/lobu/commit/cd974c85491ba36c4ec1496ca0627ac342ef9b2f))
* **worker:** install patchright Chromium revision the runtime expects ([#1315](https://github.com/lobu-ai/lobu/issues/1315)) ([e58c442](https://github.com/lobu-ai/lobu/commit/e58c4420826869ad8d6b21994697428227ec9cbb))
* **worker:** refresh worker token mid-turn via deployment-liveness gate ([#1280](https://github.com/lobu-ai/lobu/issues/1280)) ([1f41b3f](https://github.com/lobu-ai/lobu/commit/1f41b3f611f1211c2315f66941bee149fdf264c0))


### Performance Improvements

* **ci:** app image cache-to mode=min + dedicated scope (cut ~150s build) ([#1303](https://github.com/lobu-ai/lobu/issues/1303)) ([c44ca45](https://github.com/lobu-ai/lobu/commit/c44ca45d3a986fd3e84dcca6564de99c0fac0f05))
* **ci:** incremental app builds — drop CACHEBUST, cache-to mode=max ([#1307](https://github.com/lobu-ai/lobu/issues/1307)) ([379fb5f](https://github.com/lobu-ai/lobu/commit/379fb5fc1243518e4157389533cc672c24e6f40b))
* cut initial bundle ~75KB gzip, self-host fonts, edge-cache HTML shell ([#1691](https://github.com/lobu-ai/lobu/issues/1691)) ([7740493](https://github.com/lobu-ai/lobu/commit/77404932771176d029321059d1dcdc1abf2c9df3))
* **embed-backfill:** index-driven recent-first scan (prod 1.4s-&gt;4ms) ([#1292](https://github.com/lobu-ai/lobu/issues/1292)) ([0bb7c02](https://github.com/lobu-ai/lobu/commit/0bb7c02f35662be65b502af611f3e4b43f2ea748))
* **events:** denormalize supersession lineage into events.superseded_by ([#1694](https://github.com/lobu-ai/lobu/issues/1694)) ([1d733b9](https://github.com/lobu-ai/lobu/commit/1d733b9e76da69ccac66237448f2df1ec748d1be))
* **events:** flip current_event_records to superseded_by predicate (Stage 2) ([#1697](https://github.com/lobu-ai/lobu/issues/1697)) ([a126ada](https://github.com/lobu-ai/lobu/commit/a126ada733b596ec51194d648e9c384facb3ef5c))


### Reverts

* hide Add to Slack surfacing until the OAuth install is completed ([#1392](https://github.com/lobu-ai/lobu/issues/1392)) ([830cd53](https://github.com/lobu-ai/lobu/commit/830cd53a7de3c402edaf29d74ad408b329a5ab8a))


### Code Refactoring

* **connectors:** remove cookie-cloning; move Revolut to extension ([#1258](https://github.com/lobu-ai/lobu/issues/1258)) ([eeab6fe](https://github.com/lobu-ai/lobu/commit/eeab6fe81467461fc817837273ea23294f5adb9d))

## [13.4.0](https://github.com/lobu-ai/lobu/compare/lobu-v13.3.0...lobu-v13.4.0) (2026-07-02)


### Features

* **behaviors:** server support for unified Behaviors surface ([#1673](https://github.com/lobu-ai/lobu/issues/1673)) ([87ad42f](https://github.com/lobu-ai/lobu/commit/87ad42f76b64b3230f88a1c5169bb96105585f57))
* **chrome:** reduce orphan tab lifetime via run-scoped ownership ([#1649](https://github.com/lobu-ai/lobu/issues/1649)) ([9fdfa41](https://github.com/lobu-ai/lobu/commit/9fdfa413ff8bbbb96d91841f15e2cb95c9a66a0c))
* **connectors:** unbundle personal and brand-intel connectors from default catalog ([#1692](https://github.com/lobu-ai/lobu/issues/1692)) ([86e2651](https://github.com/lobu-ai/lobu/commit/86e26515ef2e22851b25ccabb29ed03b36317551))
* **feeds+connections:** channels as streaming feeds + fold channel API into manage_connections ([#1651](https://github.com/lobu-ai/lobu/issues/1651)) ([010d1f3](https://github.com/lobu-ai/lobu/commit/010d1f386e2792413184f11cd631a4af7e79dc00))
* **gateway:** replay durable manage_agents approval cards on reload ([#1669](https://github.com/lobu-ai/lobu/issues/1669)) ([0e0a9e2](https://github.com/lobu-ai/lobu/commit/0e0a9e25fbb8e91a471388f256f36d148d8fe865))
* **mcp-apps:** render every interactive interaction through one MCP App host ([#1674](https://github.com/lobu-ai/lobu/issues/1674)) ([cf0d413](https://github.com/lobu-ai/lobu/commit/cf0d413baf0296b688457e99657241f54d3e63a2))
* **slack:** actionable unlinked-channel notice (list agents + Behaviors deep-links + CLI) ([#1687](https://github.com/lobu-ai/lobu/issues/1687)) ([bdfab0e](https://github.com/lobu-ai/lobu/commit/bdfab0e8a3291d308fe23107a0df101df6c77bde))
* **slack:** marketplace / Slack-initiated install → pending claim flow ([#1663](https://github.com/lobu-ai/lobu/issues/1663)) ([4a01d91](https://github.com/lobu-ai/lobu/commit/4a01d914a1f78638f4d10731818ece853b65bb69))
* **slack:** message tools (react/edit/delete) + channel-entity save stamp ([#1681](https://github.com/lobu-ai/lobu/issues/1681)) ([604f406](https://github.com/lobu-ai/lobu/commit/604f406efbff5d8c0d869cb1bde5da59a53a8a63))
* **watchers:** @-reference sources + create-form picker ([#1655](https://github.com/lobu-ai/lobu/issues/1655)) ([45b2dc3](https://github.com/lobu-ai/lobu/commit/45b2dc37195222d11323956a5a33d5eec112115c))
* **watchers:** per-item recap feedback loop on the entity field-ownership plane ([#1661](https://github.com/lobu-ai/lobu/issues/1661)) ([0bad0d1](https://github.com/lobu-ai/lobu/commit/0bad0d13ab9b4c10d2499d62e349a675b5873e9a))
* **watchers:** streaming channel feed as a membership-gated [@feed](https://github.com/feed) source ([#1662](https://github.com/lobu-ai/lobu/issues/1662)) ([4565928](https://github.com/lobu-ai/lobu/commit/45659280082f827c1116dd58616b349138985dd3))


### Bug Fixes

* **authz:** graph BYO Slack connections + reconcile stale channel bindings ([#1683](https://github.com/lobu-ai/lobu/issues/1683)) ([cf1f407](https://github.com/lobu-ai/lobu/commit/cf1f407ed8983f578265c2b79e1f7cac6862cafe))
* **authz:** resource events gate fails closed on stale ACL state ([#1668](https://github.com/lobu-ai/lobu/issues/1668)) ([ccbc2bc](https://github.com/lobu-ai/lobu/commit/ccbc2bc5a971d985be6b07105ae79732c1cf121a))
* **authz:** self-heal teamId on BYO Slack connections via auth.test ([#1686](https://github.com/lobu-ai/lobu/issues/1686)) ([b706630](https://github.com/lobu-ai/lobu/commit/b706630657e92ef51637a0306dde1fdb10e8f662))
* **ci:** managed-e2e uses read_feed action (same dead get_feed as [#1671](https://github.com/lobu-ai/lobu/issues/1671)) ([#1672](https://github.com/lobu-ai/lobu/issues/1672)) ([466a7cb](https://github.com/lobu-ai/lobu/commit/466a7cb6a9b0997816dcafd8ac77101827f59a44))
* **ci:** sdk-e2e uses read_feed action + security guard matches cross-platform ([#1671](https://github.com/lobu-ai/lobu/issues/1671)) ([d0cd436](https://github.com/lobu-ai/lobu/commit/d0cd4363b59d78716f7e8339d2b373ba40d156b0))
* **feeds:** channel-feed lifecycle fixes + read_feed consolidation ([#1660](https://github.com/lobu-ai/lobu/issues/1660)) ([26659eb](https://github.com/lobu-ai/lobu/commit/26659ebd7ddfcd54637d4a26aba3560445b908d3))
* remove legacy UI routes and simplify routing ([#1652](https://github.com/lobu-ai/lobu/issues/1652)) ([e2b9748](https://github.com/lobu-ai/lobu/commit/e2b974823c4c9869f6cf7961f97dfd82ff56873e))
* **server:** loopback lobu-memory MCP + consolidate on PUBLIC_GATEWAY_URL ([#1678](https://github.com/lobu-ai/lobu/issues/1678)) ([a5b3b9d](https://github.com/lobu-ai/lobu/commit/a5b3b9d457c13f7a08a706b0c383cda11406425e)), closes [#1584](https://github.com/lobu-ai/lobu/issues/1584)
* **ui:** memory page filter rail grid layout ([#1657](https://github.com/lobu-ai/lobu/issues/1657)) ([4f06062](https://github.com/lobu-ai/lobu/commit/4f06062b2039c904ce0fdbd51497f9198b0a8227))


### Performance Improvements

* cut initial bundle ~75KB gzip, self-host fonts, edge-cache HTML shell ([#1691](https://github.com/lobu-ai/lobu/issues/1691)) ([7740493](https://github.com/lobu-ai/lobu/commit/77404932771176d029321059d1dcdc1abf2c9df3))

## [13.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v13.2.0...lobu-v13.3.0) (2026-06-30)


### Features

* **auth:** stamp slack_user_id on Slack sign-in so ACL collapses onto $member ([#1646](https://github.com/lobu-ai/lobu/issues/1646)) ([edfb379](https://github.com/lobu-ai/lobu/commit/edfb379b3d20668cd578fb1ec03aa867fe6710db))
* **chat:** WS-A keystone — Slack senders attributed + managed installs recallable ([#1648](https://github.com/lobu-ai/lobu/issues/1648)) ([120bc08](https://github.com/lobu-ai/lobu/commit/120bc085e683300234601e1b7e3a87699edc527b))
* **connections:** single-table cutover — drop agent_connections ([#1623](https://github.com/lobu-ai/lobu/issues/1623)) ([d76de19](https://github.com/lobu-ai/lobu/commit/d76de19f9b07a4e9786cf0237c031fa1befc1dfd))
* **connectors:** migrate X connector to Owletto extension + home-timeline feed ([#1611](https://github.com/lobu-ai/lobu/issues/1611)) ([dd009e8](https://github.com/lobu-ai/lobu/commit/dd009e807e34684e2ddcc0704539b0bdd34fd0b7))
* **contacts:** signal-gate person autoCreate + seed metric aliases on create ([#1630](https://github.com/lobu-ai/lobu/issues/1630)) ([8f989c3](https://github.com/lobu-ai/lobu/commit/8f989c3055cfe2593f1be11d77bf63f7b4450f3a))
* **personal-agent:** signal-based subscriptions/trips + governed GBP spend metrics + goal/learning ([#1640](https://github.com/lobu-ai/lobu/issues/1640)) ([4ccba9b](https://github.com/lobu-ai/lobu/commit/4ccba9b1cdbd73e80074f8adbb2af841de616a6f))
* **personal-agent:** value USD/EUR-pocket spend at the user's realised rate (no more null GBP) ([#1642](https://github.com/lobu-ai/lobu/issues/1642)) ([772bcc4](https://github.com/lobu-ai/lobu/commit/772bcc41bae8fe58a62d948b077e7763c7e80aa6))
* **revolut:** full multi-account backfill via in-page ?to= replay + rich fields ([#1637](https://github.com/lobu-ai/lobu/issues/1637)) ([a3691bd](https://github.com/lobu-ai/lobu/commit/a3691bd648cec4259d266b30202f0b14d3b5f581))
* **revolut:** real scroll pagination + rich enrichment + wait-for-data poll ([#1632](https://github.com/lobu-ai/lobu/issues/1632)) ([3815a58](https://github.com/lobu-ai/lobu/commit/3815a580a55f5ccc762fc12ba0ee26d411561817))
* **runtime:** generic vault-backed RuntimeProvider + Environments ([#1618](https://github.com/lobu-ai/lobu/issues/1618)) ([4e60691](https://github.com/lobu-ai/lobu/commit/4e60691bea1b079563993760c7c497a83e46b630))
* **scheduled:** deliver wake_agent replies to the originating platform channel ([#1589](https://github.com/lobu-ai/lobu/issues/1589)) ([75abd21](https://github.com/lobu-ai/lobu/commit/75abd21b0771be99183e17d99049b93b1a2c200d))


### Bug Fixes

* **revolut:** intercept retail API instead of scraping DOM (correct amounts) ([#1629](https://github.com/lobu-ai/lobu/issues/1629)) ([ce2c042](https://github.com/lobu-ai/lobu/commit/ce2c0421439137c7c931bcc47d3affcbcc1a0676))
* **runtime:** gateway-authoritative egress allowlist + propagate SSE abort ([#1631](https://github.com/lobu-ai/lobu/issues/1631)) ([1c21479](https://github.com/lobu-ai/lobu/commit/1c214796fb61e8971a085e51d0ac175394cdc9c6))
* stop duplicate chrome device rows on native re-pair + GC stale devices ([#1635](https://github.com/lobu-ai/lobu/issues/1635)) ([74efd22](https://github.com/lobu-ai/lobu/commit/74efd226b2045963af634b7e4cb76b6387c014c2))

## [13.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v13.1.0...lobu-v13.2.0) (2026-06-29)


### Features

* agent UX consolidation + cross-platform conversations (server + owletto) ([#1595](https://github.com/lobu-ai/lobu/issues/1595)) ([3704c1e](https://github.com/lobu-ai/lobu/commit/3704c1e69ce6f1e316a23f5fbad2a5fdb71ab7eb))
* **authz:** channel audience read + Reach endpoint; fix Slack read-method encoding ([#1600](https://github.com/lobu-ai/lobu/issues/1600)) ([604b33f](https://github.com/lobu-ai/lobu/commit/604b33fe4bc71a8af4d04c596a65dfc31f00435e))
* **authz:** generic access-graph engine + GitHub repo source + in-Slack requester resolution ([#1590](https://github.com/lobu-ai/lobu/issues/1590)) ([0c4cec5](https://github.com/lobu-ai/lobu/commit/0c4cec56c3be920525f9ee0604e260a8da6995b3))
* **catalog:** add watchers as a global catalog kind with bundled templates ([#1535](https://github.com/lobu-ai/lobu/issues/1535)) ([c798452](https://github.com/lobu-ai/lobu/commit/c79845216cac703cd80b8f509af06ba9e0edffbd))
* **connections:** facets + list_reach + managed revoke (Stage 2b backend) ([#1608](https://github.com/lobu-ai/lobu/issues/1608)) ([49ae445](https://github.com/lobu-ai/lobu/commit/49ae4454536fefaa740d0727625ef5fd765baf7a))
* **connections:** unify model — Stage 1 expand/backfill (additive, no cutover) ([#1604](https://github.com/lobu-ai/lobu/issues/1604)) ([24b03d8](https://github.com/lobu-ai/lobu/commit/24b03d82c7b20ca526dfa7fabeb584ccf4d3b5b9))
* **connectors:** add Sign in with Slack login provider ([#1562](https://github.com/lobu-ai/lobu/issues/1562)) ([627fe3b](https://github.com/lobu-ai/lobu/commit/627fe3b9a48b027fb67f3d69f8e9240f16e784b5))
* **connectors:** notify when Revolut needs browser sign-in ([553f1c3](https://github.com/lobu-ai/lobu/commit/553f1c3ed95e4c4be92b13ad5cf0afb5cb42aadd))
* **feeds:** virtual feed flag (Slice 2) — live-read declarable feeds ([#1581](https://github.com/lobu-ai/lobu/issues/1581)) ([73bd37c](https://github.com/lobu-ai/lobu/commit/73bd37cc8cecc27595a89f2a08b8838c014da46f))
* **guardrails:** custom inline-judge guardrails, trips API, env-only judge model ([#1565](https://github.com/lobu-ai/lobu/issues/1565)) ([fbccae9](https://github.com/lobu-ai/lobu/commit/fbccae975f1dc92ede9675c12a80338170349d0d))
* remove agent MCP server settings ([#1614](https://github.com/lobu-ai/lobu/issues/1614)) ([65c3542](https://github.com/lobu-ai/lobu/commit/65c35424a175e441029bb57f6cbfaeadb5102736))
* **server:** allow file-only messages + harden attachment transcript refs ([#1557](https://github.com/lobu-ai/lobu/issues/1557)) ([6df3575](https://github.com/lobu-ai/lobu/commit/6df35756bbe2498e73b0be376706ea49f7c52cd8))
* **server:** attribute egress guardrail trips to their conversation ([#1601](https://github.com/lobu-ai/lobu/issues/1601)) ([5eb48bd](https://github.com/lobu-ai/lobu/commit/5eb48bd8dc1aa2dd49c7301c6944e6d6ca78c718))
* **server:** authorization/ACL program — Slack channel visibility gate (vertical 1) ([#1586](https://github.com/lobu-ai/lobu/issues/1586)) ([9d4a298](https://github.com/lobu-ai/lobu/commit/9d4a298571e21ea4d330586b360fb05a053fd9cb))
* **server:** per-user connection visibility on the SQL scoping seam ([#1574](https://github.com/lobu-ai/lobu/issues/1574)) ([c835e85](https://github.com/lobu-ai/lobu/commit/c835e8569b64b8281fc68f65be2fa1ebb1ceacd7))
* **server:** read past channel conversation via search_memory; retire get_channel_history ([#1578](https://github.com/lobu-ai/lobu/issues/1578)) ([b767dca](https://github.com/lobu-ai/lobu/commit/b767dca244b6bcf9204a015e682adc06f777e1f1))
* **server:** Settings escape hatch on the extension bootstrap error card ([#1572](https://github.com/lobu-ai/lobu/issues/1572)) ([0e27794](https://github.com/lobu-ai/lobu/commit/0e27794ff3f18ca358cd0c74dadec690cf1602a5))
* **slack:** personal notifications + agent setup link on App Home ([#1546](https://github.com/lobu-ai/lobu/issues/1546)) ([3ca71dc](https://github.com/lobu-ai/lobu/commit/3ca71dc07404a4a8c80be87f47e5fd6b13e5f314))
* **slack:** web-first connected-apps onboarding (server) ([#1568](https://github.com/lobu-ai/lobu/issues/1568)) ([b063c89](https://github.com/lobu-ai/lobu/commit/b063c89f016ea4cb95f24ef82aec7ef78f6e8cf0))
* **watchers:** sync extracted fields into entities + human-AI field ownership loop ([#1573](https://github.com/lobu-ai/lobu/issues/1573)) ([0d902a7](https://github.com/lobu-ai/lobu/commit/0d902a73078dfb883d9aa4925d1519903fd9b2b6))
* **web:** consolidate entity detail into entities browser + entity_id filters ([#1569](https://github.com/lobu-ai/lobu/issues/1569)) ([edf0ee1](https://github.com/lobu-ai/lobu/commit/edf0ee10e11375b60641d21af9c6bf80f4cac1c8))


### Bug Fixes

* **db:** resolve duplicate migration version 20260626000000 [dup-version-rename] ([#1588](https://github.com/lobu-ai/lobu/issues/1588)) ([09767c0](https://github.com/lobu-ai/lobu/commit/09767c0fd0ac5aeae84cfd62d31972632e5390bf))
* **server:** auto-bind the chrome connection to the online extension on dispatch ([#1597](https://github.com/lobu-ai/lobu/issues/1597)) ([2b8119e](https://github.com/lobu-ai/lobu/commit/2b8119e8ded55530ffffcedfe7d3f1191fbd2348))
* **server:** guardrail validation, Slack DM binding, non-OIDC OAuth (+owletto cleanup) ([#1579](https://github.com/lobu-ai/lobu/issues/1579)) ([cd47bfb](https://github.com/lobu-ai/lobu/commit/cd47bfbe69246fefff7b4e827d5a90024ca7cad7))
* **server:** notify the user to re-login when a connector's site session expires ([#1596](https://github.com/lobu-ai/lobu/issues/1596)) ([b3c6502](https://github.com/lobu-ai/lobu/commit/b3c650268482b434a021b823956897686c9e03bd))
* **server:** require explicit org selection when pairing a multi-org device ([#1594](https://github.com/lobu-ai/lobu/issues/1594)) ([1b308be](https://github.com/lobu-ai/lobu/commit/1b308be69cd3d7db4ae5c9da8603fe343831388f))
* **server:** resolve proxy network config per-server, not via a lazy global ([#1598](https://github.com/lobu-ai/lobu/issues/1598)) ([2191d23](https://github.com/lobu-ai/lobu/commit/2191d232bacc5c57bc9254a8c6ed18d3cb9b84ad))
* **server:** return 404 for expired/unknown MCP sessions so clients re-initialize ([#1616](https://github.com/lobu-ai/lobu/issues/1616)) ([940388f](https://github.com/lobu-ai/lobu/commit/940388fce7f7e3881b709685219fd00d0449773c))
* **server:** stop session_replication_role leaking across the test pool ([#1607](https://github.com/lobu-ai/lobu/issues/1607)) ([aae191c](https://github.com/lobu-ai/lobu/commit/aae191c1898cd158cdc65c37b0ea2effa270606c))
* **server:** wire grant + policy stores into the HTTP egress proxy at boot ([#1599](https://github.com/lobu-ai/lobu/issues/1599)) ([3e2ecd0](https://github.com/lobu-ai/lobu/commit/3e2ecd0991b3884d7f11fccb30475894f3b83cbb))
* **test:** retry cleanup TRUNCATE on deadlock with co-running pollers ([#1609](https://github.com/lobu-ai/lobu/issues/1609)) ([a15212c](https://github.com/lobu-ai/lobu/commit/a15212c924887d040de2ee047d7d8d1bd8172930))
* **test:** stop leaking the exclusive-lease poller across integration tests ([#1610](https://github.com/lobu-ai/lobu/issues/1610)) ([22b62bd](https://github.com/lobu-ai/lobu/commit/22b62bd3083eafa09e84a515ae814f379c63e3b6))

## [13.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v13.0.0...lobu-v13.1.0) (2026-06-24)


### Features

* **gateway:** provider-agnostic app-install + app-webhook engine ([#1553](https://github.com/lobu-ai/lobu/issues/1553)) ([63e2e83](https://github.com/lobu-ai/lobu/commit/63e2e83a2b55adb041174923790951e3a399ef3d))
* **server:** home-chat file attachments (artifact ingest + /lobu downloadUrl fix) ([#1551](https://github.com/lobu-ai/lobu/issues/1551)) ([7e1c06c](https://github.com/lobu-ai/lobu/commit/7e1c06cece7c9afc29b435610ecdc35f6e656c07))
* **watchers:** consolidate render+schema derivation onto entity types; reaction input contracts ([#1533](https://github.com/lobu-ai/lobu/issues/1533)) ([6ace3bf](https://github.com/lobu-ai/lobu/commit/6ace3bfa3a65aba9a74594f8cf15acdbb64da051))

## [13.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v12.1.0...lobu-v13.0.0) (2026-06-24)


### ⚠ BREAKING CHANGES

* **classifiers:** collapse classifier version model — classify_facet is the sole config table (P4) ([#1483](https://github.com/lobu-ai/lobu/issues/1483))
* **slack:** drop bespoke Slack install table/store — fully on app_installations (contract) ([#1471](https://github.com/lobu-ai/lobu/issues/1471))

### Features

* **agents:** backend-persisted agent thread list API ([#1524](https://github.com/lobu-ai/lobu/issues/1524)) ([b2ef525](https://github.com/lobu-ai/lobu/commit/b2ef525a70159e246bc20816243624283fa21106))
* **agents:** builder agent — manage the workspace from chat ([#1409](https://github.com/lobu-ai/lobu/issues/1409)) ([8bf373d](https://github.com/lobu-ai/lobu/commit/8bf373d98fcef5528d1a16ffa2a296e2f5c7e4dc))
* **api:** pending-approvals endpoint + interactive approval cards (owletto pointer bump) ([#1486](https://github.com/lobu-ai/lobu/issues/1486)) ([3d36dd2](https://github.com/lobu-ai/lobu/commit/3d36dd27a69b365d6cd82a3c69dca7753213b673))
* **catalog:** consolidate build pipeline and server-side merge ([#1521](https://github.com/lobu-ai/lobu/issues/1521)) ([b5ae4cc](https://github.com/lobu-ai/lobu/commit/b5ae4cc404298e2ad292ef976ee82e2778660867))
* **catalog:** unify catalog discovery under LOBU_CATALOG_URIS ([#1518](https://github.com/lobu-ai/lobu/issues/1518)) ([d519ff9](https://github.com/lobu-ai/lobu/commit/d519ff9ae957ad645c7401d83e1c8e51df0fb3ba))
* **classifiers:** collapse classifier version model — classify_facet is the sole config table (P4) ([#1483](https://github.com/lobu-ai/lobu/issues/1483)) ([e77d2b0](https://github.com/lobu-ai/lobu/commit/e77d2b08ad7edfa1746aae5fcc30e221d052e9ac))
* **cli:** whoami --json + Mac CLI auth delegation ([#263](https://github.com/lobu-ai/lobu/issues/263)) ([#1531](https://github.com/lobu-ai/lobu/issues/1531)) ([14d963f](https://github.com/lobu-ai/lobu/commit/14d963f59f585b121a5b1f226f5cb85941ddb725))
* **connections:** move feeds into a left rail like the memory page ([#1534](https://github.com/lobu-ai/lobu/issues/1534)) ([e7fc795](https://github.com/lobu-ai/lobu/commit/e7fc795288a5530684da60bee29066f5fbdc5962))
* **connector-sdk:** app_installation auth method + installation context + webhook delivery mode ([#1428](https://github.com/lobu-ai/lobu/issues/1428)) ([2b8e0cc](https://github.com/lobu-ai/lobu/commit/2b8e0cc1101232a525b0bffab5a013bceb56826f))
* **connectors+gateway:** GitHub App install flow + device_worker_id serverless fix + tenancy audit ([#1435](https://github.com/lobu-ai/lobu/issues/1435)) ([39ddd77](https://github.com/lobu-ai/lobu/commit/39ddd77f9bae91011b904538e1153d48d97773c4))
* **connectors:** inbound webhook ingestion (extract-load) + GitHub self-service registration ([#1408](https://github.com/lobu-ai/lobu/issues/1408)) ([c0e647d](https://github.com/lobu-ai/lobu/commit/c0e647dea436c053381b5b33bd5b1eb03c2fe5dd))
* **connectors:** Mac+Chrome device connectors (watch v2, EventKit, system-audio) + owletto pointer ([#1487](https://github.com/lobu-ai/lobu/issues/1487)) ([31af160](https://github.com/lobu-ai/lobu/commit/31af160a455750ea20fb48e09ef2fa559efc9a3a))
* **connectors:** refresh built-in connector defs across deploys + populate github webhook title/url ([#1467](https://github.com/lobu-ai/lobu/issues/1467)) ([ecba5d9](https://github.com/lobu-ai/lobu/commit/ecba5d96d69d7743ff1ef31aea970ae5a1124eab))
* **connectors:** self-service webhook ingestion + GitHub OAuth env creds ([#1418](https://github.com/lobu-ai/lobu/issues/1418)) ([693e3f8](https://github.com/lobu-ai/lobu/commit/693e3f8c5e6e54faebd0a8a1b0a883de72c5db5b))
* **corrections:** retire watcher_window_field_feedback onto correction events (P1, collapsed) ([#1512](https://github.com/lobu-ai/lobu/issues/1512)) ([5cee99e](https://github.com/lobu-ai/lobu/commit/5cee99e51b882892eea1ed83eed64bf50c1ff94b))
* **db:** app_installations table + store (reject/transfer install ownership) ([#1429](https://github.com/lobu-ai/lobu/issues/1429)) ([318066e](https://github.com/lobu-ai/lobu/commit/318066e12be397ab1bc6944d0952622f5ba550dc))
* **dev:** default `make dev` to shared brew Postgres@18, embedded opt-in ([#1496](https://github.com/lobu-ai/lobu/issues/1496)) ([a2ecfee](https://github.com/lobu-ai/lobu/commit/a2ecfeed88edba0545d1e595475fb80f25d5ec4d))
* **dev:** parallel local instances + DB-per-branch on local Postgres ([#1436](https://github.com/lobu-ai/lobu/issues/1436)) ([15921fc](https://github.com/lobu-ai/lobu/commit/15921fc42b4d034aca1bceb255b08b33e524a103))
* **entities:** event-sourced entity field projection (P5, collapsed) ([#1508](https://github.com/lobu-ai/lobu/issues/1508)) ([2e026e4](https://github.com/lobu-ai/lobu/commit/2e026e49681ccbc03a3d937484978552580899ff))
* **entities:** unify the edit event shape — one model for entity + watcher corrections ([#1515](https://github.com/lobu-ai/lobu/issues/1515)) ([01930fe](https://github.com/lobu-ai/lobu/commit/01930fe58d911943b33f2144466f641ce7e1277a))
* **gateway:** InstallationTokenProvider + GitHub installation-token minting ([#1430](https://github.com/lobu-ai/lobu/issues/1430)) ([a383533](https://github.com/lobu-ai/lobu/commit/a383533e0b6052343711ab29f551af6ca1f07f66))
* **gateway:** make GitHub App install self-service + recoverable ([#1468](https://github.com/lobu-ai/lobu/issues/1468)) ([f419822](https://github.com/lobu-ai/lobu/commit/f4198228a293ea58270780a33edfb3e807ffbaa9))
* **gateway:** schema-driven app-webhook verify + register Jira/Linear plugins ([#1491](https://github.com/lobu-ai/lobu/issues/1491)) ([a98cb65](https://github.com/lobu-ai/lobu/commit/a98cb6557bb4c1353ce1c46325e6b651a3c36605))
* **gateway:** shared /app-webhooks/:provider router + GitHub verifier/extractor ([#1431](https://github.com/lobu-ai/lobu/issues/1431)) ([129d6ed](https://github.com/lobu-ai/lobu/commit/129d6ed4b2a7661f035c60205f6b57bd9eaa836a))
* **github:** add commits feed — attribute who committed when ([#1513](https://github.com/lobu-ai/lobu/issues/1513)) ([8fb57d1](https://github.com/lobu-ai/lobu/commit/8fb57d1672610ab202bae104b55ab6a16d5f178d))
* **github:** attribute member identity from connector ingest ([#1492](https://github.com/lobu-ai/lobu/issues/1492)) ([e69b19a](https://github.com/lobu-ai/lobu/commit/e69b19a851ccfaa62a760378deaa53061f94db84))
* **github:** build org-membership team graph on App install ([#1494](https://github.com/lobu-ai/lobu/issues/1494)) ([0aa65c7](https://github.com/lobu-ai/lobu/commit/0aa65c7bfc7ed5f5391c0afff98bd6c0bac49613))
* **github:** poll-canonical webhook triggers + direct-store for stars ([#1540](https://github.com/lobu-ai/lobu/issues/1540)) ([b84f9cd](https://github.com/lobu-ai/lobu/commit/b84f9cd2be50dd9cdbb65fda63cfe4e5160c7e14))
* **landing:** add the agent-loop-is-the-new-saas blog post ([292e625](https://github.com/lobu-ai/lobu/commit/292e6257f24b9236251e09d0f224bac3fd0d1720))
* **landing:** explanatory OG image — Watch → Understand → Act ([#1406](https://github.com/lobu-ai/lobu/issues/1406)) ([ea548db](https://github.com/lobu-ai/lobu/commit/ea548db79e6a7f52eab628c262069d656a0bf49d))
* **landing:** new Watch→Understand→Act loop OG image ([#1412](https://github.com/lobu-ai/lobu/issues/1412)) ([ee8c4a1](https://github.com/lobu-ai/lobu/commit/ee8c4a1c775bc776b3f6671405a330578c91ad5c))
* **landing:** reposition hero subline + meta to open-source infra framing ([#1403](https://github.com/lobu-ai/lobu/issues/1403)) ([c1f538a](https://github.com/lobu-ai/lobu/commit/c1f538aab73a534756ec590ff59fd19a29245973))
* **memory:** filter events by source connections ([#1532](https://github.com/lobu-ai/lobu/issues/1532)) ([6aa0f41](https://github.com/lobu-ai/lobu/commit/6aa0f41a7caab89af7da62bbcab15d0cdde99791))
* **server:** Builder confirm/diff gate for manage_agents ([#1485](https://github.com/lobu-ai/lobu/issues/1485)) ([7f2a829](https://github.com/lobu-ai/lobu/commit/7f2a8298121d26f9314aacadba010212fa09a72d))
* **server:** shared system-provider resolution and managed platform metadata ([#1525](https://github.com/lobu-ai/lobu/issues/1525)) ([97c1c0a](https://github.com/lobu-ai/lobu/commit/97c1c0a6003cefd06bcb21e4c68c760d7198c147))
* **server:** wire entity_types filter for org-wide read_knowledge ([#1529](https://github.com/lobu-ai/lobu/issues/1529)) ([cd43281](https://github.com/lobu-ai/lobu/commit/cd43281e9db5e841ca1c6455718c629d67b8896c))
* **slack:** consolidate Slack installs onto app_installations (expand) ([#1470](https://github.com/lobu-ai/lobu/issues/1470)) ([d78e2b2](https://github.com/lobu-ai/lobu/commit/d78e2b2b8bdfa7ddd32fc9cc8f1ef71d1e0eab52))
* **slack:** dashboard deep-link, org counts, and recent activity on App Home ([#1537](https://github.com/lobu-ai/lobu/issues/1537)) ([0ce5616](https://github.com/lobu-ai/lobu/commit/0ce5616d78b7e9c543ad983c73d01da0f3c4a9ed))
* **slack:** drop bespoke Slack install table/store — fully on app_installations (contract) ([#1471](https://github.com/lobu-ai/lobu/issues/1471)) ([63d5704](https://github.com/lobu-ai/lobu/commit/63d5704de8fe4102e6590287264628d1dd8670a1))
* **watchers:** backend support for conversational watcher UX ([#1523](https://github.com/lobu-ai/lobu/issues/1523)) ([1e5e868](https://github.com/lobu-ai/lobu/commit/1e5e86805b82761b7d19b3a69347e2aab8310668))
* **watchers:** derive extraction schema from the entity type (schema lives on the type) ([#1514](https://github.com/lobu-ai/lobu/issues/1514)) ([3c6e40f](https://github.com/lobu-ai/lobu/commit/3c6e40f4c4e80377bb3fb99a194020aecdfdd975))
* **watchers:** derive window render from the entity type (P3 server) ([#1542](https://github.com/lobu-ai/lobu/issues/1542)) ([5468be9](https://github.com/lobu-ai/lobu/commit/5468be97a4f6b61630e783324c809e8aeb2fa26e))
* **watchers:** promote keyed window rows into entities + observation events (P2 phase 1) ([#1502](https://github.com/lobu-ai/lobu/issues/1502)) ([80f64ad](https://github.com/lobu-ai/lobu/commit/80f64ade832a80ec18f5160d743e56bfc154aeeb))


### Bug Fixes

* **builder:** reliable builder provisioning — deterministic resolve + self-heal ([#1426](https://github.com/lobu-ai/lobu/issues/1426)) ([49c4f76](https://github.com/lobu-ai/lobu/commit/49c4f7661f642c0419d953e957cc4fbfafdb645d))
* **catalog:** address PR [#1518](https://github.com/lobu-ai/lobu/issues/1518) review findings ([#1519](https://github.com/lobu-ai/lobu/issues/1519)) ([671b8ed](https://github.com/lobu-ai/lobu/commit/671b8ed3c2ed7d008c4142c49180ef0d75eb1739))
* **connections:** resolve asserted auth-profile slug in app_installation guard ([#1488](https://github.com/lobu-ai/lobu/issues/1488)) ([29f1996](https://github.com/lobu-ai/lobu/commit/29f199668a42929083a11676ec05a50573d4798e))
* **connectors:** resolve OAuth app client creds from env in the connect path ([#1427](https://github.com/lobu-ai/lobu/issues/1427)) ([8bba0db](https://github.com/lobu-ai/lobu/commit/8bba0dbd2a3e98264c7f400bcda0b7a1cd58ac2c))
* **db:** resolve duplicate migration version 20260622000030 ([#1493](https://github.com/lobu-ai/lobu/issues/1493)) ([b763087](https://github.com/lobu-ai/lobu/commit/b76308730b8687f18d9a9de2b8e82aecee23ff82))
* **dev:** drop per-branch dev DB on task-clean + clean-merged sweep ([#1457](https://github.com/lobu-ai/lobu/issues/1457)) ([9b09ed5](https://github.com/lobu-ai/lobu/commit/9b09ed567ea74fd72aa7b48b818d5638fb56e2fa))
* **dev:** make dev-db a walk-in single-user install (LOBU_SINGLE_USER=1) ([#1441](https://github.com/lobu-ai/lobu/issues/1441)) ([89b9cb0](https://github.com/lobu-ai/lobu/commit/89b9cb017c5bddbe9a8b4589b7b24e82325c4ab7))
* **embeddings:** serialize embed_backfill dispatch to one org per tick ([#1536](https://github.com/lobu-ai/lobu/issues/1536)) ([57652a8](https://github.com/lobu-ai/lobu/commit/57652a8ce7a604f5723716e8dbf393d978c6986e))
* **gateway:** worker poll rejects browser-session auth with 401 so the extension can refresh ([#1402](https://github.com/lobu-ai/lobu/issues/1402)) ([cbafc13](https://github.com/lobu-ai/lobu/commit/cbafc130229cd6e7a6983e7cc509c0e66b8ae74f))
* **jira:** migrate sync to /rest/api/3/search/jql ([#1411](https://github.com/lobu-ai/lobu/issues/1411)) ([47d906f](https://github.com/lobu-ai/lobu/commit/47d906f3b50385385da95a476c12bd9d3e058480))
* **landing:** unblock format-lint (remove useless fragment in LandingPage) ([40659c8](https://github.com/lobu-ai/lobu/commit/40659c81f63c1f5322cd1cfe29b15d55f44b5878))
* **mac:** always show context row; opt-in task-setup context registration ([#1509](https://github.com/lobu-ai/lobu/issues/1509)) ([3d8407b](https://github.com/lobu-ai/lobu/commit/3d8407b93a4e5ff5e1066e5562b40bcadef7ffce))
* **migrate:** fail fast when a pending SET NOT NULL has unbacked NULLs ([#1538](https://github.com/lobu-ai/lobu/issues/1538)) ([74c3d20](https://github.com/lobu-ai/lobu/commit/74c3d20de357341a00bfb8db6d10f67a316d11c9))
* **model:** resolve provider-prefixed models + upgrade pi-ai for adaptive thinking ([#1434](https://github.com/lobu-ai/lobu/issues/1434)) ([06688d2](https://github.com/lobu-ai/lobu/commit/06688d2cf2a25cf2dd7bca09414e0c547641716f))
* **orchestrator:** make the systemd worker sandbox actually work, degrade safely where it can't ([#1407](https://github.com/lobu-ai/lobu/issues/1407)) ([fc2ea0e](https://github.com/lobu-ai/lobu/commit/fc2ea0ef642625dbb67500c51664593e1216ffcb))
* **provider:** stop the system/builder agent defaulting to an unusable provider ([#1481](https://github.com/lobu-ai/lobu/issues/1481)) ([a711992](https://github.com/lobu-ai/lobu/commit/a71199243d06ad0f8e476bea614a7557422f73fb))
* **server:** allow published Chrome Web Store extension ID in CSP + CORS ([#1547](https://github.com/lobu-ai/lobu/issues/1547)) ([f4cb94b](https://github.com/lobu-ai/lobu/commit/f4cb94ba1f8459a77d0676ea507ec55e18227896))
* **server:** bound embed-backfill discovery scan with statement_timeout ([#1462](https://github.com/lobu-ai/lobu/issues/1462)) ([805d8ae](https://github.com/lobu-ai/lobu/commit/805d8ae6727871bd6b98ede592a907769fe8ea3d))
* **slack:** bind publishHomeView so the App Home tab publishes ([#1545](https://github.com/lobu-ai/lobu/issues/1545)) ([eabd81e](https://github.com/lobu-ai/lobu/commit/eabd81eae19d18783fef8fed45bc1d017cb4834e))
* **slack:** surface App Home publish errors in logs ([#1543](https://github.com/lobu-ai/lobu/issues/1543)) ([afad7e6](https://github.com/lobu-ai/lobu/commit/afad7e6892102b7500947fb9cf662e6fb5fbe4ec))
* **worker:** expose customTools to the model (pi 0.73.x treats options.tools as a hard allowlist) ([#1484](https://github.com/lobu-ai/lobu/issues/1484)) ([cd974c8](https://github.com/lobu-ai/lobu/commit/cd974c85491ba36c4ec1496ca0627ac342ef9b2f))

## [12.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v12.0.0...lobu-v12.1.0) (2026-06-20)


### Features

* **cli:** hosted Lobu bot via tokenless slack/telegram platform entry ([#1387](https://github.com/lobu-ai/lobu/issues/1387)) ([d8476e7](https://github.com/lobu-ai/lobu/commit/d8476e77ef253e6d6b3d6596968d93f09f2244d3))
* **connectors:** harden install_connector source_url fetch (SSRF + allowlist) ([#1382](https://github.com/lobu-ai/lobu/issues/1382)) ([02cc93f](https://github.com/lobu-ai/lobu/commit/02cc93fdd6ed4da9473d7f295f88c82e3caa5f81))
* **memory:** multi-vector embeddings — contract phase (PK swap + decouple view) ([#1380](https://github.com/lobu-ai/lobu/issues/1380)) ([6c8e7e4](https://github.com/lobu-ai/lobu/commit/6c8e7e4b8a5cd2fb96f17e09575084fd32ca0766))
* **model:** require an explicit model — stop silently picking a provider default ([#1396](https://github.com/lobu-ai/lobu/issues/1396)) ([c6bb8a2](https://github.com/lobu-ai/lobu/commit/c6bb8a283283c3fe3de483338e6ab023fb0e48b1))
* **server:** drop the 4-field cap on x-table-column metadata fields ([#1386](https://github.com/lobu-ai/lobu/issues/1386)) ([6164657](https://github.com/lobu-ai/lobu/commit/61646574309cb013b4e08d718b07a895d544fcae))
* **slack:** one-click multi-agent workspace installs (slack_installations store) ([#1394](https://github.com/lobu-ai/lobu/issues/1394)) ([26e24f8](https://github.com/lobu-ai/lobu/commit/26e24f8c03cb836bff4f53d05a226766301e8622))
* support Node 22-24 and 26+ via dual isolated-vm builds ([#1378](https://github.com/lobu-ai/lobu/issues/1378)) ([252991e](https://github.com/lobu-ai/lobu/commit/252991e6eab65ef3b0ce67f8b5427eed24d27a42))


### Bug Fixes

* **anthropic:** resolve auto-mode model from env key + run newest live models ([#1395](https://github.com/lobu-ai/lobu/issues/1395)) ([3584b38](https://github.com/lobu-ai/lobu/commit/3584b38e522ff0737b90d6d39e99064b7a5c7333))
* **gateway:** provider-driven model defaults + clean SSE status render ([#1390](https://github.com/lobu-ai/lobu/issues/1390)) ([d97acb3](https://github.com/lobu-ai/lobu/commit/d97acb386447eada1a7b9c1d1011ee56501d4655))
* **server:** make env-configured Anthropic API keys work (x-api-key + recognition) ([#1393](https://github.com/lobu-ai/lobu/issues/1393)) ([4dbec06](https://github.com/lobu-ai/lobu/commit/4dbec0664404d643c0add073aa680c1cc78c67fe))
* **server:** Slack OAuth redirect_uri must carry the /lobu gateway prefix ([#1389](https://github.com/lobu-ai/lobu/issues/1389)) ([feb8d03](https://github.com/lobu-ai/lobu/commit/feb8d03488145353a7c5a1f3537b59c7f2a8e50e))


### Reverts

* hide Add to Slack surfacing until the OAuth install is completed ([#1392](https://github.com/lobu-ai/lobu/issues/1392)) ([830cd53](https://github.com/lobu-ai/lobu/commit/830cd53a7de3c402edaf29d74ad408b329a5ab8a))

## [12.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.3.0...lobu-v12.0.0) (2026-06-18)


### ⚠ BREAKING CHANGES

* **connectors:** remove cookie-cloning; move Revolut to extension ([#1258](https://github.com/lobu-ai/lobu/issues/1258))

### Features

* **connectors:** alert when a connector silently dies ([#1312](https://github.com/lobu-ai/lobu/issues/1312)) ([32eadce](https://github.com/lobu-ai/lobu/commit/32eadce94affe271f6bdbe83e2ad1751b746726e))
* **connectors:** connector actions can drive the Owletto extension; dynamic Deliveroo search/menu ([#1309](https://github.com/lobu-ai/lobu/issues/1309)) ([09175de](https://github.com/lobu-ai/lobu/commit/09175deb9b4414c5d8ea6da3c8803fe67f9f27e2))
* **examples:** derive subscription and trip views in personal-agent ([#1242](https://github.com/lobu-ai/lobu/issues/1242)) ([8b38cca](https://github.com/lobu-ai/lobu/commit/8b38cca1f8b342ca3ef055420c93e42cee2b0fc2))
* **gateway:** inbound webhook connections — push-source primitive ([#1235](https://github.com/lobu-ai/lobu/issues/1235)) ([#1237](https://github.com/lobu-ai/lobu/issues/1237)) ([9a6f0d2](https://github.com/lobu-ai/lobu/commit/9a6f0d27b5fb11e85c1a6798b6eba1693a43e0b7))
* **gateway:** native conversation tools (list/read/send) for agents ([#1359](https://github.com/lobu-ai/lobu/issues/1359)) ([f85530e](https://github.com/lobu-ai/lobu/commit/f85530e671bab647e7e7c1406c11e78efdfc8ff1))
* **landing:** rebuild operating-loop as a centered numbered timeline ([#1360](https://github.com/lobu-ai/lobu/issues/1360)) ([24cfeea](https://github.com/lobu-ai/lobu/commit/24cfeea1056a37ef7c32d04e18e0564c6db8b55f))
* **landing:** simplify agent positioning ([#1260](https://github.com/lobu-ai/lobu/issues/1260)) ([8bf8dcd](https://github.com/lobu-ai/lobu/commit/8bf8dcd7ba49ba49cc02d566aa0cbbb5e38d1a29))
* **landing:** unify the operating-loop section across homepage and /for pages ([#1357](https://github.com/lobu-ai/lobu/issues/1357)) ([ed22bb0](https://github.com/lobu-ai/lobu/commit/ed22bb0a3c4d11b53be0898f726ee2b1d6314733))
* **lobu-crm:** enable hosted Slack preview for crm ([#1256](https://github.com/lobu-ai/lobu/issues/1256)) ([05e823e](https://github.com/lobu-ai/lobu/commit/05e823e98f49ca3fbf32bf34f71f29b4c798b3df))
* **memory:** multi-vector embeddings — expand phase (schema + safe write/read paths) ([#1370](https://github.com/lobu-ai/lobu/issues/1370)) ([2c20144](https://github.com/lobu-ai/lobu/commit/2c201441e36e60d352901f2abd457d0a6744a4f8))
* **metrics:** entity-bound metric layer — contract, persistence, validation, federation hook ([#1262](https://github.com/lobu-ai/lobu/issues/1262)) ([ec26814](https://github.com/lobu-ai/lobu/commit/ec26814c76afe87587d3630fee1ca7794312df8f))
* **metrics:** metric compiler (alias resolver) + runMetric + golden test ([#1267](https://github.com/lobu-ai/lobu/issues/1267)) ([2397436](https://github.com/lobu-ai/lobu/commit/2397436175d48054f9587091c6e47c8ee40a8797))
* **metrics:** query_metric + list_metrics MCP tools (semantic-first routing) ([#1268](https://github.com/lobu-ai/lobu/issues/1268)) ([9a852f4](https://github.com/lobu-ai/lobu/commit/9a852f45742bc12a9911a242a3b159e504f3b15f))
* **server:** connections are rows, not processes — lazy hydration + exclusive-transport lease ([#1231](https://github.com/lobu-ai/lobu/issues/1231)) ([ac75e71](https://github.com/lobu-ai/lobu/commit/ac75e71af5953955a5ed6918e06f61fcda9d2b3f))
* **server:** replace opt-in rewrite_query param with auto on-miss recall rescue ([#1277](https://github.com/lobu-ai/lobu/issues/1277)) ([1e89c3c](https://github.com/lobu-ai/lobu/commit/1e89c3cc12119156bf96b9983249475412692c58))
* **server:** resolve and list derived entity rows like stored entities ([#1259](https://github.com/lobu-ai/lobu/issues/1259)) ([eed170b](https://github.com/lobu-ai/lobu/commit/eed170bdf76dca6528b96c4fbe535df2b336ebd3))


### Bug Fixes

* **connections:** bounded retry for exclusive-start failures + claim cleanup + save_memory supersede TOCTOU ([#1344](https://github.com/lobu-ai/lobu/issues/1344)) ([7b76c8d](https://github.com/lobu-ai/lobu/commit/7b76c8d1bb2b78be37d3448e01f8e99439a5d314))
* connectors are unusable via lobu apply (connection/feed config scope) ([#1367](https://github.com/lobu-ai/lobu/issues/1367)) ([04770f2](https://github.com/lobu-ai/lobu/commit/04770f29f13985752d96edcd52ba450e55d6da17))
* **data-sources:** mask excluded columns + gate admin tables in view-template/watcher queries ([#1329](https://github.com/lobu-ai/lobu/issues/1329)) ([1bf854d](https://github.com/lobu-ai/lobu/commit/1bf854dda761c037fe55a32bdd6ccbffce344054))
* **db:** retry transient pooler connection drops on the worker-poll claim ([#1353](https://github.com/lobu-ai/lobu/issues/1353)) ([66cc355](https://github.com/lobu-ai/lobu/commit/66cc355f4e09a6117fc85ffa2895ca37827b8e10))
* deliver headless interaction cards (F12), harden secret-proxy throttle, trustworthy knip + dead-code ([#1271](https://github.com/lobu-ai/lobu/issues/1271)) ([7333123](https://github.com/lobu-ai/lobu/commit/7333123d386e2b90940da32e74c76d5d69cccd82))
* **deps:** force a single sharp ^0.34 via overrides to unbreak the app image build ([#1229](https://github.com/lobu-ai/lobu/issues/1229)) ([4a1521b](https://github.com/lobu-ai/lobu/commit/4a1521b7b4e1cae1cfff04880ef1ed408c638f12)), closes [#1225](https://github.com/lobu-ai/lobu/issues/1225)
* **docker:** pin PLAYWRIGHT_BROWSERS_PATH so browser connectors find Chromium ([#1313](https://github.com/lobu-ai/lobu/issues/1313)) ([a0b72a7](https://github.com/lobu-ai/lobu/commit/a0b72a7ef0aa18239be35f955632a5fb67d08523))
* **e2e:** tear down auto-provisioned personal orgs + add prod-host guard ([#1285](https://github.com/lobu-ai/lobu/issues/1285)) ([0a28925](https://github.com/lobu-ai/lobu/commit/0a2892504aba74ed32c5dc46af513d3057a053e2))
* **embeddings:** clamp oversized texts so backfill batches never silently drop ([#1289](https://github.com/lobu-ai/lobu/issues/1289)) ([406d6e5](https://github.com/lobu-ai/lobu/commit/406d6e5acb09b7e1525699adcbda6868510957c0))
* **events:** serialize dedup insert per (connection_id, origin_id) to stop duplicate current rows ([#1286](https://github.com/lobu-ai/lobu/issues/1286)) ([c018e18](https://github.com/lobu-ai/lobu/commit/c018e18e5401b6580336b95150fd219fad07d790))
* **files:** bind worker upload destination to the verified token, not request headers ([#1330](https://github.com/lobu-ai/lobu/issues/1330)) ([936c239](https://github.com/lobu-ai/lobu/commit/936c239af98d4e443a099547a9442bfa07334e62))
* **gateway:** API status-message cross-pod fan-out + terminal finalText repair ([#1276](https://github.com/lobu-ai/lobu/issues/1276)) ([fddb490](https://github.com/lobu-ai/lobu/commit/fddb490dafa165abbae14201bfd0f7e75c26c4e5))
* **gateway:** close worker-token claim-class bugs + mint regression coverage ([#1282](https://github.com/lobu-ai/lobu/issues/1282)) ([ee28f32](https://github.com/lobu-ai/lobu/commit/ee28f32b38b745dce455742b0a5e7663ca0b0311))
* **gateway:** fan out chat interaction cards cross-pod (multi-replica ask_user) ([#1270](https://github.com/lobu-ai/lobu/issues/1270)) ([559c3ff](https://github.com/lobu-ai/lobu/commit/559c3ffd2cb317effce0abdaffd0520ff1c8db93))
* **gateway:** include connectionId in per-run worker token (ask_user 500 hotfix) ([#1274](https://github.com/lobu-ai/lobu/issues/1274)) ([94485b7](https://github.com/lobu-ai/lobu/commit/94485b7da774d945ad18ca7ae1faa1c419e2bb5b))
* **gateway:** multi-replica SSE delivery — headless owner-gate exemption, LISTEN/NOTIFY fan-out, API interaction-card source fix ([#1236](https://github.com/lobu-ai/lobu/issues/1236)) ([7a2f4ef](https://github.com/lobu-ai/lobu/commit/7a2f4ef119f44f69aae84e61994c146f0cb29d95))
* **gateway:** SPA agent runs 403 — authorize by agent's resolved org, not ambient default org ([#1265](https://github.com/lobu-ai/lobu/issues/1265)) ([b6e7631](https://github.com/lobu-ai/lobu/commit/b6e7631f5a1b83c75cc3ad0a96ecf1ba59c65010))
* **gateway:** use deep config compare in agent-config update (stop spurious adapter restarts) ([#1299](https://github.com/lobu-ai/lobu/issues/1299)) ([4b0d0c4](https://github.com/lobu-ai/lobu/commit/4b0d0c476810614e71a29d62defd0c7b0577d668))
* **guardrails:** enforce output guardrails on the API/SSE path ([#1326](https://github.com/lobu-ai/lobu/issues/1326)) ([d137f51](https://github.com/lobu-ai/lobu/commit/d137f51ee219f3ab51fe440a33953fe32035300e))
* **guardrails:** harden secret-scan coverage + always scan full completion text ([#1332](https://github.com/lobu-ai/lobu/issues/1332)) ([6d8f2b6](https://github.com/lobu-ai/lobu/commit/6d8f2b6f6334ec895c4dc30365399a089cff8cb6))
* harden worker-api auth, rate-limit IP source, and assorted correctness bugs ([#1266](https://github.com/lobu-ai/lobu/issues/1266)) ([fb62ecc](https://github.com/lobu-ai/lobu/commit/fb62ecc32b1cb9503b8100a37d299b3c301f5207))
* **lobu-crm:** switch crm agent to z-ai/glm-5.2 ([#1254](https://github.com/lobu-ai/lobu/issues/1254)) ([5f8d120](https://github.com/lobu-ai/lobu/commit/5f8d1205e39adaa83020667f499e0a57cf277a2b))
* **mcp,egress:** org-scope MCP caches and IDNA-normalize egress matching ([#1346](https://github.com/lobu-ai/lobu/issues/1346)) ([2bd6339](https://github.com/lobu-ai/lobu/commit/2bd6339276b93d5b0e18ad6ec396d31eab206b48))
* **mcp:** reject batched tools/call that bypasses pre-tool guardrails + approval ([#1328](https://github.com/lobu-ai/lobu/issues/1328)) ([4026e66](https://github.com/lobu-ai/lobu/commit/4026e667556d1980a0c3a9e009cb9b0e55187f90))
* **notifications:** deliver proactive notifications to preview-linked channels (cross-org) ([#1331](https://github.com/lobu-ai/lobu/issues/1331)) ([242014e](https://github.com/lobu-ai/lobu/commit/242014e4dcc844bc3ec64781cae6c9b919bc78b7))
* **oauth:** form-encode Claude token exchange to fix login ([#1305](https://github.com/lobu-ai/lobu/issues/1305)) ([64e1c8a](https://github.com/lobu-ai/lobu/commit/64e1c8a235e028a03d4d37ad8ae06f49bb4ee974))
* **oauth:** implement ChatGPT token refresh so device-code login self-heals ([#1317](https://github.com/lobu-ai/lobu/issues/1317)) ([de4d4dd](https://github.com/lobu-ai/lobu/commit/de4d4dd8f3032a08eb78082402a86162a317b0ac))
* **oauth:** match Claude exchange redirect_uri to the authorize step ([#1319](https://github.com/lobu-ai/lobu/issues/1319)) ([0eab2ad](https://github.com/lobu-ai/lobu/commit/0eab2adfb0db0b97fd2add14b5a89ce91f7a9448))
* **oauth:** pass userId when persisting the Claude OAuth profile ([#1321](https://github.com/lobu-ai/lobu/issues/1321)) ([2a9a0c7](https://github.com/lobu-ai/lobu/commit/2a9a0c79479f9880913233e1407fcbb291a2ff5c))
* **office-bot:** flat-allow Deliveroo instead of LLM-judged egress ([#1306](https://github.com/lobu-ai/lobu/issues/1306)) ([8301f6e](https://github.com/lobu-ai/lobu/commit/8301f6eb2694ec92dc80067fd6762497af278bfd))
* **orchestrator:** gracefully fall back when nix-shell is absent ([#1297](https://github.com/lobu-ai/lobu/issues/1297)) ([84b6c7e](https://github.com/lobu-ai/lobu/commit/84b6c7e03709e371cdcd24a1e8090783db940eb6))
* **personal-agent:** align Revolut auth profile with Mac browser session ([#1252](https://github.com/lobu-ai/lobu/issues/1252)) ([dd4d0d9](https://github.com/lobu-ai/lobu/commit/dd4d0d9f09f468255b7442351fe57525c1bda28d))
* pre-release onboarding fixes (initdb locale, auto-apply org, HN sync budget) ([#1369](https://github.com/lobu-ai/lobu/issues/1369)) ([f73f280](https://github.com/lobu-ai/lobu/commit/f73f28060fa7f4f2f28f823003f79d6d2b6c99fb))
* **preview:** working lobu.ai/slack front door for the Slack preview bot ([#1279](https://github.com/lobu-ai/lobu/issues/1279)) ([9e72fe0](https://github.com/lobu-ai/lobu/commit/9e72fe0e59620e5c698815aeaee88955e21afec0))
* prod-readiness pass — 9 bug fixes (6 security) + dedup (net −948 LOC product) ([#1272](https://github.com/lobu-ai/lobu/issues/1272)) ([349e74d](https://github.com/lobu-ai/lobu/commit/349e74d9e4045a5832d465129c38552bd040d62f))
* resolve mcp credentials in worker org context ([af7e25d](https://github.com/lobu-ai/lobu/commit/af7e25df1468f46185e18d9135d59dfb29d26d6b))
* **revolut:** reliable extension scrape — fresh-window + fail-closed robustness (3.4.0) ([#1269](https://github.com/lobu-ai/lobu/issues/1269)) ([c908ce8](https://github.com/lobu-ai/lobu/commit/c908ce8d57adeef9f56ccee07be2b8fe2a794b6d))
* **sentry:** default environment to development, not production ([#1354](https://github.com/lobu-ai/lobu/issues/1354)) ([b67dd6b](https://github.com/lobu-ai/lobu/commit/b67dd6b4ae7876bdee66e798c83c841b25d29d6f))
* **server:** accept SSE ?token= ticket at the agent API outer auth gate ([#1342](https://github.com/lobu-ai/lobu/issues/1342)) ([3d29ec1](https://github.com/lobu-ai/lobu/commit/3d29ec17b904bdacd7121e0e2d075ebf951b226b))
* **server:** accept SSE ?token= ticket on the invalidation events route ([#1347](https://github.com/lobu-ai/lobu/issues/1347)) ([616e5f4](https://github.com/lobu-ai/lobu/commit/616e5f4584f43ba86eff4d9af4958f2605285bd1))
* **server:** annotate createAuth return type to unblock Docker image build ([#1294](https://github.com/lobu-ai/lobu/issues/1294)) ([3b9f4f4](https://github.com/lobu-ai/lobu/commit/3b9f4f4b602ebd2dabb51c7e6a4f6f62f1ee4928))
* **server:** Bearer-auth the embedded extension iframe; drop dead partitioned-cookie path ([#1336](https://github.com/lobu-ai/lobu/issues/1336)) ([4fcd43e](https://github.com/lobu-ai/lobu/commit/4fcd43efbf9caf4c81196fc605b9b5930b9c0e2a))
* **server:** correct prod log level + consolidate nix sanitizer & JSON-body parsing ([#1293](https://github.com/lobu-ai/lobu/issues/1293)) ([629c7c3](https://github.com/lobu-ai/lobu/commit/629c7c30c940f35d1288d0dc45e652542dd3de95))
* **server:** drop dead connector_definitions.api_type column ([#1232](https://github.com/lobu-ai/lobu/issues/1232)) ([8a6600a](https://github.com/lobu-ai/lobu/commit/8a6600ad1d4a546313ed6a27d159e8ff888e8ed1))
* **server:** drop losing-replica worker spawn silently when conversation is owned by another pod ([#1257](https://github.com/lobu-ai/lobu/issues/1257)) ([a643f68](https://github.com/lobu-ai/lobu/commit/a643f688329c202a69b7b772b7eb85f16de5f731))
* **server:** enforce TypeBox arg validation for all tools at one chokepoint ([#1234](https://github.com/lobu-ai/lobu/issues/1234)) ([eee23e0](https://github.com/lobu-ai/lobu/commit/eee23e0e03343f20bdb9197e8d8ab3a48709bab0)), closes [#1137](https://github.com/lobu-ai/lobu/issues/1137)
* **server:** expected entity-schema tool faults throw ToolUserError, not Error ([#1302](https://github.com/lobu-ai/lobu/issues/1302)) ([e904fc4](https://github.com/lobu-ai/lobu/commit/e904fc4423101da9fb231f5b68c7a0aa272b6c2b))
* **server:** hydrate embedded Postgres SONAME symlinks at boot ([#1371](https://github.com/lobu-ai/lobu/issues/1371)) ([#1376](https://github.com/lobu-ai/lobu/issues/1376)) ([c6c4bea](https://github.com/lobu-ai/lobu/commit/c6c4beaaba75ec4850e6ec823328e0d8a520a08d))
* **server:** read_knowledge 400 on queries with leading whitespace; add query fuzz guard ([#1281](https://github.com/lobu-ai/lobu/issues/1281)) ([232f7cd](https://github.com/lobu-ai/lobu/commit/232f7cd3e1b96da9ab185591a40ba47a9f3e91b8))
* **server:** SSE auth ticket for embedded panel + bootstrap retry-on-failure ([#1340](https://github.com/lobu-ai/lobu/issues/1340)) ([6bec163](https://github.com/lobu-ai/lobu/commit/6bec163abe89dd55ac7f3d3504733a583b84532b))
* **server:** stop expected 4xx tool faults from creating Sentry issues ([#1295](https://github.com/lobu-ai/lobu/issues/1295)) ([809edac](https://github.com/lobu-ai/lobu/commit/809edac68ea8d37edb5cd3e2cdd5a53f8916fa08))
* **server:** stop orphaned embedded Postgres after bun:test runs ([#1255](https://github.com/lobu-ai/lobu/issues/1255)) ([adaad78](https://github.com/lobu-ai/lobu/commit/adaad788c9d49ce9a3494d129c94e7abbf93d57d))
* **server:** strip NUL bytes from tool args + MCP tool-surface input fuzz harness ([#1283](https://github.com/lobu-ai/lobu/issues/1283)) ([461e428](https://github.com/lobu-ai/lobu/commit/461e428ac129ddd500daeb95678bceb4c058cbe6))
* **server:** unblock app image build — align worker context with WorkerTokenData ([#1243](https://github.com/lobu-ai/lobu/issues/1243)) ([cfc7c17](https://github.com/lobu-ai/lobu/commit/cfc7c17d1d4939eede55aa7ca1a50cb37b50a54d))
* **spotify:** stable origin_id for id-less tracks + day-bucketed top-track snapshots ([#1287](https://github.com/lobu-ai/lobu/issues/1287)) ([205a31a](https://github.com/lobu-ai/lobu/commit/205a31a7fc4deb2b677c299befe8e9b332895722))
* **test:** reap orphaned lobu-test-pg clusters (65G disk leak) ([#1291](https://github.com/lobu-ai/lobu/issues/1291)) ([f52a14a](https://github.com/lobu-ai/lobu/commit/f52a14a9a05cf74f6d9c592a652ffff3de3c1728))
* **turn-liveness:** keep active long-running workers alive on every worker signal ([#1343](https://github.com/lobu-ai/lobu/issues/1343)) ([f22145b](https://github.com/lobu-ai/lobu/commit/f22145baa1a23683b73c544a2ca59f0b8ae06bed))
* **worker:** install patchright Chromium revision the runtime expects ([#1315](https://github.com/lobu-ai/lobu/issues/1315)) ([e58c442](https://github.com/lobu-ai/lobu/commit/e58c4420826869ad8d6b21994697428227ec9cbb))
* **worker:** refresh worker token mid-turn via deployment-liveness gate ([#1280](https://github.com/lobu-ai/lobu/issues/1280)) ([1f41b3f](https://github.com/lobu-ai/lobu/commit/1f41b3f611f1211c2315f66941bee149fdf264c0))


### Performance Improvements

* **ci:** app image cache-to mode=min + dedicated scope (cut ~150s build) ([#1303](https://github.com/lobu-ai/lobu/issues/1303)) ([c44ca45](https://github.com/lobu-ai/lobu/commit/c44ca45d3a986fd3e84dcca6564de99c0fac0f05))
* **ci:** incremental app builds — drop CACHEBUST, cache-to mode=max ([#1307](https://github.com/lobu-ai/lobu/issues/1307)) ([379fb5f](https://github.com/lobu-ai/lobu/commit/379fb5fc1243518e4157389533cc672c24e6f40b))
* **embed-backfill:** index-driven recent-first scan (prod 1.4s-&gt;4ms) ([#1292](https://github.com/lobu-ai/lobu/issues/1292)) ([0bb7c02](https://github.com/lobu-ai/lobu/commit/0bb7c02f35662be65b502af611f3e4b43f2ea748))


### Code Refactoring

* **connectors:** remove cookie-cloning; move Revolut to extension ([#1258](https://github.com/lobu-ai/lobu/issues/1258)) ([eeab6fe](https://github.com/lobu-ai/lobu/commit/eeab6fe81467461fc817837273ea23294f5adb9d))

## [11.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.2.0...lobu-v11.3.0) (2026-06-12)


### Features

* **examples:** add personal-agent example; move Revolut out of built-in connectors ([#1168](https://github.com/lobu-ai/lobu/issues/1168)) ([2c98d2b](https://github.com/lobu-ai/lobu/commit/2c98d2b9d6252ba594e662019e628a491f4040aa))
* **memory:** guide the agent to supersede stored facts on update ([#1170](https://github.com/lobu-ai/lobu/issues/1170)) ([b39c61d](https://github.com/lobu-ai/lobu/commit/b39c61d12a8b32546ae978b3b2abe18b180a7dec))


### Bug Fixes

* **chart:** numeric runAsUser/UID so runAsNonRoot validates (prod 11.2.0 rollout wedge) ([#1228](https://github.com/lobu-ai/lobu/issues/1228)) ([da5ace1](https://github.com/lobu-ai/lobu/commit/da5ace1e84f749fdb70104a32a3b18413237c471))
* **deps:** bump vitest to ^3.2.6 (GHSA arbitrary file read via vitest UI server) ([#1230](https://github.com/lobu-ai/lobu/issues/1230)) ([570ef50](https://github.com/lobu-ai/lobu/commit/570ef50df604b8ccec6a43d070bd8081f257ddac))
* **orchestration:** kill the worker process group on teardown and bound the drain ([#1197](https://github.com/lobu-ai/lobu/issues/1197)) ([6193a9e](https://github.com/lobu-ai/lobu/commit/6193a9e2862c2738597a4aa15b7b5cf8a8843e77))
* **server:** remove dead api_type from query_sql allowlist ([#1226](https://github.com/lobu-ai/lobu/issues/1226)) ([99bde4a](https://github.com/lobu-ai/lobu/commit/99bde4a573450014d3aad84300af62e1bfde57a5))

## [11.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.1.0...lobu-v11.2.0) (2026-06-11)


### Features

* **connector-sdk:** auth-aware HTTP client and pagination helpers; nine connectors gain 429/5xx retry ([4f6a495](https://github.com/lobu-ai/lobu/commit/4f6a4950d9b09bba0f2be9325c33c73dcafc64b0))


### Bug Fixes

* **cli:** drop scaffolded node_modules in smoke gates so the workspace connector-sdk is under test ([#1223](https://github.com/lobu-ai/lobu/issues/1223)) ([3cc9cc8](https://github.com/lobu-ai/lobu/commit/3cc9cc8f2e4492e4aead9790f51fa24eb4c45b87)), closes [#1222](https://github.com/lobu-ai/lobu/issues/1222)
* **gateway:** resolve org-shared provider keys at the egress proxy ([#1215](https://github.com/lobu-ai/lobu/issues/1215)) ([3582ac0](https://github.com/lobu-ai/lobu/commit/3582ac0cd87d4dd39fbbff6d5910d4941ea25da2))
* **sentry:** classify provider auth hints; suppress only the readiness drain 503 ([#1218](https://github.com/lobu-ai/lobu/issues/1218)) ([6f89cad](https://github.com/lobu-ai/lobu/commit/6f89cadbc4f785b040fb80bb61bfb319ffa56fa8))
* **server:** enforce rate limits cluster-wide via Postgres (per-pod limiter multiplied limits by replica count) ([4f6a495](https://github.com/lobu-ai/lobu/commit/4f6a4950d9b09bba0f2be9325c33c73dcafc64b0))
* **server:** truthful vitest exit codes, fail-closed CI gate, and the 8 red integration tests ([#1220](https://github.com/lobu-ai/lobu/issues/1220)) ([0235681](https://github.com/lobu-ai/lobu/commit/023568100f97d8c9b13fa2bbe3660338d15ded04))
* **tests:** raise live-provider max_tokens so reasoning-default models aren't starved ([#1219](https://github.com/lobu-ai/lobu/issues/1219)) ([d500d89](https://github.com/lobu-ai/lobu/commit/d500d897874c071d93da5cf79567f71d01acd72b))

## [11.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v11.0.0...lobu-v11.1.0) (2026-06-11)


### Features

* **auth:** global login-provider baseline; drop default-org pointer ([#1183](https://github.com/lobu-ai/lobu/issues/1183)) ([a6ebbff](https://github.com/lobu-ai/lobu/commit/a6ebbffd6c3dd38c7825fbe7e23bef762870b3c9))
* **cli:** add --org override to lobu chat ([#1185](https://github.com/lobu-ai/lobu/issues/1185)) ([38aa4ab](https://github.com/lobu-ai/lobu/commit/38aa4aba9d582fbce9d17fa263484ec776eeeaa4))
* **connectors:** native Postgres connector — memory feeds, live pushdown, connection-backed derived entities ([#1182](https://github.com/lobu-ai/lobu/issues/1182)) ([aaebe15](https://github.com/lobu-ai/lobu/commit/aaebe152b4fbbbb5187a73bbc6de379b1f36d979))
* derived entity types (SQL-view backing) + measure inference ([#1161](https://github.com/lobu-ai/lobu/issues/1161)) ([73abb03](https://github.com/lobu-ai/lobu/commit/73abb03b06c47bee0c3113e6f4b11aa71b96a3d6))
* **landing:** add /schedule page + revamp 404 ([#1166](https://github.com/lobu-ai/lobu/issues/1166)) ([8812b2f](https://github.com/lobu-ai/lobu/commit/8812b2f840816159e372492a528625dc74a42111))
* **queue:** emit a failed-run metric and a durable dead-letter retention window ([#1201](https://github.com/lobu-ai/lobu/issues/1201)) ([c7fffa5](https://github.com/lobu-ai/lobu/commit/c7fffa566fa812e4f8088e3786ea62da79e2d23b))
* **sentry:** report worker provider/model failures + cut alert-feed noise ([#1186](https://github.com/lobu-ai/lobu/issues/1186)) ([39b8aa6](https://github.com/lobu-ai/lobu/commit/39b8aa60b63293a467d6978316cee47b97f65507))
* **server:** query-rewrite recall mode for read_knowledge ([#1187](https://github.com/lobu-ai/lobu/issues/1187)) ([a7c7784](https://github.com/lobu-ai/lobu/commit/a7c7784dbb74d9f645a1577fd62f3c15d2d60261))
* **watchers:** device CLI results flow through the shared complete_window pipeline ([#1196](https://github.com/lobu-ai/lobu/issues/1196)) ([78c95dd](https://github.com/lobu-ai/lobu/commit/78c95dd47acd32675c34bdee10b98017fe872728))


### Bug Fixes

* **apply:** surface schema-validation errors instead of misreporting them as duplicates ([#1211](https://github.com/lobu-ai/lobu/issues/1211)) ([c2bdde5](https://github.com/lobu-ai/lobu/commit/c2bdde5212d9d082a6cd3a5d67f8b29f22290df5))
* **cli:** document canonical dotted connector keys in scaffolded AGENTS.md ([#1209](https://github.com/lobu-ai/lobu/issues/1209)) ([4a6fd96](https://github.com/lobu-ai/lobu/commit/4a6fd96ddc58bc2fb883324d8e26d06f2fda16e1))
* **cli:** point community telemetry at the dedicated lobu-oss Sentry org ([#1208](https://github.com/lobu-ai/lobu/issues/1208)) ([3ae6f6e](https://github.com/lobu-ai/lobu/commit/3ae6f6eeb9e870609716e494b7efcc5a8d3db233))
* **connectors:** resolve connector SDK for metadata extraction in projects without node_modules ([#1214](https://github.com/lobu-ai/lobu/issues/1214)) ([a415355](https://github.com/lobu-ai/lobu/commit/a41535582d5719742c63db4e0f3b5efbc02b6ee7))
* correctness/security bugs from multi-agent audit (rebased onto main) ([#1202](https://github.com/lobu-ai/lobu/issues/1202)) ([56dc97d](https://github.com/lobu-ai/lobu/commit/56dc97d606f422e68b70bdc31cddd92bb3bfd550))
* **gateway:** deliver ask_user/tool-approval/link-button cards cross-replica ([#1194](https://github.com/lobu-ai/lobu/issues/1194)) ([dd47727](https://github.com/lobu-ai/lobu/commit/dd47727c0739b690f818177cf616151fe475c60b))
* **gateway:** stop forwarding content-length/hop-by-hop headers in secret-proxy; log real proxy errors ([#1210](https://github.com/lobu-ai/lobu/issues/1210)) ([a630cb2](https://github.com/lobu-ai/lobu/commit/a630cb21ca796b7cf6dc676c27bb63f43401cb39)), closes [#1176](https://github.com/lobu-ai/lobu/issues/1176)
* **guardrails:** execute skill-declared and agent-inline guardrails (wire the dead aggregator) ([#1200](https://github.com/lobu-ai/lobu/issues/1200)) ([440e660](https://github.com/lobu-ai/lobu/commit/440e6605338e3686992e2197d4fc6847eeddf5f7))
* **providers:** correct broken provider URLs + add e2e provider-integration coverage ([#1193](https://github.com/lobu-ai/lobu/issues/1193)) ([55aea18](https://github.com/lobu-ai/lobu/commit/55aea188f3652f506d2bfd418c67929d902f5550))
* **sdk:** correct search_sdk metadata + validate viewTemplates args ([#1184](https://github.com/lobu-ai/lobu/issues/1184)) ([36f41e2](https://github.com/lobu-ai/lobu/commit/36f41e2f9fac2b7301ccd6edc6813bf5dd988492))
* **security:** close critical access-control and injection gaps from codebase audit ([#1192](https://github.com/lobu-ai/lobu/issues/1192)) ([a784560](https://github.com/lobu-ai/lobu/commit/a7845601957e6257ac4bfe3ac15fcf2cd6aff83c))
* **sentry:** stop worker traces + cut server span sampling to fit the span quota ([#1207](https://github.com/lobu-ai/lobu/issues/1207)) ([9051f90](https://github.com/lobu-ai/lobu/commit/9051f9059ec523ec2a623221a3ae4002375681fd))
* **server:** accept rest as a first-class adapterless platform ([#1212](https://github.com/lobu-ai/lobu/issues/1212)) ([c8294bb](https://github.com/lobu-ai/lobu/commit/c8294bb62701465de556389be85091f3aee30391)), closes [#1179](https://github.com/lobu-ai/lobu/issues/1179)
* **server:** provision install operator + default org on external-DB lobu run ([#1213](https://github.com/lobu-ai/lobu/issues/1213)) ([e6cc6da](https://github.com/lobu-ai/lobu/commit/e6cc6da0b4d72607b6b128d7e06a90f22b98f98c))

## [11.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.2.0...lobu-v11.0.0) (2026-05-30)


### ⚠ BREAKING CHANGES

* **cli:** `lobu memory browser-auth --connector <key>` now launches a dedicated debug Chrome instead of copying cookies from your real Chrome profile. The `--chrome-profile` and `--launch-cdp` flags are removed (`--launch-cdp` was the path now always taken).

### Features

* **connector-sdk:** extensionDomScrape helper; use it in LinkedIn home_feed ([#1155](https://github.com/lobu-ai/lobu/issues/1155)) ([ef359c0](https://github.com/lobu-ai/lobu/commit/ef359c0726d79513ab64f4628a4609f4095ab9e6))
* **connectors:** add Hacker News front-page feed ([#1147](https://github.com/lobu-ai/lobu/issues/1147)) ([153f82a](https://github.com/lobu-ai/lobu/commit/153f82acc3768b3d3359b5b3408631e0d718e1c3))
* **infra:** alert on prod deploy failures (Flux + CI) ([#1130](https://github.com/lobu-ai/lobu/issues/1130)) ([b79e599](https://github.com/lobu-ai/lobu/commit/b79e5996fe92463ce3b6b725fee2f78d32eafe0a))
* **landing:** use-case-specific /for/ pages with collapsible code tabs ([#1134](https://github.com/lobu-ai/lobu/issues/1134)) ([51124de](https://github.com/lobu-ai/lobu/commit/51124de19bb10f52bce836878d6a81d988f86a09))
* LinkedIn end-to-end on Owletto Chrome extension (delete Playwright fallback) ([#1132](https://github.com/lobu-ai/lobu/issues/1132)) ([080a3a3](https://github.com/lobu-ai/lobu/commit/080a3a33da581b11dbed363ec0e07370ccd5df02))
* **linkedin:** home_feed via content-script scrape ([#1151](https://github.com/lobu-ai/lobu/issues/1151)) ([c9baa1a](https://github.com/lobu-ai/lobu/commit/c9baa1a699cf4648ccef756fc7c233b9d15a10fa))
* **server:** associate connections with entities (union with feeds) ([#1158](https://github.com/lobu-ai/lobu/issues/1158)) ([4fb67f7](https://github.com/lobu-ai/lobu/commit/4fb67f7e3009de3cfcf2d14c618fae46189fcba2))
* **server:** device workers can claim runs in orgs they're pinned to ([#1149](https://github.com/lobu-ai/lobu/issues/1149)) ([3f24eec](https://github.com/lobu-ai/lobu/commit/3f24eec66408640fa44577391683da276364df14))


### Bug Fixes

* **auth:** expose username in session so home routing is synchronous ([#1162](https://github.com/lobu-ai/lobu/issues/1162)) ([c5fee87](https://github.com/lobu-ai/lobu/commit/c5fee878762c3f194e90e9fcbf0471df71a6615e))
* **auth:** login requests only connector loginScopes, not sensitive connector scopes ([#1145](https://github.com/lobu-ai/lobu/issues/1145)) ([5bb81cd](https://github.com/lobu-ai/lobu/commit/5bb81cdbde20ca2f0a92b0ac4d1945edab6b93b3))
* **auth:** set username at signup + bump owletto (new-user org routing) ([#1160](https://github.com/lobu-ai/lobu/issues/1160)) ([fc6a6d4](https://github.com/lobu-ai/lobu/commit/fc6a6d4fece8eee5394817902a121b932573bcfa))
* **gateway:** allow Owletto extension origins through CORS ([#1116](https://github.com/lobu-ai/lobu/issues/1116)) ([449f93e](https://github.com/lobu-ai/lobu/commit/449f93e46ac73fcd2d5f69e2084a159e50d22e4a))
* **gateway:** route lobu chat to org's default agent end-to-end ([#1136](https://github.com/lobu-ai/lobu/issues/1136)) ([6c07546](https://github.com/lobu-ai/lobu/commit/6c075465eac397b3d5dbab391697e828ffd2e270))
* **linkedin:** home_feed author body-fallback + drop promoted/suggested/noise rows ([#1156](https://github.com/lobu-ai/lobu/issues/1156)) ([858e8e0](https://github.com/lobu-ai/lobu/commit/858e8e029c3df060dc76ebbc396bff0fba230683))
* **server,cli:** migrate external DATABASE_URL on `lobu run` + honor LOBU_DATA_DIR ([#1154](https://github.com/lobu-ai/lobu/issues/1154)) ([1d7d69f](https://github.com/lobu-ai/lobu/commit/1d7d69f0e0d993a58efce5584be3f3e0e7d52252))
* **server,db:** per-user pending oauth_account uniqueness + clean conflict errors ([#1121](https://github.com/lobu-ai/lobu/issues/1121)) ([8ec3a81](https://github.com/lobu-ai/lobu/commit/8ec3a8193d12a0faa2835a70904a946b459f42b2))
* **server:** clear field-missing errors on query_sdk/run_sdk ([#1131](https://github.com/lobu-ai/lobu/issues/1131)) ([5ef81b8](https://github.com/lobu-ai/lobu/commit/5ef81b8e94817af1344348fa9079dee87dd181ef))
* **server:** repair connections.entity_ids schema drift for query_sql ([#1157](https://github.com/lobu-ai/lobu/issues/1157)) ([4081c0a](https://github.com/lobu-ai/lobu/commit/4081c0a492f250ed69f6aaeb825d7ebed72901ef))
* **watchers,feeds:** guard id-less source queries and cross-org entity_ids ([#1146](https://github.com/lobu-ai/lobu/issues/1146)) ([f04469a](https://github.com/lobu-ai/lobu/commit/f04469af9686a3e7f923ed4fd88d2716f89dd9e4))


### Performance Improvements

* **auth:** don't block signup on the welcome email ([#1163](https://github.com/lobu-ai/lobu/issues/1163)) ([21443c0](https://github.com/lobu-ai/lobu/commit/21443c0e8115656c14b56aceac0e1f441447827b))
* **web:** critical-path XHR cuts + route code-splitting ([#1135](https://github.com/lobu-ai/lobu/issues/1135)) ([9c5a3ce](https://github.com/lobu-ai/lobu/commit/9c5a3ceb3143eee22b0a28e66dbf63432723e0c7))


### Code Refactoring

* **cli:** drop profile-cookie capture from browser-auth ([#1114](https://github.com/lobu-ai/lobu/issues/1114)) ([dea44b1](https://github.com/lobu-ai/lobu/commit/dea44b1a083bb93aaef74585fe51e6a95ece4814))

## [10.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.1.0...lobu-v10.2.0) (2026-05-28)


### Features

* **cli:** scaffold AGENTS.md as config-API guide; pure-CLI onboarding prompt; rest-platform validate fix ([#1110](https://github.com/lobu-ai/lobu/issues/1110)) ([25abc9f](https://github.com/lobu-ai/lobu/commit/25abc9feb8d4b06e80b045aea6f916a3a31657f4))
* **examples:** working npm-downloads custom connector for lobu-crm ([#1108](https://github.com/lobu-ai/lobu/issues/1108)) ([2db43f5](https://github.com/lobu-ai/lobu/commit/2db43f5ad2df646ed2a5d59dde6d65af50cba382))
* **landing:** outcome-first homepage, less code up front ([#1112](https://github.com/lobu-ai/lobu/issues/1112)) ([a1b1e4a](https://github.com/lobu-ai/lobu/commit/a1b1e4a5d7436222579d34d06e40020fdc487467))


### Bug Fixes

* **cli:** init --from-org declares only org-owned types, not public/system ([#1111](https://github.com/lobu-ai/lobu/issues/1111)) ([6bc689f](https://github.com/lobu-ai/lobu/commit/6bc689fc6343ebd5e7f6ecf0c4623cd4a3fc7767))
* **cli:** lobu apply falls back to npm when bun is missing ([#1115](https://github.com/lobu-ai/lobu/issues/1115)) ([b077b97](https://github.com/lobu-ai/lobu/commit/b077b97c1b5f7a35c4b1a167403a9db43733c13a))
* **cli:** scaffolded projects validate/run with zero install; slim skill; provider-id align; clean-test-pg target ([#1113](https://github.com/lobu-ai/lobu/issues/1113)) ([d72d49a](https://github.com/lobu-ai/lobu/commit/d72d49af7fed2cc57d969a731aa3408f247f199f))

## [10.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v10.0.0...lobu-v10.1.0) (2026-05-27)


### Features

* **gateway:** accept `/lobu link <code>` as a DM message, not only a slash command ([#1101](https://github.com/lobu-ai/lobu/issues/1101)) ([94d2db4](https://github.com/lobu-ai/lobu/commit/94d2db4d75fa5ed682b8a375a2b773848f957f5c))


### Bug Fixes

* **agent-worker:** force-end the turn after AskUser + cap runaway tool loops ([#1090](https://github.com/lobu-ai/lobu/issues/1090)) ([19e61de](https://github.com/lobu-ai/lobu/commit/19e61deadf50897e3ef814ebe9f5ebb6ae321103))
* **auth:** deliver the session cookie to the Owletto extension iframe (CHIPS) ([#1092](https://github.com/lobu-ai/lobu/issues/1092)) ([f779068](https://github.com/lobu-ai/lobu/commit/f779068bb8b63c027efada6bc84eac7fe7a5c5e1))
* garbled finalText under divergent-final ([#1099](https://github.com/lobu-ai/lobu/issues/1099)) ([5451e1f](https://github.com/lobu-ai/lobu/commit/5451e1f8c43f1fe9bb60c6b22cddfad738fa1f4c))
* **gateway:** hydrate connection on per-connection webhook under multi-replica ([#1098](https://github.com/lobu-ai/lobu/issues/1098)) ([9ce0716](https://github.com/lobu-ai/lobu/commit/9ce07168857f5262995689b187455764feda01a5))
* review follow-ups — AJV deep-traversal DoS guard, snake_case doc label, e2e test rigor ([#1100](https://github.com/lobu-ai/lobu/issues/1100)) ([2668147](https://github.com/lobu-ai/lobu/commit/26681474cc3778c259196e8f045ce9fb0de210bd))

## [10.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.4.1...lobu-v10.0.0) (2026-05-26)


### ⚠ BREAKING CHANGES

* **client:** AgentSession.agentId is renamed to conversationId.

### Features

* **client:** @lobu/client v1.1 — refresh(), ask(), typed SSE events, conversationId ([#1055](https://github.com/lobu-ai/lobu/issues/1055)) ([615cca6](https://github.com/lobu-ai/lobu/commit/615cca6d7b20b2fbdcf26c17f39e07260ac3d0b2)), closes [#1032](https://github.com/lobu-ai/lobu/issues/1032)
* **cli:** typed reactionFromFile() + connectorFromFile() for watchers and connectors ([#1082](https://github.com/lobu-ai/lobu/issues/1082)) ([91d2c08](https://github.com/lobu-ai/lobu/commit/91d2c084ae0a5f5f554553f1ecf16cacf029121f))
* **connect:** managed-connector full integration — login-scoped fetch, consent deep-link, local feeds ([#1049](https://github.com/lobu-ai/lobu/issues/1049)) ([6e2a94b](https://github.com/lobu-ai/lobu/commit/6e2a94b59c9f6148e4dc1d7d12ad124585f5a91e))
* **landing:** config-first homepage on a single sales example ([#1076](https://github.com/lobu-ai/lobu/issues/1076)) ([9615eff](https://github.com/lobu-ai/lobu/commit/9615eff24c3029da1d89ea637d8734c2d87ab6bb))
* **reactions:** notify from reactions + repair the bot-delivery path ([#1064](https://github.com/lobu-ai/lobu/issues/1064)) ([2011695](https://github.com/lobu-ai/lobu/commit/20116958537e3e1b836e65f8baa986a5502f177d))
* **server,cli:** auth.md discovery + lobu login --email headless claim ([#1073](https://github.com/lobu-ai/lobu/issues/1073)) ([56fbe94](https://github.com/lobu-ai/lobu/commit/56fbe949e8d47fbe1553bf6cd65c5612d3cefb39))
* **server:** agent account-claim via emailed device authorization ([#1071](https://github.com/lobu-ai/lobu/issues/1071)) ([6889f8f](https://github.com/lobu-ai/lobu/commit/6889f8f1ec5ccb32e75f8b0bb245c88544592234))
* **server:** informed consent for agent user_claimed flow ([#1081](https://github.com/lobu-ai/lobu/issues/1081)) ([48cd6ea](https://github.com/lobu-ai/lobu/commit/48cd6ea456d531e6b7b31bf8430894d7ab7ffa1c))
* **server:** ship watcher current-version prompt in device poll payload ([#1088](https://github.com/lobu-ai/lobu/issues/1088)) ([073cf8d](https://github.com/lobu-ai/lobu/commit/073cf8dc87cadf856c06d93ae9e39edc139e9cbd))
* **server:** tunable per-watcher execution_config for device-worker runs ([#1058](https://github.com/lobu-ai/lobu/issues/1058)) ([9bd5d10](https://github.com/lobu-ai/lobu/commit/9bd5d10a5073d9daaf7e3b2a0e627692d92561d5))


### Bug Fixes

* **agent-worker:** log the failure reason when a worker run fails ([#1078](https://github.com/lobu-ai/lobu/issues/1078)) ([6eb19f4](https://github.com/lobu-ai/lobu/commit/6eb19f4c926b5d838daf35370dfd078e9c52dd87))
* **agent-worker:** strip provider self-prefix AFTER auto-resolution (close gap) ([#1085](https://github.com/lobu-ai/lobu/issues/1085)) ([217367e](https://github.com/lobu-ai/lobu/commit/217367e40db646464e9bea7459a9c0851d423dfb))
* **agent-worker:** strip redundant provider self-prefix from model code ([#1083](https://github.com/lobu-ai/lobu/issues/1083)) ([6aa3e96](https://github.com/lobu-ai/lobu/commit/6aa3e96c1f68533d5d989e12ece695341e615ea6))
* **agent-worker:** worker bash secret leak, SESSION_TIMEOUT UX, dead sandbox-leak redaction ([#1070](https://github.com/lobu-ai/lobu/issues/1070)) ([12ec940](https://github.com/lobu-ai/lobu/commit/12ec9400259b4c1fd396c84b6bdd3a93b3910ea3))
* **cli:** token create honors --context/-c flag ([#1023](https://github.com/lobu-ai/lobu/issues/1023)) ([#1054](https://github.com/lobu-ai/lobu/issues/1054)) ([26efe00](https://github.com/lobu-ai/lobu/commit/26efe00abd41166e617418d66aebd299f368e869))
* **embeddings:** stamp legacy embedding_model + stop liveness probe killing the embeddings service ([#1080](https://github.com/lobu-ai/lobu/issues/1080)) ([b9ba6c9](https://github.com/lobu-ai/lobu/commit/b9ba6c9db4b665eccd99b377fda076999a5f547f))
* **embeddings:** version-stamp embeddings and batch the sync embed path ([#1069](https://github.com/lobu-ai/lobu/issues/1069)) ([e8c354b](https://github.com/lobu-ai/lobu/commit/e8c354bf7fd8ff481041c92078170f4c249fe894))
* **examples:** use valid event kinds in lobu-crm reactions ([#1072](https://github.com/lobu-ai/lobu/issues/1072)) ([a680342](https://github.com/lobu-ai/lobu/commit/a68034281f143c0ad3e445837c9715bf50bf5a22))
* four small confirmed findings (token timing, apply provider keys, worker probes, dead AsyncLock) ([#1066](https://github.com/lobu-ai/lobu/issues/1066)) ([96a6df7](https://github.com/lobu-ai/lobu/commit/96a6df706f2cf303ff706a189b775ba4e7eb40ab))
* **gateway:** deliver Slack reply from worker finalText under multi-replica ([#1087](https://github.com/lobu-ai/lobu/issues/1087)) ([6741aed](https://github.com/lobu-ai/lobu/commit/6741aed2b88e37097fdf1b1492d9c53a71b809a5))
* **server:** orchestration cleanup — dead dischargeTurn + cross-pod spawn gate ([#1068](https://github.com/lobu-ai/lobu/issues/1068)) ([7bf6d8a](https://github.com/lobu-ai/lobu/commit/7bf6d8afb27fb8e88b3f7b0ad89dc69313564012))
* **server:** resolve Slack OAuth/preview config from env, not pod-local instance ([#1065](https://github.com/lobu-ai/lobu/issues/1065)) ([56b6cff](https://github.com/lobu-ai/lobu/commit/56b6cffe32fcd1fc7432f9faaaf1981a4bd68df3))
* **server:** watcher device-pin authz + table-schema drift test runs in CI ([#1062](https://github.com/lobu-ai/lobu/issues/1062)) ([75c52a0](https://github.com/lobu-ai/lobu/commit/75c52a02b22e192fa3bc11fc506638cf28bc0c9c))

## [9.4.1](https://github.com/lobu-ai/lobu/compare/lobu-v9.4.0...lobu-v9.4.1) (2026-05-25)


### Bug Fixes

* **chart+metrics:** ServiceMonitor path /lobu/metrics + rename label job→task ([#1053](https://github.com/lobu-ai/lobu/issues/1053)) ([a5c3de6](https://github.com/lobu-ai/lobu/commit/a5c3de6d713d4d14a3ef31faddd17ffa22882a64))

## [9.4.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.3.0...lobu-v9.4.0) (2026-05-25)


### Features

* **agent-worker:** support before_tool_call/after_tool_call plugin hooks ([#1036](https://github.com/lobu-ai/lobu/issues/1036)) ([846d173](https://github.com/lobu-ai/lobu/commit/846d173943d14b1b4c6e4aba875ef97941d7fca9)), closes [#1022](https://github.com/lobu-ai/lobu/issues/1022)
* **cli:** inline skills via defineSkill/skillFromFile; drop dir auto-discovery ([#1039](https://github.com/lobu-ai/lobu/issues/1039)) ([5e488ce](https://github.com/lobu-ai/lobu/commit/5e488ce5e52366263e421c3c9c019860b98cef51))
* **connect:** managed connectors via public org — cloud auth, local data ([#1038](https://github.com/lobu-ai/lobu/issues/1038)) ([cae142a](https://github.com/lobu-ai/lobu/commit/cae142a32adc71aeb6c31d485ba8ae6fc933b26b))
* **server:** watcher/scheduler health metrics + ServiceMonitor/PrometheusRule ([#1047](https://github.com/lobu-ai/lobu/issues/1047)) ([60c6e73](https://github.com/lobu-ai/lobu/commit/60c6e73618c4ef0ba15918e24111f72723de6377))


### Bug Fixes

* **ci:** migrate sdk-e2e fixture to connectorFromFile ([#1043](https://github.com/lobu-ai/lobu/issues/1043) dropped ./connectors scan) ([#1048](https://github.com/lobu-ai/lobu/issues/1048)) ([d8454a9](https://github.com/lobu-ai/lobu/commit/d8454a983a8d0275cf522b683f76bf056fb31885))
* **cli:** doctor recognizes embedded file:// Postgres; quiet bundled-SPA Vite log ([#1033](https://github.com/lobu-ai/lobu/issues/1033)) ([0b53bd9](https://github.com/lobu-ai/lobu/commit/0b53bd92987134d9fc24970b85492bb2dc11961d))
* **release:** pass --manual-override-reason to ClawHub publish ([#1030](https://github.com/lobu-ai/lobu/issues/1030)) ([1e9fe29](https://github.com/lobu-ai/lobu/commit/1e9fe290f462476fb8b80eb1b1840c21584d1899))
* **server:** unwedge watchers (array-binding bug) + hardening ([#1046](https://github.com/lobu-ai/lobu/issues/1046)) ([c524b42](https://github.com/lobu-ai/lobu/commit/c524b428806a787d121002b05443aa8c8fc81cf0))
* **test:** ephemeral embedded backend uses a lobu_test database ([#1050](https://github.com/lobu-ai/lobu/issues/1050)) ([2be43e0](https://github.com/lobu-ai/lobu/commit/2be43e0f431deff5fd8e217b00e367b74ba8a43a))
* **worker:** copy packages/core into worker runtime image ([#1035](https://github.com/lobu-ai/lobu/issues/1035)) ([3d9175c](https://github.com/lobu-ai/lobu/commit/3d9175c558ee413d40e49eaf0b65fc08900a886d))

## [9.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.2.0...lobu-v9.3.0) (2026-05-24)


### Features

* **cli:** fold @lobu/sdk into @lobu/cli/config ([#1026](https://github.com/lobu-ai/lobu/issues/1026)) ([06f3432](https://github.com/lobu-ai/lobu/commit/06f3432f4b0fb98693a93ef4982528950d298f2d))

## [9.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.1.1...lobu-v9.2.0) (2026-05-23)


### Features

* **auth:** local sign-in passcode + /api/local-passcode (web/mac rework) ([#999](https://github.com/lobu-ai/lobu/issues/999)) ([7799c21](https://github.com/lobu-ai/lobu/commit/7799c211ba59a111292e913f6e03095ee18c731d))
* **client:** add TypeScript SDK ([#1015](https://github.com/lobu-ai/lobu/issues/1015)) ([3993aad](https://github.com/lobu-ai/lobu/commit/3993aad2b29ed806553f0fd9dd26e4e8d4c25099))


### Bug Fixes

* **cli:** honor local context for memory and token auth ([#1011](https://github.com/lobu-ai/lobu/issues/1011)) ([176a3f1](https://github.com/lobu-ai/lobu/commit/176a3f13ecb1b566a80b87e526e9fb665707dc76)), closes [#1008](https://github.com/lobu-ai/lobu/issues/1008)
* **cli:** warn when apply ignores connectors ([#1010](https://github.com/lobu-ai/lobu/issues/1010)) ([0b145cd](https://github.com/lobu-ai/lobu/commit/0b145cda338fcc535525cb6762061349b4186d77)), closes [#1009](https://github.com/lobu-ai/lobu/issues/1009)
* **connectors:** serve catalog from a build-time manifest, stop cold-scan 503s ([#1013](https://github.com/lobu-ai/lobu/issues/1013)) ([4e5db74](https://github.com/lobu-ai/lobu/commit/4e5db742b4fe49c885058b0b9c6f1f63ea0f81ea))
* **server:** heartbeat-aware reaping for orphaned watcher runs ([#1020](https://github.com/lobu-ai/lobu/issues/1020)) ([a0a15b9](https://github.com/lobu-ai/lobu/commit/a0a15b91fc03b6b4dab08fe41d52a3d33ae003c5))
* **server:** register local device-worker capabilities even when poll is anonymous ([#1017](https://github.com/lobu-ai/lobu/issues/1017)) ([463a5a4](https://github.com/lobu-ai/lobu/commit/463a5a4b688e84228659006c25bc713136899d5e))

## [9.1.1](https://github.com/lobu-ai/lobu/compare/lobu-v9.1.0...lobu-v9.1.1) (2026-05-21)


### Bug Fixes

* **cli:** build pgvector-embedded in the publish chain so it vendors into the tarball ([#1003](https://github.com/lobu-ai/lobu/issues/1003)) ([850e21a](https://github.com/lobu-ai/lobu/commit/850e21adaee4ae3f5575a5d6b9ef314b45ea8d91))

## [9.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v9.0.0...lobu-v9.1.0) (2026-05-21)


### Bug Fixes

* **cli:** vendor private @lobu/pgvector-embedded into the CLI tarball ([#1000](https://github.com/lobu-ai/lobu/issues/1000)) ([d8634e0](https://github.com/lobu-ai/lobu/commit/d8634e0998045d88d2fec359dfbb023443500951))

## [9.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v8.0.0...lobu-v9.0.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* **server:** the local `lobu run` / test database engine is now a real embedded PostgreSQL instead of PGlite. Existing ~/.lobu PGlite data dirs are not migrated — a fresh embedded PG cluster is created. Production (external Postgres via DATABASE_URL) is unchanged.

### Features

* **cli:** flatten Lobu context config ([#955](https://github.com/lobu-ai/lobu/issues/955)) ([50dd706](https://github.com/lobu-ai/lobu/commit/50dd706d736af268dffed8b1c92c33ac3e2d093b))
* **cli:** lobu call — generic dispatcher over admin REST tools ([#938](https://github.com/lobu-ai/lobu/issues/938)) ([17f0da9](https://github.com/lobu-ai/lobu/commit/17f0da929293444d6393770ba0e13398cd263b52))
* **cli:** ship the owletto web UI bundle in lobu run ([#985](https://github.com/lobu-ai/lobu/issues/985)) ([2439747](https://github.com/lobu-ai/lobu/commit/2439747c7ee2269f92d59e49930e337d56ae3ab3))
* **connectors:** user-declared connector dependencies (npm bundled + nix native) ([#973](https://github.com/lobu-ai/lobu/issues/973)) ([ac2ddbd](https://github.com/lobu-ai/lobu/commit/ac2ddbd5a379ee1f6808fa8db57d9bc533adcbf4))
* **landing:** dev-focused rebuild — pinned examples, animated architecture, real cast ([#945](https://github.com/lobu-ai/lobu/issues/945)) ([8695c57](https://github.com/lobu-ai/lobu/commit/8695c57c51c917b830412571265becd1b0300a37))
* **landing:** per-use-case snippet tabs, connector logo wall, drop asciinema, simplify nav ([#988](https://github.com/lobu-ai/lobu/issues/988)) ([ca889c6](https://github.com/lobu-ai/lobu/commit/ca889c6242429ed4c9fb84c9946ce64cca1c6ceb))
* local review tool (make review) — shadow-mode multi-axis verdict ([#942](https://github.com/lobu-ai/lobu/issues/942)) ([dfb4958](https://github.com/lobu-ai/lobu/commit/dfb4958f0ee31a5a5cabcf2ea55aa657c9f5e1a5))
* **server:** generalize list_runs for connection/device/feed run tables ([#963](https://github.com/lobu-ai/lobu/issues/963)) ([68cefde](https://github.com/lobu-ai/lobu/commit/68cefde3404238af906d0e7fc3362c1e036c2208))
* **server:** PGlite-mode parity with Postgres for Agent API ([#940](https://github.com/lobu-ai/lobu/issues/940)) ([cb2a6f1](https://github.com/lobu-ai/lobu/commit/cb2a6f1cf5fd797e03f3174d07fb274ecf831d1a))
* **server:** replace PGlite with embedded Postgres; bundle pgvector; earthdistance geo ([#965](https://github.com/lobu-ai/lobu/issues/965)) ([7793c56](https://github.com/lobu-ai/lobu/commit/7793c5605d7cb223983e3f161c69b425741916d4))


### Bug Fixes

* **auth:** unwedge PGlite sign-up by routing single-user guard through the transaction adapter ([#952](https://github.com/lobu-ai/lobu/issues/952)) ([521e6f7](https://github.com/lobu-ai/lobu/commit/521e6f7eee31e89059f987cf673a496ee2188f63))
* **ci:** expose ClawHub token flag to login step ([03160db](https://github.com/lobu-ai/lobu/commit/03160db2d101c8f7522b8f5c47a371b09d8abffc)), closes [#953](https://github.com/lobu-ai/lobu/issues/953)
* **cli/server:** zero-to-chat local-dev flow works without --org or browser sign-in ([#944](https://github.com/lobu-ai/lobu/issues/944)) ([e6f201b](https://github.com/lobu-ai/lobu/commit/e6f201b98191607881f614b3e6dfa868bd1dbc0c))
* **gateway:** surface worker failures to chat clients as terminal errors ([#946](https://github.com/lobu-ai/lobu/issues/946)) ([#971](https://github.com/lobu-ai/lobu/issues/971)) ([c8553c1](https://github.com/lobu-ai/lobu/commit/c8553c1a57fbb86beb95e354ae99da04c4282965))
* getting-started reliability (openrouter model routing + run auto-apply) ([#987](https://github.com/lobu-ai/lobu/issues/987)) ([86b3f17](https://github.com/lobu-ai/lobu/commit/86b3f17b4100d2f6a099dd2144e265350e795a8f))
* prevent prod data wipe — non-destructive baseline down + test-DB guard ([#989](https://github.com/lobu-ai/lobu/issues/989)) ([df38fbf](https://github.com/lobu-ai/lobu/commit/df38fbf48b34ee7e73fe30d4705ec0cdb6aac6af))
* **providers:** reliable routing for all config-driven LLM providers ([#992](https://github.com/lobu-ai/lobu/issues/992)) ([ada2219](https://github.com/lobu-ai/lobu/commit/ada2219767c32a356e3113f39e6ff5041a4c962b))
* remove redundant getDb dynamic imports and fix $member entity FK violation ([#957](https://github.com/lobu-ai/lobu/issues/957) [#956](https://github.com/lobu-ai/lobu/issues/956)) ([#959](https://github.com/lobu-ai/lobu/issues/959)) ([9e61edd](https://github.com/lobu-ai/lobu/commit/9e61eddc5eda1d87dda8251ccdec92149b9b46ce))
* **server:** apply takes effect without lobu run restart ([#993](https://github.com/lobu-ai/lobu/issues/993)) ([3012104](https://github.com/lobu-ai/lobu/commit/301210475c57916fb821708547d942d00f8865af))
* **start-local:** close 7 PGlite/Postgres parity-hygiene risks ([#943](https://github.com/lobu-ai/lobu/issues/943)) ([e80f0c2](https://github.com/lobu-ai/lobu/commit/e80f0c2ad1a166a1ae7db2260d93c8de35ce2ffa))
* **test:** tolerate non-owner of schema public in setupTestDatabase ([#961](https://github.com/lobu-ai/lobu/issues/961)) ([1600bc4](https://github.com/lobu-ai/lobu/commit/1600bc461ed3b958e7cd3f31c49b4af61327c475))

## [8.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.2.0...lobu-v8.0.0) (2026-05-19)


### ⚠ BREAKING CHANGES

* **core:** drop unused module-lifecycle public types; consolidate wire + session-file utilities ([#930](https://github.com/lobu-ai/lobu/issues/930))
* **evals:** The in-house `lobu eval` command and YAML eval schema are removed. Migrate evals to promptfoo + @lobu/promptfoo-provider; see examples/personal-finance/evals/promptfooconfig.yaml for the new pattern.

### Features

* **auth:** install_operator bootstrap — unblock headless installs ([#923](https://github.com/lobu-ai/lobu/issues/923)) ([2a903fd](https://github.com/lobu-ai/lobu/commit/2a903fd99ddc41a2fe6a864c33806fe674e53f5e))
* **connector-sdk:** FileSystemSource primitive for filesystem-shape ingestion ([#933](https://github.com/lobu-ai/lobu/issues/933)) ([7cced39](https://github.com/lobu-ai/lobu/commit/7cced3953f977d0787acda30d8bd03cd923362e7))
* **core:** drop unused module-lifecycle public types; consolidate wire + session-file utilities ([#930](https://github.com/lobu-ai/lobu/issues/930)) ([27fbece](https://github.com/lobu-ai/lobu/commit/27fbeceaa9792ecf8aa01eba4c3d5b91b5083518))
* **evals:** drop in-house YAML runner, ship @lobu/promptfoo-provider ([#911](https://github.com/lobu-ai/lobu/issues/911)) ([f8f087b](https://github.com/lobu-ai/lobu/commit/f8f087bca8f503f12158ff5fd6ece7739021fb6d))
* **gateway:** tool_use SSE events for client-side trace inspection ([#918](https://github.com/lobu-ai/lobu/issues/918)) ([dcb5b1d](https://github.com/lobu-ai/lobu/commit/dcb5b1d8ba6ac7b76ec108156d260740540fd8b7))
* guardrails schema extensions + judge engine + pii-scan ([#915](https://github.com/lobu-ai/lobu/issues/915)) ([ef48a3d](https://github.com/lobu-ai/lobu/commit/ef48a3dbc0c8ccd0c2690d3b1ced5a787c35c8f2))
* local-first polish — magic-link gating, task-use bug, no_user_yet route + SPA copy ([#909](https://github.com/lobu-ai/lobu/issues/909)) ([125fb6b](https://github.com/lobu-ai/lobu/commit/125fb6b5faaf7ebd9bf288d7104ae94983699551))
* make bump shortcut + "main checkout read-only" doctrine ([#928](https://github.com/lobu-ai/lobu/issues/928)) ([57cd312](https://github.com/lobu-ai/lobu/commit/57cd3123faec5c1c5db416ae0a05bfefcc9c6aff))
* passkey (WebAuthn) auth + auth-config flags for local-mode routing ([#905](https://github.com/lobu-ai/lobu/issues/905)) ([54de2e0](https://github.com/lobu-ai/lobu/commit/54de2e0d365f8de22fbf564f0c43c6272583ea8a))
* **promptfoo-provider:** vars.transcript multi-turn + migrate 4 personal-finance evals ([#913](https://github.com/lobu-ai/lobu/issues/913)) ([69151a9](https://github.com/lobu-ai/lobu/commit/69151a9d98013cf4bb85e5cad825c3d87ce7e3b1))
* **promptfoo-provider:** vars.transcript multi-turn + migrate 4 personal-finance evals ([#921](https://github.com/lobu-ai/lobu/issues/921)) ([9453f37](https://github.com/lobu-ai/lobu/commit/9453f3747a250d91faa2e3f0ce9da3b8cd996a6e))
* **server,chrome-ext:** mint session_token alongside child PAT for native auto-pair ([#896](https://github.com/lobu-ai/lobu/issues/896)) ([a675eeb](https://github.com/lobu-ai/lobu/commit/a675eeb233b3416812fd68731b66dfb94fde5af8))
* **server:** drop bootstrap-user, first /sign-up becomes the install's identity ([#902](https://github.com/lobu-ai/lobu/issues/902)) ([f6522b3](https://github.com/lobu-ai/lobu/commit/f6522b3923cb025831d4715658159713c39775b8))
* **server:** local-first identity + single-user mode for bootstrap ([#898](https://github.com/lobu-ai/lobu/issues/898)) ([aa5a71f](https://github.com/lobu-ai/lobu/commit/aa5a71f7c5595cf510757de5c76c439ec9a65cc5))
* wire guardrails runtime end-to-end + secret-scan and forbidden-tools built-ins ([#919](https://github.com/lobu-ai/lobu/issues/919)) ([a66c00d](https://github.com/lobu-ai/lobu/commit/a66c00d3a61a3c0e9d5e31114d4c44e522702b73))


### Bug Fixes

* **build:** drop examples/personal-finance from root workspaces — unblock image builds ([#927](https://github.com/lobu-ai/lobu/issues/927)) ([8932729](https://github.com/lobu-ai/lobu/commit/89327292eace0e477f49f90726240d489f2b2296))
* **cli:** task-setup resolves repo via git-common-dir, not script cwd ([#899](https://github.com/lobu-ai/lobu/issues/899)) ([8e26abd](https://github.com/lobu-ai/lobu/commit/8e26abd691e4d729d7eaecf71da63eaa7cfad100))
* **cli:** task-setup uses --path-format=absolute for git-common-dir ([#900](https://github.com/lobu-ai/lobu/issues/900)) ([f200751](https://github.com/lobu-ai/lobu/commit/f200751c5dbcbc97246e3b561bfcae96b6bc5cd7))
* **sync:** wire embedded feed-sync executor + workers/poll RangeError ([#929](https://github.com/lobu-ai/lobu/issues/929)) ([9b1d40b](https://github.com/lobu-ai/lobu/commit/9b1d40b2776dc045c163af5b779f89d28b0fd50f))

## [7.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.1.0...lobu-v7.2.0) (2026-05-18)


### Features

* **chart:** real-worker smoke test gates Helm upgrades on actual run completion ([#878](https://github.com/lobu-ai/lobu/issues/878)) ([48ee1ed](https://github.com/lobu-ai/lobu/commit/48ee1ed23b3190c694e945556255bc4fc5d4efbe))
* **cli,server:** LOBU_CONTEXT + lifecycle tag, bump owletto submodule ([#889](https://github.com/lobu-ai/lobu/issues/889)) ([137d8fe](https://github.com/lobu-ai/lobu/commit/137d8fea2de847f500e1f382d06b65f6d7442b52))
* **cli:** task-setup.sh + per-worktree context registration ([#891](https://github.com/lobu-ai/lobu/issues/891)) ([a8e4a35](https://github.com/lobu-ai/lobu/commit/a8e4a358ada6aeb697e3d82bd83a32947e4c6335))
* **connector-worker,server:** heartbeat action+embed_backfill, atomic reaper retries ([#893](https://github.com/lobu-ai/lobu/issues/893)) ([568f989](https://github.com/lobu-ai/lobu/commit/568f9892e52f2673eb9c81852333dd95d913d4e9))
* **connectors:** chrome connector — tool dispatcher v1 ([#872](https://github.com/lobu-ai/lobu/issues/872)) ([6b2a32b](https://github.com/lobu-ai/lobu/commit/6b2a32b40ab716306e740d5f3420970d6d3d025e))
* **mac-release:** auto-fire on release-please published releases ([#895](https://github.com/lobu-ai/lobu/issues/895)) ([4c16f1b](https://github.com/lobu-ai/lobu/commit/4c16f1b46ee8027d8d59b6527d7ec051e93d2643))
* **mac-release:** Developer ID signing + Owletto rebrand + submodule bump ([#894](https://github.com/lobu-ai/lobu/issues/894)) ([d3591b1](https://github.com/lobu-ai/lobu/commit/d3591b1b8c42735bc03c4d2609634da576de04ad))
* **operations:** async device-action scheduling for chrome / device-bound connectors ([#879](https://github.com/lobu-ai/lobu/issues/879)) ([c3d7aad](https://github.com/lobu-ai/lobu/commit/c3d7aad4a26a2cb005c987f947074338379267db))
* **server,chart:** flip snapshot default + drop workspaces PVC (Phase 5) ([#871](https://github.com/lobu-ai/lobu/issues/871)) ([9484be3](https://github.com/lobu-ai/lobu/commit/9484be39ed2cbc31a9688ac2a99cd92676081ebb))
* **server:** broaden CSP frame-ancestors to allow owletto extension to embed the whole app ([#884](https://github.com/lobu-ai/lobu/issues/884)) ([458f37e](https://github.com/lobu-ai/lobu/commit/458f37eab898efc09c1b76e9ed2c1c9773e9d954))
* **worker:** PG-backed agent_transcript_snapshot (multi-replica unblock) ([#865](https://github.com/lobu-ai/lobu/issues/865)) ([8d1beee](https://github.com/lobu-ai/lobu/commit/8d1beeedd3540baef99237079536cc951fc9075f))


### Bug Fixes

* **agent-worker:** propagate runId + runJobToken through JobEventSchema ([#874](https://github.com/lobu-ai/lobu/issues/874)) ([d6b3b68](https://github.com/lobu-ai/lobu/commit/d6b3b68c80092cf53f86088ae9f26136963ee6ad))
* **reaper:** narrow stale-run reaper to lanes that actually heartbeat (sync + auth) ([#859](https://github.com/lobu-ai/lobu/issues/859)) ([cc4dbe3](https://github.com/lobu-ai/lobu/commit/cc4dbe36632728e64559d4cdfaec9ef67e8eb46a))
* **server:** close SSE bridge registration-order races + wire abort into MCP heartbeat ([#864](https://github.com/lobu-ai/lobu/issues/864)) ([110c046](https://github.com/lobu-ai/lobu/commit/110c0461d1dce6e105590f269fafff8c93c09e2c))
* **server:** handle action_input JSONB-string shape + write JSONB objects for new runs ([#877](https://github.com/lobu-ai/lobu/issues/877)) ([683481c](https://github.com/lobu-ai/lobu/commit/683481c654b8ba5a99f4cfc5cabe434c667b8470))
* **server:** inject organizationId from worker token onto worker-response payloads (4th writer) ([#888](https://github.com/lobu-ai/lobu/issues/888)) ([cd31882](https://github.com/lobu-ai/lobu/commit/cd3188231ce67a01ca22476e531f6173ad1e97db))
* **server:** pass organizationId on continuation chat_message enqueues ([#887](https://github.com/lobu-ai/lobu/issues/887)) ([7cfeac6](https://github.com/lobu-ai/lobu/commit/7cfeac6c5f7302a6a160deba64cb2ee43e11852b))
* **server:** post-review cleanup of multi-tenant isolation + pending interactions ([#867](https://github.com/lobu-ai/lobu/issues/867)) ([907bdd8](https://github.com/lobu-ai/lobu/commit/907bdd88411fe6d515413b629627bf66b9c7dd0d))
* **server:** restore organization_id INSERT in runs-queue ([#883](https://github.com/lobu-ai/lobu/issues/883)) ([0c32c18](https://github.com/lobu-ai/lobu/commit/0c32c1816d8def0063117ff8258a86f4df8386e1))
* **server:** wrap connection-boot secret resolution in orgContext to fix Slack ([#881](https://github.com/lobu-ai/lobu/issues/881)) ([ad75eb9](https://github.com/lobu-ai/lobu/commit/ad75eb9fc138ce0935b917165e2edd3483fdbe65))


### Performance Improvements

* **server:** denormalize runs.agent_id+conversation_id + reserve-connection cap ([#870](https://github.com/lobu-ai/lobu/issues/870)) ([d4691a7](https://github.com/lobu-ai/lobu/commit/d4691a73a7678e7c2555e01ea315a4b9a0b1d37e))

## [7.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v7.0.0...lobu-v7.1.0) (2026-05-18)


### Features

* **apply:** org-shared provider keys end-to-end ([#740](https://github.com/lobu-ai/lobu/issues/740)) ([1da480d](https://github.com/lobu-ai/lobu/commit/1da480d0234166e1f7e6457bf5cf88111fc2ca9d))
* **apply:** watcher admin-only fields + lobu export + examples roll-out ([#829](https://github.com/lobu-ai/lobu/issues/829)) ([d43df65](https://github.com/lobu-ai/lobu/commit/d43df658e85625bdd449c4e8f2fa44d3ce5fd918))
* **auth-profiles:** admin-pinned default app profile per connector ([#764](https://github.com/lobu-ai/lobu/issues/764)) ([71e9b0f](https://github.com/lobu-ai/lobu/commit/71e9b0f0b86d8f374aee525e7b134b470f881fbe))
* **auth:** cookie pivot — drop bootstrap-pat.txt, add /api/auth/local-init ([#830](https://github.com/lobu-ai/lobu/issues/830)) ([9b842cd](https://github.com/lobu-ai/lobu/commit/9b842cdf5f2acf35db81f9a38b0281f03e355298))
* **chart:** auto-pick RollingUpdate when workspaces is RWX ([#776](https://github.com/lobu-ai/lobu/issues/776)) ([e98e1ea](https://github.com/lobu-ai/lobu/commit/e98e1eab1464a2da77464927344657316c1fd6d3))
* **chart:** expose service.sessionAffinity for multi-replica SSE stickiness ([#848](https://github.com/lobu-ai/lobu/issues/848)) ([7fc36dc](https://github.com/lobu-ai/lobu/commit/7fc36dcabe104e7521dc5065d84e5e883ff3d8c6))
* **chrome-extension:** MV3 connector with auto-pair via Mac native messaging ([#773](https://github.com/lobu-ai/lobu/issues/773)) ([9d06663](https://github.com/lobu-ai/lobu/commit/9d06663fd03b34c4164e9b3099638692ba592a1c))
* **connections:** action_modes tri-state — disabled / approval / auto ([#727](https://github.com/lobu-ai/lobu/issues/727)) ([7fe865e](https://github.com/lobu-ai/lobu/commit/7fe865ee083a01efed9bafed77a66d505864ae9a))
* **connectors:** browser.evaluate connector + owletto submodule bump ([#828](https://github.com/lobu-ai/lobu/issues/828)) ([d159443](https://github.com/lobu-ai/lobu/commit/d159443fad30e8426d30fbb946d65b884612e086))
* **geo:** server-side reverse-geocoding via PostGIS + GeoNames ([#738](https://github.com/lobu-ai/lobu/issues/738)) ([0dc0973](https://github.com/lobu-ai/lobu/commit/0dc097374334249593db70ca71041a4c7087eb6d))
* **infra:** postgis-enabled CNPG Postgres image for geo enrichment ([#749](https://github.com/lobu-ai/lobu/issues/749)) ([bc721e5](https://github.com/lobu-ai/lobu/commit/bc721e548428d074949296c11e5dd447296875df))
* **knowledge:** filter content by feed_ids / run_ids / connection_ids ([#722](https://github.com/lobu-ai/lobu/issues/722)) ([584a6af](https://github.com/lobu-ai/lobu/commit/584a6af2d96d1309478558f276f9392ce3d32f0a))
* **landing:** product-named stage tabs + copy-prompt CTA + audit follow-ups ([#743](https://github.com/lobu-ai/lobu/issues/743)) ([fe896ea](https://github.com/lobu-ai/lobu/commit/fe896eaa3b332381a528a961f9e8985c79c6702a))
* **landing:** rebuild hero preview to v2 + simplify sections ([#737](https://github.com/lobu-ai/lobu/issues/737)) ([cf392f7](https://github.com/lobu-ai/lobu/commit/cf392f7d754ba56468da508c3abbcf0e52368537))
* **lifecycle:** emit device + member create/delete events ([#757](https://github.com/lobu-ai/lobu/issues/757)) ([ca31cca](https://github.com/lobu-ai/lobu/commit/ca31cca4242b1360aa6505a4b4ebc48d483fe057))
* **lifecycle:** MCP-client emitter + strict typecheck Makefile target ([#761](https://github.com/lobu-ai/lobu/issues/761)) ([31ef33f](https://github.com/lobu-ai/lobu/commit/31ef33f33894e9d38ba6abf0948c9d215d61cf1e))
* lobu connector run + mirror-mode browser auth (no managed Chrome) ([#725](https://github.com/lobu-ai/lobu/issues/725)) ([10ef310](https://github.com/lobu-ai/lobu/commit/10ef31052b4f8ac2d3ffdb4a93eee248af1e5354))
* **local-server:** persist DATABASE_URL/PORT/HOST/dataDir in user config ([#839](https://github.com/lobu-ai/lobu/issues/839)) ([8102b9e](https://github.com/lobu-ai/lobu/commit/8102b9e914dddb1fd15db3eef0919676752a3add))
* **mac:** collapse Chrome profile rows behind a disclosure ([#736](https://github.com/lobu-ai/lobu/issues/736)) ([6eef3df](https://github.com/lobu-ai/lobu/commit/6eef3df0d570f5c62cc6cccdad0d8000ce962299))
* **mac:** menu bar connector overhaul + inline sign-in card ([#774](https://github.com/lobu-ai/lobu/issues/774)) ([3f1379c](https://github.com/lobu-ai/lobu/commit/3f1379c48e08117ea1da4cb238c0c7bb4688bbbe))
* **metric_series:** events-sourced stat trends + lifecycle emitters ([#756](https://github.com/lobu-ai/lobu/issues/756)) ([26253b9](https://github.com/lobu-ai/lobu/commit/26253b9912eee29fc308c1d9da5602d810e26c10))
* **photos:** apple.photos via Mac app; drop google_photos ([#732](https://github.com/lobu-ai/lobu/issues/732)) ([4a6f257](https://github.com/lobu-ai/lobu/commit/4a6f2570e7580f94ff7e98f089f16a97a59967c0))
* **schema:** goals primitive — top-level handle for watcher hierarchy ([#813](https://github.com/lobu-ai/lobu/issues/813)) ([70e2b6e](https://github.com/lobu-ai/lobu/commit/70e2b6e87f0fa879969e5030584f775099c6ba0c))
* **schema:** per-org agent id PK — close two-orgs-same-id footgun ([#750](https://github.com/lobu-ai/lobu/issues/750)) ([e4f15b9](https://github.com/lobu-ai/lobu/commit/e4f15b967740b3b70394273c5b4758b82b6a17ff))
* **schema:** watchers — device_worker_id, agent_kind, notification, cooldown columns ([#811](https://github.com/lobu-ai/lobu/issues/811)) ([76aaf2d](https://github.com/lobu-ai/lobu/commit/76aaf2dd6c298eebdca69d3b59d1549e00dcea64)), closes [#799](https://github.com/lobu-ai/lobu/issues/799)
* **server,mac:** no-auth mode for embedded server (LOBU_NO_AUTH=1) ([#779](https://github.com/lobu-ai/lobu/issues/779)) ([a3e6f0a](https://github.com/lobu-ai/lobu/commit/a3e6f0af1cc927157f8a90fd1ba24b6369a3a93f))
* **server:** auto-provision default agent + watcher; add manual-trigger endpoint ([#824](https://github.com/lobu-ai/lobu/issues/824)) ([53e9ddd](https://github.com/lobu-ai/lobu/commit/53e9ddd1a100115266528bb1c149a27c1df129dd))
* **theme:** apply tweakcn "Retro" to landing + web ([#751](https://github.com/lobu-ai/lobu/issues/751)) ([139b1b6](https://github.com/lobu-ai/lobu/commit/139b1b614449ea889d82d726f7dc2f3725178472))
* **watchers:** device-pinned watcher runs end-to-end ([#798](https://github.com/lobu-ai/lobu/issues/798) PR-1) ([#814](https://github.com/lobu-ai/lobu/issues/814)) ([2ffccfb](https://github.com/lobu-ai/lobu/commit/2ffccfbd257e9462221ff980a418938dcdda9d9e))
* **web:** sidebar UX pass — tooltips, inline loading, members link, dedicated client routes ([#723](https://github.com/lobu-ai/lobu/issues/723)) ([013fe8d](https://github.com/lobu-ai/lobu/commit/013fe8d5336c4ef01787b578cbbc038188c086c7))
* **web:** swap bare Loading… text for skeleton placeholders ([#786](https://github.com/lobu-ai/lobu/issues/786)) ([592d497](https://github.com/lobu-ai/lobu/commit/592d4974479ea81622011269e93d7c4c348dec63))
* **web:** UX sweep — unified landings, /connectors rename, skeleton loading ([#726](https://github.com/lobu-ai/lobu/issues/726)) ([52f477e](https://github.com/lobu-ai/lobu/commit/52f477e26b2bc77632f874bdc78f2cbe7cfe2fe4))


### Bug Fixes

* **agent-worker:** guard against null assistantMessageEvent in OpenClawProgressProcessor ([#841](https://github.com/lobu-ai/lobu/issues/841)) ([8a42a53](https://github.com/lobu-ai/lobu/commit/8a42a53febcb686a849323ff56d049beb5b57321)), closes [#691](https://github.com/lobu-ai/lobu/issues/691)
* **apply, chat, gateway:** three bugs in the org-shared-provider-keys flow ([#746](https://github.com/lobu-ai/lobu/issues/746)) ([f563f17](https://github.com/lobu-ai/lobu/commit/f563f17b130d7cb27115f79bad86ede13977ef41))
* **apply:** surface config path, auto-load .env, schema-prep for per-org agent IDs ([#734](https://github.com/lobu-ai/lobu/issues/734)) ([73eba79](https://github.com/lobu-ai/lobu/commit/73eba79ad7fcde4d72eb03755a270408ee0d9603))
* **auth-profiles:** bound agentOwner / agentOrg caches at 1024 entries ([#855](https://github.com/lobu-ai/lobu/issues/855)) ([7b0c819](https://github.com/lobu-ai/lobu/commit/7b0c819b2879a77c25d5dcb383d1a744e639394d))
* **ci:** cap DB_POOL_MAX=5 in the integration job ([#805](https://github.com/lobu-ai/lobu/issues/805)) ([32920c8](https://github.com/lobu-ai/lobu/commit/32920c821ae6ec36103a092d08c8b4c587b16acd))
* **cli:** connector run uses agent API origin, not memory MCP URL ([#730](https://github.com/lobu-ai/lobu/issues/730)) ([52414d1](https://github.com/lobu-ai/lobu/commit/52414d11b9f8781e81447140eea19d534bf4e20b))
* close monitoring + deploy gaps from post-incident audit ([#775](https://github.com/lobu-ai/lobu/issues/775)) ([bdea9d5](https://github.com/lobu-ai/lobu/commit/bdea9d5cab4be8471898bb510fcc176aa89fce09))
* **connections:** admin-gate app profile updates + member account-profile rebind UI ([#812](https://github.com/lobu-ai/lobu/issues/812)) ([54ee582](https://github.com/lobu-ai/lobu/commit/54ee5828937b42a104eae0f1caadfa8ed7dc91e0))
* **connector-sdk:** use vanilla Playwright for CDP attach ([#731](https://github.com/lobu-ai/lobu/issues/731)) ([d057f95](https://github.com/lobu-ai/lobu/commit/d057f9522bd15aa0f6f728ead535f172c1c41a18))
* **connectors:** add faviconDomain to github + reddit ([#754](https://github.com/lobu-ai/lobu/issues/754)) ([b4e5a35](https://github.com/lobu-ai/lobu/commit/b4e5a350d17c76ac76dd3fe247543461330f9304))
* **core:** accept URL-safe base64 in ENCRYPTION_KEY validator ([#735](https://github.com/lobu-ai/lobu/issues/735)) ([df759d7](https://github.com/lobu-ai/lobu/commit/df759d71765863c03ec60f22245e28f78491fe96))
* **device-reconcile:** replace uuid[] cast with text[] to avoid PG array parse failure ([#835](https://github.com/lobu-ai/lobu/issues/835)) ([be8166c](https://github.com/lobu-ai/lobu/commit/be8166c02987ad5ff4859935ab2ff7b200bd8954))
* **docker:** correct compose example after e2e test ([#853](https://github.com/lobu-ai/lobu/issues/853)) ([b95a35e](https://github.com/lobu-ai/lobu/commit/b95a35e1337b368f83dbcc16134626af8b92a557))
* **goals:** emit lifecycle event on update ([#815](https://github.com/lobu-ai/lobu/issues/815)) ([#818](https://github.com/lobu-ai/lobu/issues/818)) ([7a72456](https://github.com/lobu-ai/lobu/commit/7a7245629ebb33a980ef990b5a0ff3bae8be081b))
* **insert-event:** guard against empty INSERT RETURNING ([#780](https://github.com/lobu-ai/lobu/issues/780)) ([5226d99](https://github.com/lobu-ai/lobu/commit/5226d99defeb6b53fef37a43dd26a3b98c3a6cfc))
* **interactions:** require connectionId to prevent cross-platform leakage ([#847](https://github.com/lobu-ai/lobu/issues/847)) ([16998ab](https://github.com/lobu-ai/lobu/commit/16998ab8dde923536b002017b11fc5e528201e2f)), closes [#690](https://github.com/lobu-ai/lobu/issues/690)
* **mac:** auto-start runner with the env it actually needs ([#783](https://github.com/lobu-ai/lobu/issues/783)) ([f8013b5](https://github.com/lobu-ai/lobu/commit/f8013b5956c407044f551a813a6aaeae7fd09bba))
* **mcp:** fail closed when tool annotations cannot be fetched ([#688](https://github.com/lobu-ai/lobu/issues/688)) ([#844](https://github.com/lobu-ai/lobu/issues/844)) ([ea24266](https://github.com/lobu-ai/lobu/commit/ea24266f3437d84cf04b740cb1e77f07ba33e347))
* **metric_series:** defense-in-depth (prefix check + row cap) ([#763](https://github.com/lobu-ai/lobu/issues/763)) ([35285ea](https://github.com/lobu-ai/lobu/commit/35285eafb32d756fcf57e22c199ec0ed25f0a9db))
* **metric_series:** inline statement_timeout (SET LOCAL rejects params) ([#762](https://github.com/lobu-ai/lobu/issues/762)) ([039c7ab](https://github.com/lobu-ai/lobu/commit/039c7ab790fd6b5b64d9194fd323c68ab8a990ba))
* **metric_series:** tsc errors that broke the build-app image ([#758](https://github.com/lobu-ai/lobu/issues/758)) ([a5f1212](https://github.com/lobu-ai/lobu/commit/a5f12128ea38ee944c8be0ac8c6ad86549df672f))
* **no-auth:** address CodeRabbit follow-ups from PR [#780](https://github.com/lobu-ai/lobu/issues/780) review ([#785](https://github.com/lobu-ai/lobu/issues/785)) ([33e6c04](https://github.com/lobu-ai/lobu/commit/33e6c045c519b7613d12b1095030881c7cb64411))
* **reliability:** gate boot on schema, surface err, split readiness ([#767](https://github.com/lobu-ai/lobu/issues/767)) ([ca4ba0e](https://github.com/lobu-ai/lobu/commit/ca4ba0ea4105e96277fc23d8039937ae5083e798))
* **runs:** add heartbeat + stale-run reaper ([#849](https://github.com/lobu-ai/lobu/issues/849)) ([741a4d7](https://github.com/lobu-ai/lobu/commit/741a4d7c63cdb4f19e0592ab11cdc2c6e904c297))
* schema.sql drift + manage_feeds feed_key narrowing + submodule bump ([#804](https://github.com/lobu-ai/lobu/issues/804)) ([3a9d8fd](https://github.com/lobu-ai/lobu/commit/3a9d8fdde6618084f7db272e436378d987546f7f))
* **schema:** drop agents_organization_id_id_key — broke ON CONFLICT (id) callers ([#747](https://github.com/lobu-ai/lobu/issues/747)) ([8af9021](https://github.com/lobu-ai/lobu/commit/8af90219038fa1b3001979c8ca8d00a133acd3be))
* **server:** bundle build copies connectors next to server.bundle.mjs ([#739](https://github.com/lobu-ai/lobu/issues/739)) ([0358a4a](https://github.com/lobu-ai/lobu/commit/0358a4aec3570a30fdde413535bc9aa1eb6d8b35))
* **server:** ignore packages/owletto in dev watcher ([#826](https://github.com/lobu-ai/lobu/issues/826)) ([67792d8](https://github.com/lobu-ai/lobu/commit/67792d856a518f7e162c01afcc5789620bbda5ef))
* **server:** plug listener leaks on Hono SSE routes via abort bridge ([#845](https://github.com/lobu-ai/lobu/issues/845)) ([3ee73d9](https://github.com/lobu-ai/lobu/commit/3ee73d9cfbf663762cb07362ef64e64e64379069))
* **server:** project device_worker_id + goal_id on watcher list endpoint ([#816](https://github.com/lobu-ai/lobu/issues/816)) ([0a863bc](https://github.com/lobu-ai/lobu/commit/0a863bcb482c3063b3eedf6c6e6d181b3022b09a))
* **server:** remove LOBU_NO_AUTH, add /api/exchange-token PAT handoff ([#827](https://github.com/lobu-ai/lobu/issues/827)) ([4fddc72](https://github.com/lobu-ai/lobu/commit/4fddc72cdec5fb865ddf2395007bcc237742c624))
* **server:** remove unauthenticated GET /internal/connections ([#846](https://github.com/lobu-ai/lobu/issues/846)) ([c8c0db3](https://github.com/lobu-ai/lobu/commit/c8c0db32332730334dfcbad814821593806cee9a)), closes [#687](https://github.com/lobu-ai/lobu/issues/687)
* **server:** scheduled-jobs embedded patch — guard FK against composite-PK swap ([#809](https://github.com/lobu-ai/lobu/issues/809)) ([6683036](https://github.com/lobu-ai/lobu/commit/66830364ed3af555a10f293bf2cf568e2c5d6269))
* **server:** scope tenant boundaries across egress judge, secret proxy, and oauth state ([#836](https://github.com/lobu-ai/lobu/issues/836)) ([de4c238](https://github.com/lobu-ai/lobu/commit/de4c238bb39d321211ca149447bdf568c3204b04))
* **server:** server-side agent must skip device-pinned watcher runs ([#808](https://github.com/lobu-ai/lobu/issues/808)) ([a88d840](https://github.com/lobu-ai/lobu/commit/a88d840155c768ba062a22fb200d08481eec2f52))
* **server:** tear down SSE keepalive + listener on abnormal disconnect ([#833](https://github.com/lobu-ai/lobu/issues/833)) ([f597e76](https://github.com/lobu-ai/lobu/commit/f597e768ecd3e8346d05a4009bb864f68f453fc5))


### Performance Improvements

* drop 8 unused indexes (5.16 GB) + event_count from list ([#771](https://github.com/lobu-ai/lobu/issues/771)) ([653566f](https://github.com/lobu-ai/lobu/commit/653566f56377eb3ce21c4ed6c153d9584f5f6e01))
* **events:** stored fulltext column + lifecycle partial index ([#765](https://github.com/lobu-ai/lobu/issues/765)) ([48c2b92](https://github.com/lobu-ai/lobu/commit/48c2b92fe8fd6de9456108495ed82070e26924cf))
* **server:** SIGUSR2 writes V8 heap snapshot ([#768](https://github.com/lobu-ai/lobu/issues/768)) ([e5c93a3](https://github.com/lobu-ai/lobu/commit/e5c93a38fd478c1cd4d4b9e474c631cac39e09fa))
* **workers:** stop shipping connector bundles + LRU cache cap ([#772](https://github.com/lobu-ai/lobu/issues/772)) ([c40408c](https://github.com/lobu-ai/lobu/commit/c40408ce698df84d1b0a53fcc6d7f0c4445f4404))


### Reverts

* **server:** drop goals primitive — agents are the grouping concept ([#823](https://github.com/lobu-ai/lobu/issues/823)) ([f5dee4e](https://github.com/lobu-ai/lobu/commit/f5dee4e2a96b33119ebf0f133a74e82e9a849728))

## [7.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v6.1.1...lobu-v7.0.0) (2026-05-14)


### ⚠ BREAKING CHANGES

* **cli:** remove inline [memory.schema] from lobu.toml ([#630](https://github.com/lobu-ai/lobu/issues/630))

### Features

* **apply:** declarative Slack channel routing on platforms ([#661](https://github.com/lobu-ai/lobu/issues/661)) ([4622016](https://github.com/lobu-ai/lobu/commit/4622016f99eb56d6f56cb0ed7c76b4708d173834))
* **auth:** save password credential on email+password sign-in ([#695](https://github.com/lobu-ai/lobu/issues/695)) ([018335d](https://github.com/lobu-ai/lobu/commit/018335d6b5291902baf76f172d0917b4bd76551d))
* **browser-profiles:** device-bound browser auth + per-folder feeds + Mac UI overhaul ([#706](https://github.com/lobu-ai/lobu/issues/706)) ([ad19392](https://github.com/lobu-ai/lobu/commit/ad19392d15398cdf5f165c7885350881b9fa914f))
* **charts:** add public Helm install chart ([85ad155](https://github.com/lobu-ai/lobu/commit/85ad15508ea3405a727155f34b75ecfb53862625))
* **cli:** `lobu apply` bootstraps a missing org from [memory].org ([#632](https://github.com/lobu-ai/lobu/issues/632)) ([9a493fe](https://github.com/lobu-ai/lobu/commit/9a493fe878764f41f46a65674ccf7742466cbbf6))
* **cli:** remove inline [memory.schema] from lobu.toml ([#630](https://github.com/lobu-ai/lobu/issues/630)) ([b5bee12](https://github.com/lobu-ai/lobu/commit/b5bee126700f6a1715f85aed7ee509466ada89d9))
* **cli:** support bundled memory model YAML ([#626](https://github.com/lobu-ai/lobu/issues/626)) ([e843d52](https://github.com/lobu-ai/lobu/commit/e843d5267d3398c6124b360647b8edcbf73dd560))
* **cli:** sync data-source connectors in lobu apply ([#624](https://github.com/lobu-ai/lobu/issues/624)) ([7fe4924](https://github.com/lobu-ai/lobu/commit/7fe492484efdc4e24fad553250f3c18db3bb7424))
* **connections:** cross-link devices ↔ connections, waiting-on-device state ([#670](https://github.com/lobu-ai/lobu/issues/670)) ([bebcbd1](https://github.com/lobu-ai/lobu/commit/bebcbd1339378bd65781e6f851f340ea049cf046)), closes [#597](https://github.com/lobu-ai/lobu/issues/597)
* **connections:** richer Run-on device picker ([#662](https://github.com/lobu-ai/lobu/issues/662)) ([b807e62](https://github.com/lobu-ai/lobu/commit/b807e629c4842b753fb6a244f2a32f10e7bb9ced))
* **connectors:** add Revolut transactions connector (browser/CDP) ([#589](https://github.com/lobu-ai/lobu/issues/589)) ([9774389](https://github.com/lobu-ai/lobu/commit/97743893aaa9d11f4371ebc170aab8e349553660))
* **connectors:** device-pinning follow-ups ([#620](https://github.com/lobu-ai/lobu/issues/620)) ([#628](https://github.com/lobu-ai/lobu/issues/628)) ([e77b2b0](https://github.com/lobu-ai/lobu/commit/e77b2b06cb5a57b8dedcd231bd78a836ae346da8))
* **connectors:** pin connections to a device worker (run-on-device + shared-org device connectors) ([#620](https://github.com/lobu-ai/lobu/issues/620)) ([df36418](https://github.com/lobu-ai/lobu/commit/df3641839451eb67fb29ffea258835d538a15131))
* **device-workers:** a device's home org follows the workspace picked on the OAuth page ([#645](https://github.com/lobu-ai/lobu/issues/645)) ([6323001](https://github.com/lobu-ai/lobu/commit/6323001d9f0c0f1fbffe6d3efd6f2a317b388e61))
* **device-workers:** device worker protocol and Lobu for Mac ([67c192b](https://github.com/lobu-ai/lobu/commit/67c192b2a2c14984106ec7622d6bb157d70995e3))
* **device-workers:** one workspace per device; removal + health on the Devices page ([#639](https://github.com/lobu-ai/lobu/issues/639)) ([4045cb8](https://github.com/lobu-ai/lobu/commit/4045cb8bceb1d00629b71046639262959c966531))
* **dev:** per-worktree port overrides via .env.local ([#580](https://github.com/lobu-ai/lobu/issues/580)) ([4fa213b](https://github.com/lobu-ai/lobu/commit/4fa213b6e629c4d42bedae27ef3ba1953fc76640))
* **examples:** add lobu-crm dogfood funnel CRM agent ([#592](https://github.com/lobu-ai/lobu/issues/592)) ([03d136f](https://github.com/lobu-ai/lobu/commit/03d136f8842240a32a76cddb3fd12e030fd3a9ae))
* **examples:** add office-bot project — food-ordering agent (Slack → Deliveroo) ([#631](https://github.com/lobu-ai/lobu/issues/631)) ([8de4318](https://github.com/lobu-ai/lobu/commit/8de431823626e14c7d25431ab9b862ba985a19ae))
* **mac+server:** WhatsApp voice notes — ingest + transcribe ([#708](https://github.com/lobu-ai/lobu/issues/708)) ([36f57a6](https://github.com/lobu-ai/lobu/commit/36f57a61bdd88ddc45b884d94038efefe18b9b85))
* **mac:** credential-store sign-in, menubar redesign, Sparkle, WhatsApp local ([#702](https://github.com/lobu-ai/lobu/issues/702)) ([49b66c0](https://github.com/lobu-ai/lobu/commit/49b66c0d8987e111ec633adf87010aaa92d70a19))
* **mac:** make HealthKit optional — drop the restricted entitlement ([#614](https://github.com/lobu-ai/lobu/issues/614)) ([30b5568](https://github.com/lobu-ai/lobu/commit/30b5568c126c23969c904e285b38e64b810b15b4))
* **mac:** menubar redesign + Sparkle auto-updates ([#700](https://github.com/lobu-ai/lobu/issues/700)) ([e519ba6](https://github.com/lobu-ai/lobu/commit/e519ba65187b7bc8fdd96f0d35a39509ace82c12))
* **mac:** unsigned-DMG stopgap for mac-release; auto-upgrades to signed ([#616](https://github.com/lobu-ai/lobu/issues/616)) ([d62a3c0](https://github.com/lobu-ai/lobu/commit/d62a3c0946f1f62844e1584cf5bf88887ade8960))
* **mac:** wire DMG build into release CD; "Check for Updates" in app ([#608](https://github.com/lobu-ai/lobu/issues/608)) ([78bb644](https://github.com/lobu-ai/lobu/commit/78bb6445cb37035ea292a3665c33d2ba302d9ff7))
* master-detail Agents page (assistant-ui chat) + sidebar restore ([#578](https://github.com/lobu-ai/lobu/issues/578)) ([92df339](https://github.com/lobu-ai/lobu/commit/92df3396d8474db3f7350e6b6178f707b2c239b3))
* **notifications:** unify with events; per-user delivery via notification_targets ([#707](https://github.com/lobu-ai/lobu/issues/707)) ([048a402](https://github.com/lobu-ai/lobu/commit/048a40214c2041f24146c6092638f76c69e2cd65))
* Notion-style nav shell behind navV2 flag ([#705](https://github.com/lobu-ai/lobu/issues/705)) ([8d4b3e5](https://github.com/lobu-ai/lobu/commit/8d4b3e5664ff9c30d73daed6f69dba8ab4ccae9c))
* **openclaw-plugin:** publish Lobu plugin to ClawHub ([#584](https://github.com/lobu-ai/lobu/issues/584)) ([8fa158b](https://github.com/lobu-ai/lobu/commit/8fa158b1a3a9857721d7c1a9fb279836032e9184))
* **openclaw:** memory-wiki compatibility spike + harness ([#569](https://github.com/lobu-ai/lobu/issues/569)) ([a8babfd](https://github.com/lobu-ai/lobu/commit/a8babfd96c5cd121e16a7f609de497866374ed91))
* **preview:** /lobu try — self-serve demo agents in the public preview bot ([#664](https://github.com/lobu-ai/lobu/issues/664)) ([c799bb5](https://github.com/lobu-ai/lobu/commit/c799bb5560d71f5509e38ab0784465d10b6e70fb))
* **preview:** record chat-user→Lobu-user identity on /lobu link; codeless re-link by agent id ([#652](https://github.com/lobu-ai/lobu/issues/652)) ([3a33486](https://github.com/lobu-ai/lobu/commit/3a33486ee9aec02db6a952d528e3d3495bff94f1))
* **scheduled-jobs:** user-driven cron / one-shot via TaskScheduler + scheduled_jobs table ([#710](https://github.com/lobu-ai/lobu/issues/710)) ([fa6a105](https://github.com/lobu-ai/lobu/commit/fa6a105d3285c6f22b72891c341dc37bb1202be1))
* **server:** add stable slug to connections ([#619](https://github.com/lobu-ai/lobu/issues/619)) ([0a35349](https://github.com/lobu-ai/lobu/commit/0a3534929eafb22d81a636d68e5c53c8aa3073d2))
* **server:** drop connector_key gating from browser_session profiles ([#720](https://github.com/lobu-ai/lobu/issues/720)) ([539831b](https://github.com/lobu-ai/lobu/commit/539831b7299d632047a698d99c5edbbc98238924))
* **server:** get_content semantic_type accepts string or array ([#719](https://github.com/lobu-ai/lobu/issues/719)) ([cfcb80e](https://github.com/lobu-ai/lobu/commit/cfcb80e3636688635da7061f9a88a5b3d4af8479))
* **sidebar:** agents & devices counts via bootstrap summary ([#650](https://github.com/lobu-ai/lobu/issues/650)) ([570a6c7](https://github.com/lobu-ai/lobu/commit/570a6c76a102af14391064914e88dfa4595378fa))
* Slack Preview — try a Lobu agent via the hosted "Lobu Developer" Slack with no bot token ([#627](https://github.com/lobu-ai/lobu/issues/627)) ([7d66977](https://github.com/lobu-ai/lobu/commit/7d6697700afe2a41a43dc4fd02ea25c25826e668))
* **slack-preview:** deterministic "link this chat" reply for unlinked DMs/channels ([#644](https://github.com/lobu-ai/lobu/issues/644)) ([837f3a7](https://github.com/lobu-ai/lobu/commit/837f3a75c4a0362b90506e2170664aa6bd0da601))
* **slack:** App Home tab — integrations list + per-user Connect/Disconnect ([#653](https://github.com/lobu-ai/lobu/issues/653)) ([562d071](https://github.com/lobu-ai/lobu/commit/562d071b8d2ae1470de54701fa5cc754b8df1146))
* support workspace visibility updates ([#574](https://github.com/lobu-ai/lobu/issues/574)) ([179b512](https://github.com/lobu-ai/lobu/commit/179b512354e7e66ee0b62166041aae3f7c1d1f09))
* **watchers:** allow org-scoped watchers + sync them in lobu apply ([#596](https://github.com/lobu-ai/lobu/issues/596)) ([86eaf90](https://github.com/lobu-ai/lobu/commit/86eaf9099689f62a8fa533e8339472e8bc2a04d0))
* web "Try in chat" + agent channel-bindings (A1+A2) ([#660](https://github.com/lobu-ai/lobu/issues/660)) ([2976b15](https://github.com/lobu-ai/lobu/commit/2976b1561ff23cf9574cefe72bbf95d6340778c4))
* **web:** reserve /inbox path; bump web submodule for Home/Inbox/Search nav ([#599](https://github.com/lobu-ai/lobu/issues/599)) ([3537630](https://github.com/lobu-ai/lobu/commit/353763026972a655f4cdeed226647e0129dcebca))
* **web:** sidebar — nest focused entity under its type, hoist workspace nav, compact counts ([#675](https://github.com/lobu-ai/lobu/issues/675)) ([26b8f34](https://github.com/lobu-ai/lobu/commit/26b8f34e400a1e43d11801176f8e19e5c5e4cef8))
* **web:** surface connector actions on detail + empty state ([#711](https://github.com/lobu-ai/lobu/issues/711)) ([f732081](https://github.com/lobu-ai/lobu/commit/f732081d26df5469b5e9c490877830249dcd142d))


### Bug Fixes

* **agents:** coerce list-agents platforms to a string[] ([#659](https://github.com/lobu-ai/lobu/issues/659)) ([4122ff9](https://github.com/lobu-ai/lobu/commit/4122ff991b7909e70dd3f93b77e1ca5d51a4779b))
* **apply:** userinfo returns org id; dry-run is read-only; fix plan heading ([#636](https://github.com/lobu-ai/lobu/issues/636)) ([82d2afb](https://github.com/lobu-ai/lobu/commit/82d2afb01e11329c224a8ea1d7638f8316e2967c))
* **auth:** stamp personal_org_for_user_id on manual org creation + default device tokens to it ([#703](https://github.com/lobu-ai/lobu/issues/703)) ([9049955](https://github.com/lobu-ai/lobu/commit/9049955d43c01e7aca25982a82fcf5ba25141af8))
* bug-fix sweep ([#673](https://github.com/lobu-ai/lobu/issues/673)) ([7c1500b](https://github.com/lobu-ai/lobu/commit/7c1500b82eb3facbb8a283be64af7bb0777eb51c))
* bug-hunt sweep — OAuth exchange, watcher versions, dead code ([#642](https://github.com/lobu-ai/lobu/issues/642)) ([a1a6abf](https://github.com/lobu-ai/lobu/commit/a1a6abf5e1befe95dd200700cea1e0f59093a761))
* **cli:** chat/eval target the gateway Agent API under /lobu ([#637](https://github.com/lobu-ai/lobu/issues/637)) ([4535b79](https://github.com/lobu-ai/lobu/commit/4535b798352de9b64cde0be094dc3052a4bc7840))
* **cli:** lobu apply resolves the org via userinfo; no headless org-create ([#634](https://github.com/lobu-ai/lobu/issues/634)) ([e140a9c](https://github.com/lobu-ai/lobu/commit/e140a9cbb819292c780873db922ff02fc0c152c7))
* **cli:** resolve providers.json + worker entry relative to enclosing monorepo root ([#669](https://github.com/lobu-ai/lobu/issues/669)) ([2458494](https://github.com/lobu-ai/lobu/commit/24584942610777bd2347eac8cb700a5d77ca7940)), closes [#656](https://github.com/lobu-ai/lobu/issues/656) [#657](https://github.com/lobu-ai/lobu/issues/657)
* **connectors:** always recompile bundled connectors from disk, ignore stale persisted artifact ([#666](https://github.com/lobu-ai/lobu/issues/666)) ([dab5e49](https://github.com/lobu-ai/lobu/commit/dab5e493bf5690e271065fa2d20e13cd3c4205e2))
* **core/tests:** unblock Docker tsc — typecheck failures in [#685](https://github.com/lobu-ai/lobu/issues/685) tests ([#696](https://github.com/lobu-ai/lobu/issues/696)) ([a972de9](https://github.com/lobu-ai/lobu/commit/a972de9f51ea22911ebf5c9349d03b7bf580a418))
* **db:** make local PGlite dev reliable; bump owletto-web ([#607](https://github.com/lobu-ai/lobu/issues/607)) ([67b3c58](https://github.com/lobu-ai/lobu/commit/67b3c585e0bb68fb74c9a6c64eeb13fb0d7f5c53))
* **examples:** office-bot models as a version: 2 bundle ([#633](https://github.com/lobu-ai/lobu/issues/633)) ([7db2157](https://github.com/lobu-ai/lobu/commit/7db2157dfb63c9cb9cab9588c3a40d112e91b9db))
* **gateway:** guard optional agentSettingsStore in agentOwnerResolver closure ([#611](https://github.com/lobu-ai/lobu/issues/611)) ([537f383](https://github.com/lobu-ai/lobu/commit/537f3832835297b7157183fc28a7c28b69e419cc))
* **gateway:** resolve agent provider credentials via the agent owner ([#609](https://github.com/lobu-ai/lobu/issues/609)) ([abec8de](https://github.com/lobu-ai/lobu/commit/abec8de30a7f1fe8bab903b16fdca5135bb17bd0))
* **gateway:** resolve provider credentials in the agent's org context for chat-webhook runs ([#641](https://github.com/lobu-ai/lobu/issues/641)) ([df6c08d](https://github.com/lobu-ai/lobu/commit/df6c08da255c2f21b2f8acab25614bb78e499c0b))
* **lobu:** persist agent api-key auth profiles from PATCH /config ([#601](https://github.com/lobu-ai/lobu/issues/601)) ([d3c3bb8](https://github.com/lobu-ai/lobu/commit/d3c3bb8f6e6a3805808724b179f69e5fc7e5c89b))
* **mac:** always publish the Homebrew cask; fail loudly if no token ([#621](https://github.com/lobu-ai/lobu/issues/621)) ([9812b2c](https://github.com/lobu-ai/lobu/commit/9812b2c7d3fb803dfb2706d97de60754a8178096))
* **mac:** push the Homebrew cask via a dedicated deploy key, not a PAT ([#622](https://github.com/lobu-ai/lobu/issues/622)) ([903a516](https://github.com/lobu-ai/lobu/commit/903a516a3a74901b36846997771c7cd0907e83ec))
* **mac:** tap-token fallback to RELEASE_PLEASE_TOKEN; tidy cask template ([#617](https://github.com/lobu-ai/lobu/issues/617)) ([ef010fd](https://github.com/lobu-ai/lobu/commit/ef010fd5f84d88dd4f54b3862edafdd2e39d60f1))
* **openclaw-plugin:** declare contracts.tools and bound recall hook ([#585](https://github.com/lobu-ai/lobu/issues/585)) ([9f46e5f](https://github.com/lobu-ai/lobu/commit/9f46e5f3bf2afae42e4fcd0d95bfb05bb73a12ca))
* **openclaw-plugin:** warn loudly when host has no tools.* policy ([#590](https://github.com/lobu-ai/lobu/issues/590)) ([271d49a](https://github.com/lobu-ai/lobu/commit/271d49ad29441af2ce80517dd620415049593712))
* **openclaw:** bound memory-wiki compat fanouts with per-call timeout ([8c15420](https://github.com/lobu-ai/lobu/commit/8c154209d498dacfea191bd248f45f81b307cbf7))
* restore packages/web entries in bun.lock ([#654](https://github.com/lobu-ai/lobu/issues/654)) ([26d16ce](https://github.com/lobu-ai/lobu/commit/26d16cecdeed5742fda8f1679d612e9fb408b048))
* **sentry:** stop polluting Sentry with tool-validation noise + sweeper info ([#612](https://github.com/lobu-ai/lobu/issues/612)) ([be1732b](https://github.com/lobu-ai/lobu/commit/be1732b609b1c56daa6fc865c519b2c5e861e3c2))
* **server:** capture all 5xx responses + thrown HTTP errors in Sentry ([#701](https://github.com/lobu-ai/lobu/issues/701)) ([9bfb626](https://github.com/lobu-ai/lobu/commit/9bfb626a5077c2ecc3f17e7be311d285ad7d7cdb))
* **server:** device-reconcile adopts orphan connections + web bump ([#714](https://github.com/lobu-ai/lobu/issues/714)) ([76fc6e9](https://github.com/lobu-ai/lobu/commit/76fc6e9881de62bc05014cded25d5f27c75eb018))
* **server:** no-store on unknown-path discovery JSON (stop CDN caching it) ([#603](https://github.com/lobu-ai/lobu/issues/603)) ([cc89429](https://github.com/lobu-ai/lobu/commit/cc894293646560587c8f237506fa7e72589ef963))
* **server:** orchestration-harden test no longer wipes shared DATABASE_URL ([#716](https://github.com/lobu-ai/lobu/issues/716)) ([24fdbb9](https://github.com/lobu-ai/lobu/commit/24fdbb95ac40c4f527f0b31690c96bc5ff5239e6))
* **server:** remove duplicate getClientIp export in rate-limiter ([#699](https://github.com/lobu-ai/lobu/issues/699)) ([36baed1](https://github.com/lobu-ai/lobu/commit/36baed145a4c47f5767afd8be77572a777d81770))
* **server:** restore getClientIp helper for secret-proxy legacy path ([#694](https://github.com/lobu-ai/lobu/issues/694)) ([0faa2f7](https://github.com/lobu-ai/lobu/commit/0faa2f7d09a45efb7a5ecb10edbfe30455e398b5))
* **server:** semantic_type array support in scored path + bump owletto-web ([#721](https://github.com/lobu-ai/lobu/issues/721)) ([e5a3c9c](https://github.com/lobu-ai/lobu/commit/e5a3c9caaa5804ded8ae1875b7441aea2571a5e3))
* **server:** unify content search on hybrid index-driven candidate path ([#586](https://github.com/lobu-ai/lobu/issues/586)) ([bc43385](https://github.com/lobu-ai/lobu/commit/bc43385d215bcea8d8c82da11c094378f9b6a1bb))
* **slack-preview:** store /lobu link bindings under the canonical slack: channel key ([#638](https://github.com/lobu-ai/lobu/issues/638)) ([840cb3c](https://github.com/lobu-ai/lobu/commit/840cb3c813089935b8a706b191dab0e08862041a))
* **slack:** publish the Home view through the initialized adapter ([#665](https://github.com/lobu-ai/lobu/issues/665)) ([e1e549f](https://github.com/lobu-ai/lobu/commit/e1e549f2b49f4b7eb2a65fbf68c1c6233915b553))
* **slack:** surface the real error when the Home view fails + fall back to a minimal view ([#663](https://github.com/lobu-ai/lobu/issues/663)) ([12dcdcb](https://github.com/lobu-ai/lobu/commit/12dcdcbfe0345dcd9df57ca7bd6ed749188a9296))
* **test:** list connections.device_worker_id in QUERYABLE_SCHEMA ([#625](https://github.com/lobu-ai/lobu/issues/625)) ([3e4e994](https://github.com/lobu-ai/lobu/commit/3e4e9948f8c414fe85f543466300c5257f3c09c8))
* update Lobu logo assets ([fc28fb2](https://github.com/lobu-ai/lobu/commit/fc28fb2f00f6430c2ce410586faeaa332502059d))
* **watchers:** enforce org access for scoped watchers ([#598](https://github.com/lobu-ai/lobu/issues/598)) ([b652f10](https://github.com/lobu-ai/lobu/commit/b652f1092a4c3e5448b6194defb4462aa817e8b5))
* **web:** SEO meta + favicon; dedupe server-rendered public-page head ([#600](https://github.com/lobu-ai/lobu/issues/600)) ([6dd598b](https://github.com/lobu-ai/lobu/commit/6dd598bc927fe1cfdff20058652926f1fef6d07b))
* **whatsapp:** cross-connector dedup, voice-note diagnostics, schema survey ([#713](https://github.com/lobu-ai/lobu/issues/713)) ([2267f58](https://github.com/lobu-ai/lobu/commit/2267f5882e83be552e91b5948d7a9cea0eac0225))


### Performance Improvements

* performance sweep — caching, batching, fewer round-trips ([#674](https://github.com/lobu-ai/lobu/issues/674)) ([1fbdd62](https://github.com/lobu-ai/lobu/commit/1fbdd6243c5e2f39deb11eaadeefebe843a6bbf6))

## [6.1.1](https://github.com/lobu-ai/lobu/compare/lobu-v6.1.0...lobu-v6.1.1) (2026-05-10)


### Bug Fixes

* **cli:** make lobu run self-contained ([4e5c86b](https://github.com/lobu-ai/lobu/commit/4e5c86ba4c7fe19931d2f83b4094e33bc16efa71))
* preflight production database migrations ([#563](https://github.com/lobu-ai/lobu/issues/563)) ([c51a85b](https://github.com/lobu-ai/lobu/commit/c51a85b7b4d98af7b5b64ab34977d4d5ef118645))
* scaffold provider and platform env placeholders ([#565](https://github.com/lobu-ai/lobu/issues/565)) ([587074d](https://github.com/lobu-ai/lobu/commit/587074d0f5cd8e3f6651ee990ba38902efeeebdc))
* workspace membership consistency ([668fe06](https://github.com/lobu-ai/lobu/commit/668fe060b2341d4c6422fe81043fc332c62d0502))

## [6.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v6.0.1...lobu-v6.1.0) (2026-05-09)


### Features

* **auth:** send welcome email on signup ([d687938](https://github.com/lobu-ai/lobu/commit/d68793865d5933b79fe862eae9c71e739075bc95))
* **cli:** non-interactive init, project link, beefier doctor ([#521](https://github.com/lobu-ai/lobu/issues/521)) ([1b02761](https://github.com/lobu-ai/lobu/commit/1b027610b2075a2fbd73c7ada1cc6a57ad3f7bd4))
* **connectors:** add normalized GitHub stargazer identities ([f59f5ef](https://github.com/lobu-ai/lobu/commit/f59f5ef6208962a7c8722f80a7fdd6680711c959))
* **mcp:** add dry-run preview for SDK run tool ([b991ef9](https://github.com/lobu-ai/lobu/commit/b991ef9ac824c30bb9eac4fe9e6db839439ad76d))
* **mcp:** add memory tool aliases ([d61846b](https://github.com/lobu-ai/lobu/commit/d61846bedce1fa909643e840309416fd4ab4cb35))
* **mcp:** normalize tool names and audit sharp calls ([864acb0](https://github.com/lobu-ai/lobu/commit/864acb05da37935a0f020fd2dc0570031a65b861))


### Bug Fixes

* address unaddressed Codex review comments from [#478](https://github.com/lobu-ai/lobu/issues/478) / [#498](https://github.com/lobu-ai/lobu/issues/498) / [#521](https://github.com/lobu-ai/lobu/issues/521) ([#535](https://github.com/lobu-ai/lobu/issues/535)) ([1c704f0](https://github.com/lobu-ai/lobu/commit/1c704f0e2612df47d3665ecb12a857c88699e2ed))
* **build:** build embeddings before connector-worker ([#528](https://github.com/lobu-ai/lobu/issues/528)) ([1979f5c](https://github.com/lobu-ai/lobu/commit/1979f5cda459a8355a8ee835feefb996b23a0a0d))
* **chat-instance:** self-bind org context in startInstance for boot + webhooks ([#522](https://github.com/lobu-ai/lobu/issues/522)) ([5257162](https://github.com/lobu-ai/lobu/commit/5257162e0db4fc8a9cbd2f3522e56cef2404d1f9))
* **ci:** restore patches directory for docker builds ([4ffe1c9](https://github.com/lobu-ai/lobu/commit/4ffe1c95fe4c0b22f7e827b824bdeb71ad5705cd))
* cluster of bugs surfaced by parallel bug-hunting subagents ([#523](https://github.com/lobu-ai/lobu/issues/523)) ([680fe4d](https://github.com/lobu-ai/lobu/commit/680fe4d78793ad7322798c375c9de11f74095add))
* complete memory config flattening ([4154651](https://github.com/lobu-ai/lobu/commit/415465137c06411c59b0e59443eff1ff26927a36))
* **connectors:** recover reddit sync and watcher memory auth ([#542](https://github.com/lobu-ai/lobu/issues/542)) ([48adcb4](https://github.com/lobu-ai/lobu/commit/48adcb4a1516f2f246e9671966ae53e48309dc45))
* **connectors:** use claimed_at instead of nonexistent started_at on runs ([#515](https://github.com/lobu-ai/lobu/issues/515)) ([5db2c86](https://github.com/lobu-ai/lobu/commit/5db2c865571646636341ca3fe1cd0410af916155))
* **db:** guard chat_connections copy on table existence ([#525](https://github.com/lobu-ai/lobu/issues/525)) ([7d95910](https://github.com/lobu-ai/lobu/commit/7d95910630bc7db64c7b1674e660f86426d6c027))
* **docker/worker:** build @lobu/core before connector-sdk in worker image ([#530](https://github.com/lobu-ai/lobu/issues/530)) ([3d8e233](https://github.com/lobu-ai/lobu/commit/3d8e233de150a02c6dfd9987b5e0960160cc93ec))
* **docker:** build embeddings before connector worker in app image ([#541](https://github.com/lobu-ai/lobu/issues/541)) ([9169103](https://github.com/lobu-ai/lobu/commit/9169103434b308a827084c9d8ebbc557538578f0))
* **docker:** remove deleted owletto package copies from app image ([#539](https://github.com/lobu-ai/lobu/issues/539)) ([2e0f092](https://github.com/lobu-ai/lobu/commit/2e0f0922b0b52467b67964396932d837b0dc72da))
* dogfood workflow + auth bug allowing cross-org OAuth ([#536](https://github.com/lobu-ai/lobu/issues/536)) ([feae13a](https://github.com/lobu-ai/lobu/commit/feae13aa680213a05baf6b3120a9b02a99921e4f))
* drop @types/node override, align embeddings to 20.19.9 ([#524](https://github.com/lobu-ai/lobu/issues/524)) ([b28530d](https://github.com/lobu-ai/lobu/commit/b28530d5c87bdf82d488e41f744cc0567272777c))
* format tools.ts (collapse stripEnv to one line) ([#518](https://github.com/lobu-ai/lobu/issues/518)) ([a0ecd6e](https://github.com/lobu-ai/lobu/commit/a0ecd6e0c59b9ed91bd4c67e29bffbd9461353d9))
* **gateway:** handle missing Lobu org context ([b513001](https://github.com/lobu-ai/lobu/commit/b513001d5e41177ec3bc4ef61990334f273a9d99))
* **gateway:** initialize memory tool listing ([#545](https://github.com/lobu-ai/lobu/issues/545)) ([f1614d7](https://github.com/lobu-ai/lobu/commit/f1614d72e87a94e26c5fd5b496807626225da0c2))
* **gateway:** unscoped agent route + fake LLM e2e harness + validateUrlDomain bypass ([#532](https://github.com/lobu-ai/lobu/issues/532)) ([04036b5](https://github.com/lobu-ai/lobu/commit/04036b5151af84317ddc760f443c1ed2e94e2df6))
* **server:** speed up event thread context lookups ([#558](https://github.com/lobu-ai/lobu/issues/558)) ([adcf965](https://github.com/lobu-ai/lobu/commit/adcf9659e6f867d194d6d48eabf24851aca9c673))
* unblock npx install ([#500](https://github.com/lobu-ai/lobu/issues/500)) and onboard DeepSeek V4 default ([#503](https://github.com/lobu-ai/lobu/issues/503)) ([#519](https://github.com/lobu-ai/lobu/issues/519)) ([98bd94e](https://github.com/lobu-ai/lobu/commit/98bd94e97cb9f75abdb0b06e55793fd5a907cfbf))
* **watchers:** accept ISO datetime aliases ([#549](https://github.com/lobu-ai/lobu/issues/549)) ([53dcc4a](https://github.com/lobu-ai/lobu/commit/53dcc4aab04147ff91a54f8248015db6e55a7db9))
* **watchers:** infer running completion run ([#550](https://github.com/lobu-ai/lobu/issues/550)) ([b0e816a](https://github.com/lobu-ai/lobu/commit/b0e816a1e7997a28ea4f6a878e6d6e150be12460))
* **watchers:** link exact window content ids ([#551](https://github.com/lobu-ai/lobu/issues/551)) ([da3f7c9](https://github.com/lobu-ai/lobu/commit/da3f7c91a702fe18fd7072925ff734704f637a0d))
* **watchers:** page source reads by cursor ([#556](https://github.com/lobu-ai/lobu/issues/556)) ([2507773](https://github.com/lobu-ai/lobu/commit/2507773429323c9dba9db4a3eff92cea2a25900a))
* **web:** redirect root visitors to login ([#555](https://github.com/lobu-ai/lobu/issues/555)) ([91091b6](https://github.com/lobu-ai/lobu/commit/91091b65fcb144646d0ac7daf42ceb18fcb5a3d0))
* **worker:** accept nested platform metadata ([#547](https://github.com/lobu-ai/lobu/issues/547)) ([0e8769c](https://github.com/lobu-ai/lobu/commit/0e8769cbbdc918e0edfb46c40b674384118bd396))

## [6.0.1](https://github.com/lobu-ai/lobu/compare/lobu-v6.0.0...lobu-v6.0.1) (2026-05-04)


### Bug Fixes

* **ci:** restore lobu-* image names so prod can pull them ([#512](https://github.com/lobu-ai/lobu/issues/512)) ([f4f841c](https://github.com/lobu-ai/lobu/commit/f4f841c34c95be9068173a8efee026cc9ac886ca))
* **connectors:** replace Deno-style 'npm:' specifiers with real deps ([#513](https://github.com/lobu-ai/lobu/issues/513)) ([ecdeb7c](https://github.com/lobu-ai/lobu/commit/ecdeb7ce4269d4be3d500cdc111278b9f0b2fff8))
* **publish:** add re-export shims to deprecated redirect packages ([#510](https://github.com/lobu-ai/lobu/issues/510)) ([cb499fc](https://github.com/lobu-ai/lobu/commit/cb499fcac01ae7cb20ae09c1c44496655bb77155))

## [6.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v5.0.0...lobu-v6.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* external MCP clients calling `manage_connections` or `manage_auth_profiles` directly will receive `Tool not found`. Move those callers to the REST proxy at `POST /api/{orgSlug}/{toolName}`.
* **lobu-backend:** the `execute` MCP tool is removed. External MCP clients must switch to `run` (mutating scripts) or `query` (read-only scripts). The internal `manage_connections` and `manage_auth_profiles` tools are no longer visible on the public MCP surface; CLI/web flows continue to reach them via the REST proxy.

### Features

* **cli:** align agent management with web API ([#491](https://github.com/lobu-ai/lobu/issues/491)) ([86e0b25](https://github.com/lobu-ai/lobu/commit/86e0b254186a6cb0fc24b6837499723547572b5c))
* **cli:** replace bespoke device login with OAuth 2.0 device-code flow ([#489](https://github.com/lobu-ai/lobu/issues/489)) ([3a8ec73](https://github.com/lobu-ai/lobu/commit/3a8ec7396e14edaa6a4c4dc4911a388dc8113e4b))
* **connectors:** add reddit user_activity feed ([#445](https://github.com/lobu-ai/lobu/issues/445)) ([f53c6a1](https://github.com/lobu-ai/lobu/commit/f53c6a1ce6ee63a548a0ef67dadd0dc06f529675))
* drop Docker/K8s deployment modes — embedded-only ([5fef6c2](https://github.com/lobu-ai/lobu/commit/5fef6c27a4ce3474a6935ddd702c1f9233f46e5c))
* **identity:** facts-as-events identity engine ([475baab](https://github.com/lobu-ai/lobu/commit/475baab3da2d13d1f45834e3f572ceb97fdc4ce3))
* **landing:** Attio-style landing redesign with use-case-driven hero ([0e7af50](https://github.com/lobu-ai/lobu/commit/0e7af505acd6e16ec8a7284edff41d861709d12a))
* **landing:** dark mode support with system preference detection ([#497](https://github.com/lobu-ai/lobu/issues/497)) ([da7f8cd](https://github.com/lobu-ai/lobu/commit/da7f8cd8f3fb148ad41d7ee2670c58915d8099ee))
* migrate browser-auth to REST, demote manage_* to internal MCP ([#439](https://github.com/lobu-ai/lobu/issues/439)) ([9f883a5](https://github.com/lobu-ai/lobu/commit/9f883a5d56c92665da27bce37886d97e665565d5))
* **lobu-backend:** 401 + WWW-Authenticate for unauth /mcp ([#438](https://github.com/lobu-ai/lobu/issues/438)) ([ae703fa](https://github.com/lobu-ai/lobu/commit/ae703fa69478fc3d54a464ef3e7c99a51c3bff7c))
* **lobu-backend:** split MCP execute into query (read-only) + run (full) ([#432](https://github.com/lobu-ai/lobu/issues/432)) ([aef8254](https://github.com/lobu-ai/lobu/commit/aef825435dbc4a5015b5f6cc35419940e245e6a5))
* **scheduler:** unified TaskScheduler — replace setInterval maintenance loop ([#478](https://github.com/lobu-ai/lobu/issues/478)) ([ab4ee13](https://github.com/lobu-ai/lobu/commit/ab4ee1383535e1abe2ec9eea1202b4fc9aadaeb4))
* **watchers:** edit propagates across the group; snapshot version_id on runs ([#485](https://github.com/lobu-ai/lobu/issues/485)) ([7a18f83](https://github.com/lobu-ai/lobu/commit/7a18f83acab4be1e5f0e3b0b2db2cdeec60b9f92))
* **worker:** per-exec OS sandbox for spawned binaries in embedded mode ([daa25d7](https://github.com/lobu-ai/lobu/commit/daa25d7065d2abe1584642d7c94378c8c707b6d2))


### Bug Fixes

* **connectors:** bundle pino + link-preview-js instead of externalising ([#448](https://github.com/lobu-ai/lobu/issues/448)) ([7486f39](https://github.com/lobu-ai/lobu/commit/7486f393197ab9d0b980800c9c2562e13566189a))
* **db:** drop legacy event source id ([#419](https://github.com/lobu-ai/lobu/issues/419)) ([560c073](https://github.com/lobu-ai/lobu/commit/560c0731b10197bd8dc40c5781cfed517bffb111))
* **db:** tenant-scoped FK on connections.auth_profile references ([#447](https://github.com/lobu-ai/lobu/issues/447)) ([891f7ab](https://github.com/lobu-ai/lobu/commit/891f7ab45abdd16e90377a7187c25f79e9491eb0))
* **embedded:** default MEMORY_URL so dispatcher service tokens validate ([#451](https://github.com/lobu-ai/lobu/issues/451)) ([596cd9c](https://github.com/lobu-ai/lobu/commit/596cd9c877a838d663fae085ff159fe418f466b7))
* **events:** make creator attribution nullable ([#418](https://github.com/lobu-ai/lobu/issues/418)) ([b7f59f5](https://github.com/lobu-ai/lobu/commit/b7f59f51f2041b5ffb42e2e025881190f599eac7))
* **execute:** bundle backend so prod runs under Node + isolated-vm ([#433](https://github.com/lobu-ai/lobu/issues/433)) ([20afae5](https://github.com/lobu-ai/lobu/commit/20afae540b02983e47a38d8cb7650b15f2907a5d))
* **execute:** harden sandbox runtime ([#427](https://github.com/lobu-ai/lobu/issues/427)) ([343cc03](https://github.com/lobu-ai/lobu/commit/343cc03962ef4e26e795664f7a07ca50716dc724))
* **execute:** run backend under Node so isolated-vm loads ([#430](https://github.com/lobu-ai/lobu/issues/430)) ([71c74e1](https://github.com/lobu-ai/lobu/commit/71c74e18600c8d5c1c21c0638b994a05aefbc687))
* **get_watcher:** bound unprocessedCount scan even on fresh watchers ([#486](https://github.com/lobu-ai/lobu/issues/486)) ([da2d9ef](https://github.com/lobu-ai/lobu/commit/da2d9ef60f3cd86922392290e12c448c2e06314f))
* **get_watcher:** cap unprocessedCount scan at 1000 rows ([#487](https://github.com/lobu-ai/lobu/issues/487)) ([c548440](https://github.com/lobu-ai/lobu/commit/c5484407efd8922d347966af10034e2fc685380a))
* harden lobu memory watcher reliability ([#498](https://github.com/lobu-ai/lobu/issues/498)) ([459c7b2](https://github.com/lobu-ai/lobu/commit/459c7b2910a676f84d73cab522e34bd3e5013058))
* **landing:** send start CTA to app ([#492](https://github.com/lobu-ai/lobu/issues/492)) ([ed112a4](https://github.com/lobu-ai/lobu/commit/ed112a412df082bf97938e81f9580dd96873dc8f))
* **list_watchers:** cap pending-content total at 1000 rows ([#488](https://github.com/lobu-ai/lobu/issues/488)) ([e296a99](https://github.com/lobu-ai/lobu/commit/e296a9952b2dad0a3eee415f9aee7f50ae393a67))
* **lobu-backend:** make classification reconciliation candidate query selective ([#454](https://github.com/lobu-ai/lobu/issues/454)) ([4b83739](https://github.com/lobu-ai/lobu/commit/4b837390d0de44a6003ffd0a10354512558091fc))
* **lobu-backend:** MCP rough edges — org scope, paginated SDK examples, knowledge.delete tombstone ([#442](https://github.com/lobu-ai/lobu/issues/442)) ([6f2ae98](https://github.com/lobu-ai/lobu/commit/6f2ae988b802393f6653485cacac3727c91452c9))
* **lobu-backend:** re-register list_watchers/get_watcher/read_knowledge for REST ([#434](https://github.com/lobu-ai/lobu/issues/434)) ([dac1603](https://github.com/lobu-ai/lobu/commit/dac1603f7e3c5988e3656e4753539351fd510308))
* **public-pages:** serve scrapeable HTML for generic clients ([#415](https://github.com/lobu-ai/lobu/issues/415)) ([818c804](https://github.com/lobu-ai/lobu/commit/818c804fde615724d6b02c3a278345508b465919))
* **public-pages:** skip SSR shell for signed-in users ([4c31a04](https://github.com/lobu-ai/lobu/commit/4c31a04543035ac0928bc22c623025031062dfbb))
* **reddit:** request identity scope so /api/v1/me works ([#449](https://github.com/lobu-ai/lobu/issues/449)) ([2fc08d8](https://github.com/lobu-ai/lobu/commit/2fc08d80e3fa61eff7c6c386c4f63374cf16f4f7))
* **watchers:** connector dep hygiene + dispatcher fail-closed ([#444](https://github.com/lobu-ai/lobu/issues/444)) ([b4bb37f](https://github.com/lobu-ai/lobu/commit/b4bb37fd62c26b085d0490972d3b261cab445db5))
* **watchers:** include watcher_group_id in list response; bump lobu-web for inline version chip ([#435](https://github.com/lobu-ai/lobu/issues/435)) ([4f9db5a](https://github.com/lobu-ai/lobu/commit/4f9db5a1437d531e5263bf431dcefa076156c087))
* **worker:** skip --import tsx when running under Bun ([#412](https://github.com/lobu-ai/lobu/issues/412)) ([39e031d](https://github.com/lobu-ai/lobu/commit/39e031d512561db27215a44469995ca11c043eb1))


### Performance Improvements

* **events:** fold visibility into get_content WHERE; drop entity lookup ([#455](https://github.com/lobu-ai/lobu/issues/455)) ([9f0566b](https://github.com/lobu-ai/lobu/commit/9f0566b04c4ded0d9b58d70497ede0b1a8b686c0))
* **get_watcher:** consolidate to 3 round-trips per page open ([#482](https://github.com/lobu-ai/lobu/issues/482)) ([61c5606](https://github.com/lobu-ai/lobu/commit/61c5606311295e9d1c9124d209a5e9a4e46c0433))
* **get_watcher:** delete dead cold-path queries, bound unprocessedCount ([#481](https://github.com/lobu-ai/lobu/issues/481)) ([e533449](https://github.com/lobu-ai/lobu/commit/e5334494d31a689584db912bb42e14962b0f8234))
* **watchers:** fix /watchers/:id timeouts — slim get_watcher to first-paint queries ([#479](https://github.com/lobu-ai/lobu/issues/479)) ([a3b98fc](https://github.com/lobu-ai/lobu/commit/a3b98fcd125204bbbaa3c906afc900c408a8aabc))


### Reverts

* **execute:** drop runtime swap in [#430](https://github.com/lobu-ai/lobu/issues/430) — keep prod on bun ([#431](https://github.com/lobu-ai/lobu/issues/431)) ([f6115d8](https://github.com/lobu-ai/lobu/commit/f6115d8e9f79a8cf0d145db5c5c62f54387165ef))

## [5.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.3.0...lobu-v5.0.0) (2026-04-27)


### ⚠ BREAKING CHANGES

* **db:** convert entities.entity_type to entity_type_id FK ([#370](https://github.com/lobu-ai/lobu/issues/370))

### Features

* **agents:** public install endpoint for template agents ([#357](https://github.com/lobu-ai/lobu/issues/357)) ([4fb42ed](https://github.com/lobu-ai/lobu/commit/4fb42edc321afcaabc4f84add654ec8c4a290df6))
* **agents:** public install manifest endpoint + slug-based install ([#362](https://github.com/lobu-ai/lobu/issues/362)) ([74d8e39](https://github.com/lobu-ai/lobu/commit/74d8e398de9821c8b168e9d5ed7a095940751757))
* **agents:** schema-mirror + install flow for template agents ([#369](https://github.com/lobu-ai/lobu/issues/369)) ([48bdb20](https://github.com/lobu-ai/lobu/commit/48bdb201fd88ec5054544bcbe791efd2ae4a1d80))
* **auth:** auto-provision personal org on user signup ([#352](https://github.com/lobu-ai/lobu/issues/352)) ([deff32a](https://github.com/lobu-ai/lobu/commit/deff32aa14c8d7d0bf9b4dcfc38fbe25de51e740))
* **auth:** provision $member entity + identities on signup and install ([#359](https://github.com/lobu-ai/lobu/issues/359)) ([db1e199](https://github.com/lobu-ai/lobu/commit/db1e199b1f3ee92c4afcaae549faf8359965cf01))
* **db:** convert entities.entity_type to entity_type_id FK ([#370](https://github.com/lobu-ai/lobu/issues/370)) ([ab7ecde](https://github.com/lobu-ai/lobu/commit/ab7ecde23bc0d257595fa44c6e16cecdbfb3966e))
* **examples:** add personal-finance project for UK Self Assessment ([#350](https://github.com/lobu-ai/lobu/issues/350)) ([5852ea6](https://github.com/lobu-ai/lobu/commit/5852ea6de6650077ca7ed025f3b9f8924a4117cf))
* **examples:** company-aware world model for personal-finance ([#358](https://github.com/lobu-ai/lobu/issues/358)) ([0df7e19](https://github.com/lobu-ai/lobu/commit/0df7e190a0e901cbdbdcb8b1107648dc45b7083b))
* **examples:** evals for personal-finance agent (SA102/SA105/SA108 + behavioral) ([#356](https://github.com/lobu-ai/lobu/issues/356)) ([cf49872](https://github.com/lobu-ai/lobu/commit/cf49872e09ab866577b193aff44c39d33506f813))
* **examples:** Phase 2 — FX, allowance windows, filing timeline ([#360](https://github.com/lobu-ai/lobu/issues/360)) ([820af04](https://github.com/lobu-ai/lobu/commit/820af0430d54ae798a2aa577f81e95af157b8dde))
* **examples:** SA100 assembly playbook for personal-finance agent ([#354](https://github.com/lobu-ai/lobu/issues/354)) ([76d627d](https://github.com/lobu-ai/lobu/commit/76d627d61795c0ef5cbdff67c81382340d15132f))
* **examples:** statement ingestion playbook + Nix tooling ([#355](https://github.com/lobu-ai/lobu/issues/355)) ([d82d76c](https://github.com/lobu-ai/lobu/commit/d82d76ce236ad98d754f13a2da0ba02373d142b7))
* **landing:** add siloed-vs-shared memory topology section ([#375](https://github.com/lobu-ai/lobu/issues/375)) ([c759955](https://github.com/lobu-ai/lobu/commit/c7599556764bc1b9437f55b85e966ccb84c70b6c))
* **landing:** canonical https://lobu.ai/mcp endpoint with OAuth proxy and tracing ([#389](https://github.com/lobu-ai/lobu/issues/389)) ([29c6d2f](https://github.com/lobu-ai/lobu/commit/29c6d2f74ff622c6f1a78ec8c359a13f88c9ba1c))
* **lobu-backend:** multi-org execute + search MCP tools ([#348](https://github.com/lobu-ai/lobu/issues/348)) ([bb4ff94](https://github.com/lobu-ai/lobu/commit/bb4ff94d046acc4c8db74e5585764bb592e925a9))
* **watchers:** per-field feedback storage with mutation kinds ([#363](https://github.com/lobu-ai/lobu/issues/363)) ([5e0c16e](https://github.com/lobu-ai/lobu/commit/5e0c16ed4012a2e4330ae5802d60c1752797c4b9))
* **worker,backend:** capture subprocess output and exit metadata on run records ([#376](https://github.com/lobu-ai/lobu/issues/376)) ([02eb47a](https://github.com/lobu-ai/lobu/commit/02eb47a2af63b57538a75393a576d76ceb0ff2ab))
* **world-model:** allow read-only cross-org list_rules ([#399](https://github.com/lobu-ai/lobu/issues/399)) ([b30dc63](https://github.com/lobu-ai/lobu/commit/b30dc6347eea136a78d7b24fb98f63e0bbdc5ef0))
* **world-model:** cross-org references — schema search path + write guard ([#374](https://github.com/lobu-ai/lobu/issues/374)) ([426b2e2](https://github.com/lobu-ai/lobu/commit/426b2e2efda58dc73f57cb510ad4afe3cf4c7549))
* **world-model:** cross-org relationship_types + catalog discovery ([#377](https://github.com/lobu-ai/lobu/issues/377)) ([bfb7dfb](https://github.com/lobu-ai/lobu/commit/bfb7dfbd05c45047b2cecc2a2d07897da2f23f17))
* **world-model:** cross-org schema CRUD + read-side tolerance ([#386](https://github.com/lobu-ai/lobu/issues/386)) ([1fbdd35](https://github.com/lobu-ai/lobu/commit/1fbdd35f02a0a3ebf08b36ffd7a5758581441ee4))


### Bug Fixes

* **ci:** deploy landing functions by running wrangler from packages/landing ([#391](https://github.com/lobu-ai/lobu/issues/391)) ([7c3676b](https://github.com/lobu-ai/lobu/commit/7c3676be2c34ae4e9c7b9710a4d464882e53fa7e))
* **connector-catalog,worker-auth:** externalize on resolve fail; pino err serialization ([#405](https://github.com/lobu-ai/lobu/issues/405)) ([eb84fe4](https://github.com/lobu-ai/lobu/commit/eb84fe4f8d3ceebbd40fceaf47291092504bb4cb))
* **db:** add dbmate up/down directives to repair-agent migrations ([#390](https://github.com/lobu-ai/lobu/issues/390)) ([8a115dd](https://github.com/lobu-ai/lobu/commit/8a115dd520ee3c9768f2aebcf5ea262eb49ab23d))
* **db:** backfill events.created_by NULLs before NOT NULL validate ([#392](https://github.com/lobu-ai/lobu/issues/392)) ([bb7cce3](https://github.com/lobu-ai/lobu/commit/bb7cce3b5ca8de9a6825c8ed7cf9984430c2ac81))
* **db:** drop CONCURRENTLY from migration's index recreation ([#402](https://github.com/lobu-ai/lobu/issues/402)) ([bccd3da](https://github.com/lobu-ai/lobu/commit/bccd3daceae6ddc444004e723a8cfa01bd7177d8))
* **db:** drop CONCURRENTLY from migration's index recreation ([#403](https://github.com/lobu-ai/lobu/issues/403)) ([7870f0d](https://github.com/lobu-ai/lobu/commit/7870f0dab002004ae1569cffb54b064d07651182))
* **db:** scope baseline's search_path reset to migration transaction ([#406](https://github.com/lobu-ai/lobu/issues/406)) ([ba33bae](https://github.com/lobu-ai/lobu/commit/ba33baec1013ec209c966eb961fa86a634bac27f))
* **db:** SET lock_timeout = 0 for events.created_by backfill ([#396](https://github.com/lobu-ai/lobu/issues/396)) ([5224b92](https://github.com/lobu-ai/lobu/commit/5224b92a464956ef32b3373fd1706a6f771756c8))
* **db:** single UPDATE backfill — chunked DO LOOP exceeded liveness budget ([#395](https://github.com/lobu-ai/lobu/issues/395)) ([b9cd8ca](https://github.com/lobu-ai/lobu/commit/b9cd8cad38d0b85ef9762b9370bcd4656e8a4835))
* **landing:** defer cal.com iframe until schedule dialog opens ([#398](https://github.com/lobu-ai/lobu/issues/398)) ([d86e7db](https://github.com/lobu-ai/lobu/commit/d86e7dbcfedee084911b778042ab7b1786c6cd59))
* **landing:** point Scalar API reference at the real /openapi.json ([#394](https://github.com/lobu-ai/lobu/issues/394)) ([8046abe](https://github.com/lobu-ai/lobu/commit/8046abe0b1eac7f1fd03bda8463f4146158fa0cd))
* **landing:** satisfy isitagentready.com checks for markdown + OAuth metadata ([#397](https://github.com/lobu-ai/lobu/issues/397)) ([8d84627](https://github.com/lobu-ai/lobu/commit/8d84627ed6412fa8daad7ad2d6d02d2f0d1dea8c))
* set working-directory to packages/landing and deploy ./dist. ([7c3676b](https://github.com/lobu-ai/lobu/commit/7c3676be2c34ae4e9c7b9710a4d464882e53fa7e))
* **worker:** drop unused code/signal params from computeExitReason ([#388](https://github.com/lobu-ai/lobu/issues/388)) ([7aa3406](https://github.com/lobu-ai/lobu/commit/7aa340621b6a4910b42b41682db1a538dd00d458))
* **world-model:** cross-org schema validation + defensive count scoping + tests ([#407](https://github.com/lobu-ai/lobu/issues/407)) ([576dae5](https://github.com/lobu-ai/lobu/commit/576dae56d48ebf87704cfc30b3f38bdcbeec1ce7))


### Reverts

* **install-flow:** remove template-install pipeline ([#369](https://github.com/lobu-ai/lobu/issues/369), [#357](https://github.com/lobu-ai/lobu/issues/357), [#362](https://github.com/lobu-ai/lobu/issues/362), [#359](https://github.com/lobu-ai/lobu/issues/359) install-half) ([#372](https://github.com/lobu-ai/lobu/issues/372)) ([d5dfbc2](https://github.com/lobu-ai/lobu/commit/d5dfbc22814906999efc86fc618fb515e622f14e))

## [4.3.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.2.0...lobu-v4.3.0) (2026-04-25)


### Features

* **ci:** autonomous PR triage workflow ([#349](https://github.com/lobu-ai/lobu/issues/349)) ([1fd4add](https://github.com/lobu-ai/lobu/commit/1fd4add1c69f62e11f5a9a788017253ff23fb0af))
* **examples:** add LLM-judged ping eval to each surfaced example ([#366](https://github.com/lobu-ai/lobu/issues/366)) ([d6aa5ad](https://github.com/lobu-ai/lobu/commit/d6aa5adb70f98220a3b583a994d0a155c86bed07))
* **gateway:** LLM-judged egress via per-skill `action: judge` ([#319](https://github.com/lobu-ai/lobu/issues/319)) ([#327](https://github.com/lobu-ai/lobu/issues/327)) ([0171679](https://github.com/lobu-ai/lobu/commit/017167907246f65ae83da6091b0b5b6670c4fe2d))
* **watchers:** in-process lifecycle tracker, durable correlation, drop heartbeat ([#336](https://github.com/lobu-ai/lobu/issues/336)) ([51be366](https://github.com/lobu-ai/lobu/commit/51be366129315ffcc1c7f94bdc135e541eaf4a3a))


### Bug Fixes

* **auth:** align Claude OAuth client with public CLI to avoid 429 ([#345](https://github.com/lobu-ai/lobu/issues/345)) ([aa91a81](https://github.com/lobu-ai/lobu/commit/aa91a81da7ce0caa1afa18f3ab37a24888f37502))
* **ci:** bump landing deploy to Node 22 for Astro 6 ([#344](https://github.com/lobu-ai/lobu/issues/344)) ([1eb9d60](https://github.com/lobu-ai/lobu/commit/1eb9d603cb1c6be549ac6b8927f4875d024253b7))
* **cli:** migrate to @inquirer/prompts to fix Node 25 readline crash ([#364](https://github.com/lobu-ai/lobu/issues/364)) ([8ab0dd9](https://github.com/lobu-ai/lobu/commit/8ab0dd9c9d41f9bc8436a7e2d038f78bb5453f50))
* **embedded-lobu:** make the embedded gateway boot cleanly in the lobu app image ([#332](https://github.com/lobu-ai/lobu/issues/332)) ([c378015](https://github.com/lobu-ai/lobu/commit/c378015e51adf7fbf688684bcb1684680b2f38d3))
* **events:** tolerate stale client_id refs on insert + relax FK ([#339](https://github.com/lobu-ai/lobu/issues/339)) ([5c19d26](https://github.com/lobu-ai/lobu/commit/5c19d26bdf6604aba88c44ee437773abb2e9f071))
* **gateway,dev-native:** thread worker entryPoint through config, unblock native dev ([#347](https://github.com/lobu-ai/lobu/issues/347)) ([e5ff4d8](https://github.com/lobu-ai/lobu/commit/e5ff4d8d5bd73b02cf010d64a668610a4fde7767))
* **mcp-handler,entity-management:** SSE close race + classify entity-type errors ([#340](https://github.com/lobu-ai/lobu/issues/340)) ([4b4649a](https://github.com/lobu-ai/lobu/commit/4b4649aef22db89f8a4fe6abe787ec7bd321b01b))
* **lobu-backend:** unblock image builds after dead-code refactor ([#329](https://github.com/lobu-ai/lobu/issues/329)) ([5619e1f](https://github.com/lobu-ai/lobu/commit/5619e1f338c312cff299e73170e6d247a4382704))
* post-merge review follow-ups (path traversal, Sentry PII, Slack instr guard, MCP join rate-limit) ([#325](https://github.com/lobu-ai/lobu/issues/325)) ([3faad40](https://github.com/lobu-ai/lobu/commit/3faad40d0da299f683c492de84623aea2332f6eb))
* **resolve_path:** return 4xx instead of throwing on client-input errors ([#338](https://github.com/lobu-ai/lobu/issues/338)) ([326f543](https://github.com/lobu-ai/lobu/commit/326f543a90539a7504918b8c56743140384a5f17))
* **sentry:** disable NodeSystemError integration to unblock node v24 builds ([#341](https://github.com/lobu-ai/lobu/issues/341)) ([4124e00](https://github.com/lobu-ai/lobu/commit/4124e0094129d4c625cbad5f3026bac031159542))
* stabilize multiple security and reliability gaps across gateway ([#321](https://github.com/lobu-ai/lobu/issues/321)) ([3c6efc2](https://github.com/lobu-ai/lobu/commit/3c6efc284d8273cd598ad3747922e5ac36d2316b))
* **watchers:** no-op complete_window when all events already analyzed ([#337](https://github.com/lobu-ai/lobu/issues/337)) ([495d615](https://github.com/lobu-ai/lobu/commit/495d615034804382ed9e8606a74b979f57cb0136))


### Performance Improvements

* **auth:** consolidate better-auth onto shared postgres.js pool ([#342](https://github.com/lobu-ai/lobu/issues/342)) ([012754a](https://github.com/lobu-ai/lobu/commit/012754ad70f78e9b25a9664133db19eafdacd747))

## [4.2.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.1.0...lobu-v4.2.0) (2026-04-23)


### Features

* **core:** add guardrail primitive ([#254](https://github.com/lobu-ai/lobu/issues/254)) ([#317](https://github.com/lobu-ai/lobu/issues/317)) ([912dfff](https://github.com/lobu-ai/lobu/commit/912dfffbe78a3cfa0e0664338ee8a9c4fd826110))
* **gateway:** Gemini Code Assist OAuth for CI smoke ([#315](https://github.com/lobu-ai/lobu/issues/315)) ([e4957d0](https://github.com/lobu-ai/lobu/commit/e4957d007993268dbaf7074721953da5a88205cd))
* **lobu-backend:** accept entity_link_overrides at install/create/connect ([#318](https://github.com/lobu-ai/lobu/issues/318)) ([c08e052](https://github.com/lobu-ai/lobu/commit/c08e0521df83b78fd669ce794110e61e49429443))

## [4.1.0](https://github.com/lobu-ai/lobu/compare/lobu-v4.0.1...lobu-v4.1.0) (2026-04-23)


### Features

* add separate Lobu and Lobu starter skill installs ([#304](https://github.com/lobu-ai/lobu/issues/304)) ([d0a4bc4](https://github.com/lobu-ai/lobu/commit/d0a4bc4d7ef61c56250b698805ae854396391469))
* **landing:** rewrite hero headline and subhead for agent-first pitch ([#312](https://github.com/lobu-ai/lobu/issues/312)) ([044b1ed](https://github.com/lobu-ai/lobu/commit/044b1ed5eb2fa1ea578701673cc1922afeee1e3d))
* **lobu-backend:** centralize transactional email + rebrand to Lobu ([#314](https://github.com/lobu-ai/lobu/issues/314)) ([4db7a1e](https://github.com/lobu-ai/lobu/commit/4db7a1e2e3dc7c214f13fa5d0bea885db080617a))
* **lobu-backend:** gate $member list to members, emails to admins ([#309](https://github.com/lobu-ai/lobu/issues/309)) ([c37c72f](https://github.com/lobu-ai/lobu/commit/c37c72f6473838163149b12c8677d8dda6acabb2))
* **lobu-backend:** public-org read access + self-serve join ([#296](https://github.com/lobu-ai/lobu/issues/296)) ([38cf00f](https://github.com/lobu-ai/lobu/commit/38cf00f09c51d57fbe5d1fb3f8811f84b2d35756))


### Bug Fixes

* **landing:** move outcome channel into outcome box ([#306](https://github.com/lobu-ai/lobu/issues/306)) ([885ab61](https://github.com/lobu-ai/lobu/commit/885ab6171bbc3e347e32c3dbf36583eef2b4f215))
* **lobu-backend:** add missing memberRole to internal ToolContext literals ([#311](https://github.com/lobu-ai/lobu/issues/311)) ([dce8105](https://github.com/lobu-ai/lobu/commit/dce8105ba0de3c4e03ba7ce268cd3e2899cc2a61))
* **lobu-backend:** exclude watcher runs from worker poll claims ([#313](https://github.com/lobu-ai/lobu/issues/313)) ([afd5d7b](https://github.com/lobu-ai/lobu/commit/afd5d7b78ed5f2125e655349079aff3b0658106e))

## [4.0.1](https://github.com/lobu-ai/lobu/compare/lobu-v4.0.0...lobu-v4.0.1) (2026-04-21)


### Bug Fixes

* **ci:** correct jq precedence in codex-auto-approve lookup ([#300](https://github.com/lobu-ai/lobu/issues/300)) ([86063c6](https://github.com/lobu-ai/lobu/commit/86063c647af6f92c0cd8f32b46f0237ff3487c7d))
* **gateway:** gate agent API handlers with ownership check to prevent cross-tenant access ([#285](https://github.com/lobu-ai/lobu/issues/285)) ([ec8ff6b](https://github.com/lobu-ai/lobu/commit/ec8ff6bb28389acc023a9b363bb8bbd7813518ad))

## [4.0.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.7.0...lobu-v4.0.0) (2026-04-21)


### ⚠ BREAKING CHANGES

* **core, worker:** drop unused public exports from @lobu/core ([#281](https://github.com/lobu-ai/lobu/issues/281))

### Features

* **landing:** restore Integrate dropdown on copy-prompt CTAs ([#289](https://github.com/lobu-ai/lobu/issues/289)) ([bf565f1](https://github.com/lobu-ai/lobu/commit/bf565f190a3f211b6be5b135fe0cb1cda1f1f1e7))


### Bug Fixes

* **docker:** include lobu workspaces in Dockerfile.worker ([#274](https://github.com/lobu-ai/lobu/issues/274)) ([2aa042b](https://github.com/lobu-ai/lobu/commit/2aa042bce577fd4c498a5defbaa532515b39dd23))
* **gateway:** escape user input in MCP OAuth callback to prevent XSS ([#284](https://github.com/lobu-ai/lobu/issues/284)) ([ab19e8a](https://github.com/lobu-ai/lobu/commit/ab19e8ac569df321866921fd64b59bca9d01920d))
* **gateway:** require worker auth on /api/bedrock/* to prevent unauthenticated AWS spend ([#287](https://github.com/lobu-ai/lobu/issues/287)) ([5e6e91c](https://github.com/lobu-ai/lobu/commit/5e6e91c32a75e872a052705854277d8114b5c240))
* **landing:** repair broken links surfaced by audit ([#275](https://github.com/lobu-ai/lobu/issues/275)) ([1de4aee](https://github.com/lobu-ai/lobu/commit/1de4aee458e9039396f62b6d357c1c5450040b27))
* **landing:** resolve zod parse error on connect-from route ([#271](https://github.com/lobu-ai/lobu/issues/271)) ([cef2284](https://github.com/lobu-ai/lobu/commit/cef2284ab1c1e10f1406f43301378036767dbafa))
* **landing:** wire benchmark methodology link and add tables to memory + comparison ([#276](https://github.com/lobu-ai/lobu/issues/276)) ([39a0436](https://github.com/lobu-ai/lobu/commit/39a043696a4910f931d885dfe6baa48f5570d0fe))
* **lobu-backend:** use parameter binding in content-search to prevent SQL injection ([#286](https://github.com/lobu-ai/lobu/issues/286)) ([65511c1](https://github.com/lobu-ai/lobu/commit/65511c1fc2eb13a3ebd180ca341a8d74ea57a877))


### Code Refactoring

* **core, worker:** drop unused public exports from @lobu/core ([#281](https://github.com/lobu-ai/lobu/issues/281)) ([7c5ffa4](https://github.com/lobu-ai/lobu/commit/7c5ffa40139add5f100cb34fcda4aa173b3180f2))

## [3.7.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.6.0...lobu-v3.7.0) (2026-04-21)


### Features

* inline memory config into lobu.toml and rename devops→engineering ([#247](https://github.com/lobu-ai/lobu/issues/247)) ([1daf272](https://github.com/lobu-ai/lobu/commit/1daf2728bec2b374a52c2212231ae641f439e89a))
* **landing:** add memory benchmarks section + methodology docs ([#242](https://github.com/lobu-ai/lobu/issues/242)) ([28e2980](https://github.com/lobu-ai/lobu/commit/28e2980796ed037aca37f90ab7785f95050c83d0))
* **lobu-backend:** allow lobu.ai to embed app via CSP frame-ancestors ([#246](https://github.com/lobu-ai/lobu/issues/246)) ([6cbf3d2](https://github.com/lobu-ai/lobu/commit/6cbf3d29aafee5b5c80f389c25e54c9eb3afc267))
* **lobu:** absorb skills, benchmarks, and dev scripts from deprecated lobu repo ([#231](https://github.com/lobu-ai/lobu/issues/231)) ([ccef71e](https://github.com/lobu-ai/lobu/commit/ccef71e1b2e3c58d79a767a84f919777b724cc44))
* **lobu:** consolidate CLI profiles into lobu.toml ([#233](https://github.com/lobu-ai/lobu/issues/233)) ([577ec37](https://github.com/lobu-ai/lobu/commit/577ec3731c70faea3272128b26ad2787d4198a99))
* subdomain-aware SPA + SSR routing ([#234](https://github.com/lobu-ai/lobu/issues/234)) ([9c66f16](https://github.com/lobu-ai/lobu/commit/9c66f16cd4b16d96356de05e3aa401e6499f0d5e))


### Bug Fixes

* **ci:** initialize lobu-web submodule in landing deploy ([#229](https://github.com/lobu-ai/lobu/issues/229)) ([0dee7bc](https://github.com/lobu-ai/lobu/commit/0dee7bc8c229562b9335aa226f765af563fe25f5))
* **deps:** sync bun.lock with release-please 3.6.0 version bump ([#227](https://github.com/lobu-ai/lobu/issues/227)) ([e14500c](https://github.com/lobu-ai/lobu/commit/e14500c1ab0d60e50ad38c5c59b8b4f8fa45362b))
* **landing:** restore campaign description from runtime.request ([#250](https://github.com/lobu-ai/lobu/issues/250)) ([56eac67](https://github.com/lobu-ai/lobu/commit/56eac673486777867c5115ba174f019a0dbe245b))
* **lobu-backend:** resolve default org when loading social credentials ([#235](https://github.com/lobu-ai/lobu/issues/235)) ([90419cc](https://github.com/lobu-ai/lobu/commit/90419ccd931328f402f9dfbc16b97fb7f355a1a9))
* ship app.lobu.ai SPA + retire lobu.com defaults ([#230](https://github.com/lobu-ai/lobu/issues/230)) ([e3817d4](https://github.com/lobu-ai/lobu/commit/e3817d41732b51fcbde1b56e69b0da85a1fb51d8))
* **web:** bump lobu-web for history adapter import fix ([#237](https://github.com/lobu-ai/lobu/issues/237)) ([279a3ed](https://github.com/lobu-ai/lobu/commit/279a3edabeb32080168180f33cf42ccae11f9ef0))
* **web:** bump lobu-web for public-org auth-redirect fix ([#240](https://github.com/lobu-ai/lobu/issues/240)) ([f4641eb](https://github.com/lobu-ai/lobu/commit/f4641eb163bdc78fdc90dcd5d826f62360144e69))
* **web:** bump lobu-web for sidebar auth gating ([#238](https://github.com/lobu-ai/lobu/issues/238)) ([e51458e](https://github.com/lobu-ai/lobu/commit/e51458e2998705c987c4de84478719d34d093c3e))
* **web:** bump lobu-web for sidebar gating + add reserved-subdomain parity test ([#241](https://github.com/lobu-ai/lobu/issues/241)) ([8961e58](https://github.com/lobu-ai/lobu/commit/8961e5865e99d12996e70df1679188f38ad95458))
* **web:** bump lobu-web for subdomain history adapter ([#236](https://github.com/lobu-ai/lobu/issues/236)) ([a53c978](https://github.com/lobu-ai/lobu/commit/a53c978331acb9fff5b0b2eda2830dc68a6f42e5))

## [3.6.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.5.0...lobu-v3.6.0) (2026-04-20)


### Features

* **backend:** wildcard trusted origins + reserved subdomain skip-list ([#214](https://github.com/lobu-ai/lobu/issues/214)) ([7656f2b](https://github.com/lobu-ai/lobu/commit/7656f2bf465a0cb2ea7eb91ec123c42ae015bb02))
* consolidate lobu into the lobu monorepo (PRs 1–4) ([#212](https://github.com/lobu-ai/lobu/issues/212)) ([a6d0d3f](https://github.com/lobu-ai/lobu/commit/a6d0d3f9a46696b5874e1a4029ab8f73e579a4e3))
* **gateway:** file-driven agent schedules in lobu.toml ([#211](https://github.com/lobu-ai/lobu/issues/211)) ([6b2eb51](https://github.com/lobu-ai/lobu/commit/6b2eb5128584d0d7d7cfaa38f203684ce422709f))
* **landing:** architecture diagram badges, blog section, and use-case chat examples ([#206](https://github.com/lobu-ai/lobu/issues/206)) ([969e5ee](https://github.com/lobu-ai/lobu/commit/969e5ee6e96858521187c7af8aaeeb35786516d3))
* **landing:** consolidate use-case demo into unified trace view ([#226](https://github.com/lobu-ai/lobu/issues/226)) ([c030fa7](https://github.com/lobu-ai/lobu/commit/c030fa709bcd9423224214276e3cd315cce67cff))
* **landing:** per-use-case chat switcher on platform pages ([#202](https://github.com/lobu-ai/lobu/issues/202)) ([f65cc35](https://github.com/lobu-ai/lobu/commit/f65cc3567a30059c8589264610f4531ec11e89e8))
* **landing:** publish agent-readiness signals for lobu.ai ([#208](https://github.com/lobu-ai/lobu/issues/208)) ([8360cef](https://github.com/lobu-ai/lobu/commit/8360cefd6401afa1271f21a01f11a09231aada09))


### Bug Fixes

* **ci:** skip web build when lobu-web is stubbed ([#222](https://github.com/lobu-ai/lobu/issues/222)) ([acee38a](https://github.com/lobu-ai/lobu/commit/acee38aae91b8389553800ccdbbace542460b89f))
* **docker:** build gateway dist + exclude tests from backend typecheck ([#219](https://github.com/lobu-ai/lobu/issues/219)) ([96b0033](https://github.com/lobu-ai/lobu/commit/96b00332c637262d6a22bc624ddee802e938d519))
* **docker:** name lobu-cli stub package as 'lobu' (unscoped) ([#215](https://github.com/lobu-ai/lobu/issues/215)) ([17fba3f](https://github.com/lobu-ai/lobu/commit/17fba3fac7b910f39d3bad256befa85e9ad9876c))
* **docker:** unzip in runtime + worker chromium install via bunx ([#216](https://github.com/lobu-ai/lobu/issues/216)) ([019253e](https://github.com/lobu-ai/lobu/commit/019253e8977cf8b0c14b38d5045abd6952b25a5c))
* **docker:** use bun run build for lobu-web (local vite) ([#221](https://github.com/lobu-ai/lobu/issues/221)) ([7734259](https://github.com/lobu-ai/lobu/commit/7734259b4886b2ab1cbb44468a689b8b5aff33f2))
* **gateway,worker:** deliver provider base URLs via session context only ([#225](https://github.com/lobu-ai/lobu/issues/225)) ([9171d37](https://github.com/lobu-ai/lobu/commit/9171d37d34cbe07fd004ee2e7842b8a66328e46b))
* **gateway:** isolate tsconfig from root bun-types ([#220](https://github.com/lobu-ai/lobu/issues/220)) ([c533e27](https://github.com/lobu-ai/lobu/commit/c533e274217d2af6177f902fd4cf0502f73192b5))
* **gateway:** Lobu MCP sync, Slack markdown/threading, tool-approval lifecycle, deployment coalescing ([#210](https://github.com/lobu-ai/lobu/issues/210)) ([92ce0eb](https://github.com/lobu-ai/lobu/commit/92ce0eb3308e4d4b476c96b60d5f8e45803d9597))
* **landing:** refine Lobu memory section copy ([#205](https://github.com/lobu-ai/lobu/issues/205)) ([9075d6c](https://github.com/lobu-ai/lobu/commit/9075d6c74f33716429b030c4406b10e28450b63d))
* **lobu-backend:** resolve *.lobu.ai as org subdomain under AUTH_COOKIE_DOMAIN ([#224](https://github.com/lobu-ai/lobu/issues/224)) ([c893aae](https://github.com/lobu-ai/lobu/commit/c893aaedb64ac3437e081641947dca297f390f79))
* **lobu-backend:** resolve typecheck errors blocking build-images ([#218](https://github.com/lobu-ai/lobu/issues/218)) ([7ce6271](https://github.com/lobu-ai/lobu/commit/7ce62711bd2c35d763d01f35426e24e07dc88bf4))
* **worker:** QA hardening for careops agent (Gemini support, UploadUserFile workspace paths, dedup error messages) ([#203](https://github.com/lobu-ai/lobu/issues/203)) ([8026d5d](https://github.com/lobu-ai/lobu/commit/8026d5d341c5738961f8179a3ab9f5acb72b797e))

## [3.5.0](https://github.com/lobu-ai/lobu/compare/lobu-v3.4.3...lobu-v3.5.0) (2026-04-16)


### Features

* add /skills/for/{useCase} routes, version eval schema, clean up duplication ([d84a856](https://github.com/lobu-ai/lobu/commit/d84a856a307916b87641426e0d2de48f89442089))
* add 20-minute timeout to all GitHub Actions workflows ([0798d77](https://github.com/lobu-ai/lobu/commit/0798d777908090c285eeda35074739e54dae6bf7))
* add agent-community use case and extract UseCaseTabs label prop ([ba956ad](https://github.com/lobu-ai/lobu/commit/ba956ad13bdb642e22c3ed6bc2a7c00128d2ff72))
* add Bedrock provider and AWS deployment docs ([#171](https://github.com/lobu-ai/lobu/issues/171)) ([9210a36](https://github.com/lobu-ai/lobu/commit/9210a362f8bbc85ac37ded05e6fb95173d1f12a0))
* add CLI and create-peerbot packages with platform-agnostic architecture ([4674b47](https://github.com/lobu-ai/lobu/commit/4674b4769989b8302605b4bb0b254f0b53f2d350))
* add direct sessions API for browser/CLI clients ([c34ab3c](https://github.com/lobu-ai/lobu/commit/c34ab3c0b4be5161e94eb98584f0819b36e2d872))
* add direct sessions API for browser/CLI clients ([8f78d87](https://github.com/lobu-ai/lobu/commit/8f78d87b39f51f58b318b61f8f139b426e2b18dd))
* add ecommerce use case to landing page ([4982606](https://github.com/lobu-ai/lobu/commit/498260638532f7da16400a0bf6f1aca7e8ff3f46))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([a3d6f3a](https://github.com/lobu-ai/lobu/commit/a3d6f3ab46d40cabf18f08807c5a4ac4c57d52ea))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([0f98b23](https://github.com/lobu-ai/lobu/commit/0f98b235c04c5a7b536d77ed4edddf7edcc31022))
* add file handling, Slack Assistant support, and comprehensive MCP OAuth system ([44214cf](https://github.com/lobu-ai/lobu/commit/44214cf5ad174235a9551921215b5decfc1dd72a))
* add force npm publish workflow for emergency release ([92965fc](https://github.com/lobu-ai/lobu/commit/92965fcebda8b3c1d1f7d1d987d66459a71c117b))
* add Gemini integration and improve gateway/worker architecture ([331cdda](https://github.com/lobu-ai/lobu/commit/331cddaff94a4ccee01ff4e52e095ea611d9f77b))
* add github package support and enable plan mode ([b9ccf5d](https://github.com/lobu-ai/lobu/commit/b9ccf5df45082d286ea0f8c988dd9a14a04f3e77))
* add manual npm publish workflow for existing releases ([e1c13d4](https://github.com/lobu-ai/lobu/commit/e1c13d448ca2078f134d38cbfc4934577cdcc8cc))
* add MCP registry service and discovery routes ([fbff9bf](https://github.com/lobu-ai/lobu/commit/fbff9bf0da6d18ea9e06b0ca1b678330c5d2bb09))
* add multi-platform support to CLI init wizard ([2597712](https://github.com/lobu-ai/lobu/commit/2597712762c5caa506622c2b1b129b8daac04aca))
* add network isolation, HTTP proxy, and enhanced worker configuration ([d3a7db1](https://github.com/lobu-ai/lobu/commit/d3a7db15f0e78e2c59782937400a414e334771a7))
* add platform-agnostic messaging API with self-queueing and MAX_TURNS protection ([c872522](https://github.com/lobu-ai/lobu/commit/c872522fdeeff6f00696cb746c2e615b72924dbb))
* add privacy policy page and footer link ([b9df04f](https://github.com/lobu-ai/lobu/commit/b9df04fffab714edaa569f447bb29b96c0c65c07))
* add Reddit and X (Twitter) as OAuth integrations ([7a57b9c](https://github.com/lobu-ai/lobu/commit/7a57b9c7b8a1f021923a5718c63e95000d20cf3e))
* add Slack multi-workspace OAuth distribution ([137ec6a](https://github.com/lobu-ai/lobu/commit/137ec6af3105e24fdc1735e0f4a6cc7ca131e939))
* add user interaction system with forms and suggestions ([18db834](https://github.com/lobu-ai/lobu/commit/18db8342cb69bc1a76b426652640c60a040106e5))
* **ci:** migrate Docker images from Docker Hub to GHCR ([c01824a](https://github.com/lobu-ai/lobu/commit/c01824a6e7a59ee202145df5471ee9f863380eb3))
* **cli,gateway:** multi-agent CLI, external OAuth, agent seeding ([d4dba49](https://github.com/lobu-ai/lobu/commit/d4dba4998f2914d07d9528abc0a3b48a564ec8cc))
* **cli,landing:** add connections CLI + themeable chat component ([506b91c](https://github.com/lobu-ai/lobu/commit/506b91c5f4136c3867b509b4c2c52529d14ab778))
* **cli:** add lobu eval command with model comparison and CI workflow ([910da9b](https://github.com/lobu-ai/lobu/commit/910da9bd32fbc4f38a9479f3d5b070fe6def52b2))
* **cli:** add WhatsApp, Teams, and Google Chat to init platform choices ([d140b3b](https://github.com/lobu-ai/lobu/commit/d140b3be6f67958c843dfe29df74976897576fef))
* **config:** add system skills for integrations and LLM providers ([de25b3c](https://github.com/lobu-ai/lobu/commit/de25b3c885c6ec1301da998a1c38aac371b8e430))
* **config:** add system skills, skill registries, and MCP example config ([cb356d0](https://github.com/lobu-ai/lobu/commit/cb356d077eea2338d9b31b4c76db5e92d5f44e27))
* **core:** add integration, provider config, and skill metadata types ([94c1012](https://github.com/lobu-ai/lobu/commit/94c1012b28d1d7d9209f56ee8e8f237b212c0f7b))
* enable WhatsApp support in community deployment ([658bb25](https://github.com/lobu-ai/lobu/commit/658bb256ece4fc3bf3d61e238a2f4d850bcd8f34))
* enhance Docker security and simplify session management ([3f68c50](https://github.com/lobu-ai/lobu/commit/3f68c50376731470cd8a6912403ef631430e39ad))
* enhance MCP OAuth integration and worker session management ([abfdeb4](https://github.com/lobu-ai/lobu/commit/abfdeb469aadd51923ecceab5159e561d917499c))
* expand landing use cases and normalize network grants ([e9b0282](https://github.com/lobu-ai/lobu/commit/e9b02825b2c721fa4cde8a5a68d07e5ddfd4c993))
* **gateway:** add integration framework — OAuth, credential store, API proxy ([0a19e2d](https://github.com/lobu-ai/lobu/commit/0a19e2d0ebaaf6910efe8e66a1135a2bbec0d419))
* **gateway:** add MCP OAuth 2.1 auth-code + PKCE flow ([9ea9f45](https://github.com/lobu-ai/lobu/commit/9ea9f45dedb9aa0f5ef740b949cd6b51fa8bf2ee))
* **gateway:** add optional body text to link-button cards ([#183](https://github.com/lobu-ai/lobu/issues/183)) ([1e93013](https://github.com/lobu-ai/lobu/commit/1e93013d542d4021fe33b4029b58b6329c4b19bd))
* **gateway:** agent selector + per-user agent stores ([f1c0d85](https://github.com/lobu-ai/lobu/commit/f1c0d85f339a9b670078af2d821d56ad1911582c))
* **gateway:** embedded runtime credential resolver + secret-backed device auth ([8b3053a](https://github.com/lobu-ai/lobu/commit/8b3053a80c5aeb3fa05bcf1e3c379a691103c882))
* **gateway:** improve OAuth UX on settings page by removing auto-redirect and adding login button ([2757725](https://github.com/lobu-ai/lobu/commit/2757725c6a4a2c450d003389235f334cb1e70f75))
* **gateway:** integration services, config-driven providers, and orchestration updates ([170e824](https://github.com/lobu-ai/lobu/commit/170e824c5c5f00f8ac8093d051f683e83d558cd6))
* **gateway:** proxy-driven MCP tool approval with execute-on-approve ([cde529a](https://github.com/lobu-ai/lobu/commit/cde529ac3433820b40be2639412d89b2a3673314))
* **gateway:** settings page overhaul — skills section, integration status, remove env vars ([02b3160](https://github.com/lobu-ai/lobu/commit/02b3160d2b3234e99a2b714355096c76d75d9ec1))
* **gateway:** support leading-dot domain patterns in GrantStore ([f2a1006](https://github.com/lobu-ai/lobu/commit/f2a1006e4a9769c90bf5521332c87a8c0ed156ff))
* harden file delivery flows and add OpenRouter CI evals ([676544c](https://github.com/lobu-ai/lobu/commit/676544c1d9871debd6116a638108ad2a757fd1af))
* implement multi-tenant space architecture ([abc195f](https://github.com/lobu-ai/lobu/commit/abc195f52d8aa02c4c04b5c27476906774fd4f6b))
* implement multi-tenant space architecture ([16b8723](https://github.com/lobu-ai/lobu/commit/16b8723b218d3fd3bc4af0b83cc1600030350b9c))
* improve Claude OAuth authentication flow ([4cc1051](https://github.com/lobu-ai/lobu/commit/4cc10510d3aceea1f095fbc3b06d046a06325e62))
* improve first-time setup UX and add upgrade instructions ([e3df936](https://github.com/lobu-ai/lobu/commit/e3df936c6e1094155cad5d1ebbeeb8367d50c77a))
* improve status indicators and error handling ([7a7684a](https://github.com/lobu-ai/lobu/commit/7a7684a076a542098d3d250bb56cc3072a6b057f))
* **landing:** add connect-from pages and refresh use-case content ([1ce6f6c](https://github.com/lobu-ai/lobu/commit/1ce6f6c0754aa8adfa45f6dc0738f5931717dbf1))
* **landing:** add interactive prompt + output demo to skills section ([dc8a806](https://github.com/lobu-ai/lobu/commit/dc8a80640d748dc9a9bf46b7223d3739a52e1770))
* **landing:** add posthog analytics ([b7b431d](https://github.com/lobu-ai/lobu/commit/b7b431d0bc30ddb1a104ed2473ab1aa7d695577c))
* **landing:** add terms of service page ([0347573](https://github.com/lobu-ai/lobu/commit/0347573d58d5aff6594713bb4a7277f7227d9e83))
* **landing:** embed OpenClaw creator tweet confirming single-user design ([4c6537b](https://github.com/lobu-ai/lobu/commit/4c6537b03aaa7218191c18a69b3b8d00c82e2297))
* **landing:** link OpenClaw runtime to comparison page with architecture reasoning ([2977bbb](https://github.com/lobu-ai/lobu/commit/2977bbb16d3415459793bacf1f3d769a763268b6))
* **landing:** migrate from Vite SPA to Astro with Starlight docs ([687c6f7](https://github.com/lobu-ai/lobu/commit/687c6f737f59f807d5e5723258d549593343b244))
* **landing:** remove Lobu for X labels and redundant use case summaries ([e861218](https://github.com/lobu-ai/lobu/commit/e861218120dbfc5265152bd09b2ab96a6202f5c3))
* **landing:** rename skills-as-saas to skills and update hero copy ([42009c5](https://github.com/lobu-ai/lobu/commit/42009c5d709cbdac0455512326757813d7f27805))
* **landing:** replace Telegram chat with terminal log for connections row ([2a3467e](https://github.com/lobu-ai/lobu/commit/2a3467e385bef38a1f066ed90482f1bd91cf5b3b))
* **landing:** revamp memory page demo ([96dba19](https://github.com/lobu-ai/lobu/commit/96dba192e07b7861b333c9d7f3fc72701527436a))
* **landing:** update copy prompt behavior and text ([a551a79](https://github.com/lobu-ai/lobu/commit/a551a7965c9c46aa2b44e2a29eecd065fd9c1f13))
* live per-agent MCP install flow with discovery and no worker restart ([#106](https://github.com/lobu-ai/lobu/issues/106)) ([435202b](https://github.com/lobu-ai/lobu/commit/435202b965f85a2085e604c463a74f6163111316))
* make examples/ single source of truth for use cases and Lobu orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* make skills page init preview contextual to selected use-case ([146e87a](https://github.com/lobu-ai/lobu/commit/146e87ad8838c5dd03c5f27900636e05c527823f))
* **mcp-auth:** surface login prompts as platform link buttons ([9ca5449](https://github.com/lobu-ai/lobu/commit/9ca5449a48321db1e6a81f3ab1172b8768f272fc))
* migrate gateway to Hono and remove Express from worker ([#94](https://github.com/lobu-ai/lobu/issues/94)) ([499ab1b](https://github.com/lobu-ai/lobu/commit/499ab1b992267017872e90ecb2a662186cd574e3))
* migrate lobu examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* migrate Lobu plugin to published @lobu/lobu-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* move workspace files to worker filesystem, fix CI, lint cleanup ([142d0c8](https://github.com/lobu-ai/lobu/commit/142d0c8c96a7eb9a0d6792809bbefbd2bbb7027e))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* multi-provider auth, MCP REST API, workspace instructions, dev tooling ([2e08491](https://github.com/lobu-ai/lobu/commit/2e084912a65f495d16f090a7abe2e37f08a356c8))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* **observability:** vendor-neutral OTEL tracing + opt-in Sentry ([#172](https://github.com/lobu-ai/lobu/issues/172)) ([f3345d3](https://github.com/lobu-ai/lobu/commit/f3345d364cfa28c9cc8f9c801041ccb1fd492b5c))
* **otel:** switch from OTLP HTTP to gRPC exporter (port 4317) ([60178db](https://github.com/lobu-ai/lobu/commit/60178db403596efadcd3124e367b06287f7696ba))
* Lobu memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* re-enable custom tools and remove unused claudeSessionId tracking ([2adb766](https://github.com/lobu-ai/lobu/commit/2adb766077f1d688ba93ca1994b260aff3f6e4b8))
* refactor settings page to Alpine.js with pre-compiled Tailwind ([2126001](https://github.com/lobu-ai/lobu/commit/2126001d4e720eae0b99c7b22cd9fcb342ea174a))
* refresh cli docs and restore release publish chain ([#179](https://github.com/lobu-ai/lobu/issues/179)) ([1ee0595](https://github.com/lobu-ai/lobu/commit/1ee0595d354b0dee1a85d4b3015fd1c9adcab4a0))
* refresh landing pages and pricing UX ([c8d8b58](https://github.com/lobu-ai/lobu/commit/c8d8b58fd6ea4b16583d67259e61839dc9ee1f52))
* rename CTA to "Open in Lobu" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **settings:** add generic OpenAI provider ([fcae8c3](https://github.com/lobu-ai/lobu/commit/fcae8c30497d52263787930588763b64934160ae))
* **settings:** add generic OpenAI provider ([f60e93a](https://github.com/lobu-ai/lobu/commit/f60e93af00324191d7f842cb4f99ec8501aa5e04))
* **settings:** post-install callback with agent resume ([d96e99b](https://github.com/lobu-ai/lobu/commit/d96e99b120054cebad862f788eef427faefb4e40))
* show nix packages in landing skill previews ([6095e13](https://github.com/lobu-ai/lobu/commit/6095e13447d9d7c3e6214a9995b9994645ee8bf9))
* **skills:** add scoring, URI, and system skill search to SearchSkills ([d63d7a8](https://github.com/lobu-ai/lobu/commit/d63d7a8e1a0b16dfcd8761a1ed54690cd84616c6))
* support Telegram webhooks when PUBLIC_GATEWAY_URL is set ([c3d266e](https://github.com/lobu-ai/lobu/commit/c3d266e59ef45c386bcf7ccbe3808dbf18abb3f4))
* wire file-first lobu memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
* **worker:** ConnectService, CallService, DisconnectService tools and integration runtime ([af5a270](https://github.com/lobu-ai/lobu/commit/af5a270ba8e5d66e77cb7cd9c1d495d183e22a44))
* **worker:** expand ConnectService to support AI provider setup ([45b0c93](https://github.com/lobu-ai/lobu/commit/45b0c9396a759a14eb67c22347aee2de08e4543e))
* **worker:** generic MCP login tools + bash hardening ([5e167a4](https://github.com/lobu-ai/lobu/commit/5e167a41bf87f71704c7f936759624a26e959e85))
* **worker:** redact sandbox leaks, replace base prompt identity, use signed artifact URLs ([a5c33d8](https://github.com/lobu-ai/lobu/commit/a5c33d818d9de4e0bef8fd1710a2244f8592e33f))


### Bug Fixes

* add CSS generation step to CI typecheck job ([de4e500](https://github.com/lobu-ai/lobu/commit/de4e500d7e2e29727b136e03e062ba35ffb2bc20))
* add CSS generation step to gateway Dockerfile ([d361129](https://github.com/lobu-ai/lobu/commit/d3611292caadd929c89e4b7fbabb27da9f3c632c))
* add default model fallback per provider and fix z-ai base URL env var ([ebb8237](https://github.com/lobu-ai/lobu/commit/ebb82377c966a4cb44d033dc8744958f447f7133))
* add HTTP to HTTPS redirect for community.lobu.ai ([1b22074](https://github.com/lobu-ai/lobu/commit/1b220743ab0e366586cdb4118f3c6578fe690cc7))
* add missing orchestrator defaults to Helm values ([b882ad3](https://github.com/lobu-ai/lobu/commit/b882ad3056645b3c5691db23684b4327c1530044))
* add production environment to Docker publish workflow and clean up outputs ([9fe8120](https://github.com/lobu-ai/lobu/commit/9fe812050fa603c62764108f734b76284080b76c))
* add production environment to release-please workflow for npm publishing ([1cd6121](https://github.com/lobu-ai/lobu/commit/1cd6121d15876e223a2a741c0839cc6c4e3c99fc))
* add production environment to release-please workflow for npm publishing ([92a5c26](https://github.com/lobu-ai/lobu/commit/92a5c26aca24b5ab395c9a9ae6299177a156d4ec))
* address critical security and functionality issues in direct sessions API ([782f617](https://github.com/lobu-ai/lobu/commit/782f617ba4cc1f66f3d5e9a27366a5ae90845b13))
* apply code formatting fixes ([0e17f0c](https://github.com/lobu-ai/lobu/commit/0e17f0c38f5fd08b616cf7648a89b4f49b4bea98))
* build core package before running tests in CI ([1752131](https://github.com/lobu-ai/lobu/commit/175213174d40d3b2dfe17af179dacb6490b248be))
* build only required packages for npm publishing ([55065a7](https://github.com/lobu-ai/lobu/commit/55065a773f1d86785732ea2b116447013cbb3d35))
* **ci:** add group-pull-request-title-pattern for merge plugin ([#200](https://github.com/lobu-ai/lobu/issues/200)) ([d01fe2e](https://github.com/lobu-ai/lobu/commit/d01fe2ebe30bba653775a683458c667ead5697fd))
* **ci:** bump Bun to 1.3.5 to fix CONNECT test failures ([1970c9a](https://github.com/lobu-ai/lobu/commit/1970c9a7ad5380134c5da514a88847dbc520ca8d))
* **ci:** drop package-name from release-please config to fix auto-tagging ([#190](https://github.com/lobu-ai/lobu/issues/190)) ([31056a2](https://github.com/lobu-ai/lobu/commit/31056a2e8af8e9347aa7e6680109162e85509f17))
* **ci:** gate release steps on explicit true output ([47346e5](https://github.com/lobu-ai/lobu/commit/47346e54a866bc6700413e34621387b61d5cb924))
* **ci:** guard docker sha tags on release events ([#181](https://github.com/lobu-ai/lobu/issues/181)) ([48b75ac](https://github.com/lobu-ai/lobu/commit/48b75ac8154c801bbdc8676412cf5fabe804d8aa))
* **ci:** include component in title pattern to fix release-please auto-tagging ([#194](https://github.com/lobu-ai/lobu/issues/194)) ([deaa3dc](https://github.com/lobu-ai/lobu/commit/deaa3dca4737fefb502d7982f37ed75abb122e33))
* **ci:** include component in title pattern to fix release-please auto-tagging ([#196](https://github.com/lobu-ai/lobu/issues/196)) ([524e715](https://github.com/lobu-ai/lobu/commit/524e715fe8da91adc8eb133afac18250b4010916))
* **ci:** pin bun version for landing deploy ([0c62bf0](https://github.com/lobu-ai/lobu/commit/0c62bf09804b9e5851c51f85b22fdbafd744f278))
* **ci:** put version in release-please PR title + add workflow_dispatch ([#176](https://github.com/lobu-ai/lobu/issues/176)) ([9021308](https://github.com/lobu-ai/lobu/commit/9021308ed7162a7bd20e08817c351a64684ed7c1))
* **ci:** reconcile release-please config + Chart.yaml appVersion ([#174](https://github.com/lobu-ai/lobu/issues/174)) ([c6ea7c8](https://github.com/lobu-ai/lobu/commit/c6ea7c8368f312f2deb10deb5e723ef76e23ece6))
* **ci:** release-please triggers publish-packages via gh workflow run ([87b14cb](https://github.com/lobu-ai/lobu/commit/87b14cbaea46df47be6e5a71d7fc498523c23995))
* **ci:** remove invalid secrets check from eval workflow job condition ([1889cc4](https://github.com/lobu-ai/lobu/commit/1889cc47c6b10c43d78a2a91e92f9ff5924c1559))
* **ci:** repair broken npm publish workflows ([6f6ea08](https://github.com/lobu-ai/lobu/commit/6f6ea08ec2f2d15e10933c1ecd993fe205dad55f))
* **ci:** restore release config for package releases ([6c7190c](https://github.com/lobu-ai/lobu/commit/6c7190ceff17b4b113e9036b5663c40ec01fe19f))
* **ci:** restore release manifest for package releases ([892cdc5](https://github.com/lobu-ai/lobu/commit/892cdc5d3fa91db47bd06e44ad1e9507a57f0f58))
* **ci:** restore release-please pull-request-title-pattern ([#186](https://github.com/lobu-ai/lobu/issues/186)) ([699f40b](https://github.com/lobu-ai/lobu/commit/699f40b0cf9375b25a76733f7351ca934730fe9d))
* **ci:** set empty component to fix release-please auto-tagging ([#192](https://github.com/lobu-ai/lobu/issues/192)) ([ec809f9](https://github.com/lobu-ai/lobu/commit/ec809f9069f0a8b79b0fab0b37eeb409783da67e))
* **ci:** set include-component-in-tag true so release-please auto-tags ([#197](https://github.com/lobu-ai/lobu/issues/197)) ([85cc88a](https://github.com/lobu-ai/lobu/commit/85cc88ae1c6ff4d4b69c276824162206bc5e0d3a))
* **ci:** sync bun lockfile ([16c91dd](https://github.com/lobu-ai/lobu/commit/16c91dd052f7571da9c144787afef670ccc09338))
* **ci:** upgrade npm to latest for OIDC trusted publishing ([a85bbb2](https://github.com/lobu-ai/lobu/commit/a85bbb280ea814c8ab6c8c2d576b18cd14817ff6))
* **ci:** use default release-please title pattern variables ([#178](https://github.com/lobu-ai/lobu/issues/178)) ([26709e3](https://github.com/lobu-ai/lobu/commit/26709e3c19e01ebf58220118a056833caf6ea50b))
* **ci:** use GitHub secret for Telegram token, not k8s sealed secret ([ff27697](https://github.com/lobu-ai/lobu/commit/ff27697611db35e5c7d1c31e0b6fdcd1f27c045e))
* **ci:** use Node 24 for bundled npm 11 (OIDC trusted publishing) ([3697004](https://github.com/lobu-ai/lobu/commit/3697004f3cf00a41e0dcbdaae2f7e539e9a7d00b))
* **ci:** use NODE_AUTH_TOKEN for npm auth instead of manual .npmrc ([606a82b](https://github.com/lobu-ai/lobu/commit/606a82ba9d7879a0a028fb63d1ab09e7e3f6326c))
* **ci:** use OIDC trusted publishing, drop stale NPM_TOKEN path ([e8f5ca0](https://github.com/lobu-ai/lobu/commit/e8f5ca08c70be3f0afc2b29c3f5ac3b78e0c8669))
* **ci:** use simpler release-please title pattern that actually works ([#188](https://github.com/lobu-ai/lobu/issues/188)) ([11e1e70](https://github.com/lobu-ai/lobu/commit/11e1e7056674b1ed67be9678ed4c1fa2a988a9c2))
* **ci:** use yaml updater for Chart.yaml version + appVersion ([58819bc](https://github.com/lobu-ai/lobu/commit/58819bc604ed04448a10e8a67535c8b1ff470911))
* clear mismatched default model in auto-mode provider selection ([ab20949](https://github.com/lobu-ai/lobu/commit/ab20949514d09158e33c4a0951cdda498a226c8d))
* clear stale session when provider changes ([080afe0](https://github.com/lobu-ai/lobu/commit/080afe0b1bb818a3166b55804d285290e101d0e1))
* **cli:** auth reliability — server-side logout, --force login, stale cred cleanup, concurrent refresh ([b0ee7a3](https://github.com/lobu-ai/lobu/commit/b0ee7a3cf89be660254febed38481f26f7a95eec))
* **cli:** hide hidden skills from 'lobu skills list' ([abbf99e](https://github.com/lobu-ai/lobu/commit/abbf99e93a6a60e2828e6222324835b2faac403e))
* **cli:** replace RequestInfo with portable fetch input type ([ba23c4a](https://github.com/lobu-ai/lobu/commit/ba23c4a260949f75e81876dd4e85e35449d5cada))
* **cli:** restore system skills and add CLI to publish workflow ([1fc3687](https://github.com/lobu-ai/lobu/commit/1fc3687985505bf6dd9133b94f162bdd568947c4))
* correct session-manager tests to use proper session key format ([45af581](https://github.com/lobu-ai/lobu/commit/45af581e3ee97e0a8433362a9437c7634edbeb79))
* deduplicate lobu URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
* delete existing webhook before starting Telegram long polling ([c6cd02c](https://github.com/lobu-ai/lobu/commit/c6cd02c8f2bc711934764823448723feda6d503f))
* **deploy:** remove broken global.imageRegistry that caused double-slash in Bitnami Redis image paths ([e37d81c](https://github.com/lobu-ai/lobu/commit/e37d81c79593234b9fb44aa2f2e1b9150fa3678f))
* **deploy:** update sealed secrets with all required keys ([fbe588e](https://github.com/lobu-ai/lobu/commit/fbe588e8296746a29f1ddb12af56f56856f3b420))
* disable Nix sandbox for arm64 QEMU builds ([e54e712](https://github.com/lobu-ai/lobu/commit/e54e712a5360899e67722159232e04a2b90bee8a))
* disable WhatsApp in community deployment (no credentials) ([2e14197](https://github.com/lobu-ai/lobu/commit/2e14197530f6c6328f8e048c10ec2bdd5b891499))
* **docs:** correct outdated references across documentation ([b78fa65](https://github.com/lobu-ai/lobu/commit/b78fa65611ca556fb672b52a950c03e73c741cab))
* **docs:** fix Teams Chat SDK link and update CLI generated files list ([737a3d7](https://github.com/lobu-ai/lobu/commit/737a3d747aa9cc62f9d8334743c1a22167357159))
* **eval:** continue running remaining evals after individual failures ([8187b7f](https://github.com/lobu-ai/lobu/commit/8187b7f3f9422b3ec919878f64034be40e70cc17))
* **eval:** create data dir for Redis persistence in CI ([3f7f598](https://github.com/lobu-ai/lobu/commit/3f7f598ea25aa3a03a2da2465ebe1bfcb27e9bd7))
* **eval:** disable Redis RDB persistence in CI to avoid MISCONF errors ([c131bbb](https://github.com/lobu-ai/lobu/commit/c131bbb4eeaa8c628d9528963ecf9fad66741752))
* **eval:** don't override provider/model unless --model flag is set ([8b8bd4b](https://github.com/lobu-ai/lobu/commit/8b8bd4b1c02d6c630da41c900973604c69b32487))
* **eval:** don't pass provider/model to session creation, use agent config ([49f3b4d](https://github.com/lobu-ai/lobu/commit/49f3b4df506751b5b1a62ede913e5abc9c84f761))
* **eval:** improve judge prompts with prose fallback, CI runs smoke only ([6876107](https://github.com/lobu-ai/lobu/commit/6876107f5620341056bc821accaad33d14d15333))
* **eval:** isolate trials + feat(worker): MCP-as-CLI for embedded mode ([#184](https://github.com/lobu-ai/lobu/issues/184)) ([c256d6d](https://github.com/lobu-ai/lobu/commit/c256d6d2604b514df9eb2c5658524079286e73b9))
* **eval:** pass Z_AI_API_KEY to gateway container in docker-compose ([ad890e3](https://github.com/lobu-ai/lobu/commit/ad890e35add1fee8285b241415b53d1984a2302d))
* export ActionButton and ModuleSessionContext types and fix implicit any ([6d6bc01](https://github.com/lobu-ai/lobu/commit/6d6bc01ff53e912f5a6bc584b6e99b132a18fd75))
* **gateway:** escape oauth callback template values ([#122](https://github.com/lobu-ai/lobu/issues/122)) ([d4cfc45](https://github.com/lobu-ai/lobu/commit/d4cfc45dacd6bec48c3c904f751a863b9f6510e6))
* **gateway:** preserve base path when mounted as sub-app ([edc0be5](https://github.com/lobu-ai/lobu/commit/edc0be54a5a1d56d771a0b70541d3752306779f9))
* **gateway:** publish embedded runtime packages ([148e7dc](https://github.com/lobu-ai/lobu/commit/148e7dcfb47b8a29c5e7f14926a55a3b5754e09b))
* **gateway:** redact secrets in agent config response ([#127](https://github.com/lobu-ai/lobu/issues/127)) ([6af4424](https://github.com/lobu-ai/lobu/commit/6af44241faa9f1fae60eba49423528a295d1a4c1))
* **gateway:** remove settings token query exposure ([#130](https://github.com/lobu-ai/lobu/issues/130)) ([9d4adb8](https://github.com/lobu-ai/lobu/commit/9d4adb83ffbcd128250704d5cf19859eaaf0193a))
* **gateway:** require auth for channel binding routes ([#123](https://github.com/lobu-ai/lobu/issues/123)) ([6736fe9](https://github.com/lobu-ai/lobu/commit/6736fe9ede187f71a7c513b20cf2f1c528188a10))
* **gateway:** require settings token for chatgpt start/poll ([#124](https://github.com/lobu-ai/lobu/issues/124)) ([4004401](https://github.com/lobu-ai/lobu/commit/4004401d78aa6e62a65661c1b0e3f229873a6c31))
* **gateway:** skip enqueuing worker delivery receipts to thread response queue ([c5c352d](https://github.com/lobu-ai/lobu/commit/c5c352d50b9dfd80570bb78743735eb94adb38d3))
* **gateway:** stop logging WhatsApp credential payloads ([#128](https://github.com/lobu-ai/lobu/issues/128)) ([68968b5](https://github.com/lobu-ai/lobu/commit/68968b57c8384e52939daca407c3f8f3a308050c))
* handle empty HOME env in git cache fallback ([c00ebfe](https://github.com/lobu-ai/lobu/commit/c00ebfe5f0e55bb8b68e3a0a0e14378a8998affc))
* **helm:** expose ADMIN_PASSWORD and platform tokens as gateway env vars ([968f4a8](https://github.com/lobu-ai/lobu/commit/968f4a89b230c0608a48f851fcda7f77ce046992))
* **helm:** make claude-code-oauth-token secret ref optional ([992a2e6](https://github.com/lobu-ai/lobu/commit/992a2e6c2652781975285bd0b14618990c90ded0))
* **helm:** remove platform token env vars from gateway deployment ([062f18f](https://github.com/lobu-ai/lobu/commit/062f18f71f82538c0ee343e608e4861e78e9a281))
* improve error handling for streaming validation errors ([ea72817](https://github.com/lobu-ai/lobu/commit/ea72817918823efbac688b9ae84e73289399c648))
* improve team ID handling in Slack events ([d083365](https://github.com/lobu-ai/lobu/commit/d083365b5eca36d305e611ffb4991cbcd248a453))
* include mcp-servers.json in gateway Docker image ([d0c9cd3](https://github.com/lobu-ai/lobu/commit/d0c9cd33cc09f4fb9fc80078b0c7d9b025880f52))
* include z.ai API path prefix in upstream base URL ([4ad79c9](https://github.com/lobu-ai/lobu/commit/4ad79c92da9d2b3ca0c0c39328956bf05b5aa60b))
* **landing:** bold connector label inline instead of separate heading ([3ac690e](https://github.com/lobu-ai/lobu/commit/3ac690e5f803408fa8ee4a91ebd87f9ecdf07138))
* **landing:** clarify use-case source CTA ([d0b64f2](https://github.com/lobu-ai/lobu/commit/d0b64f2367c4c0f7e8c815c2ae89d92047ae38d8))
* **landing:** correct homepage prompt and CLI command references ([5f4429f](https://github.com/lobu-ai/lobu/commit/5f4429fa118a23018df97db83cda7c8a62760602))
* **landing:** correct lobu demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
* **landing:** improve hero CTA labels ([ae6a807](https://github.com/lobu-ai/lobu/commit/ae6a807ae33679770e7f851ab0f4c8ef5dce2c3a))
* **landing:** inline connector labels to balance recall/auth column heights ([6125016](https://github.com/lobu-ai/lobu/commit/61250162d3a4b28fccfcb273282e39afbc000a69))
* **landing:** keep homepage hero generic ([8078103](https://github.com/lobu-ai/lobu/commit/807810394c3d6ed87aa445075b4e9b7e4e248136))
* **landing:** left-align skills workspace preview ([54519ca](https://github.com/lobu-ai/lobu/commit/54519cab40a6f157c5f19761e7e5a3ca6a565813))
* **landing:** resolve zod alias from installed package ([f09e12d](https://github.com/lobu-ai/lobu/commit/f09e12d8409a122c8f33db3bb915c84af1d9e1c9))
* **landing:** use descriptive agent names in ConnectionsPanel ([f8f38c1](https://github.com/lobu-ai/lobu/commit/f8f38c118d703015580680eb3717c74755b2cb7b))
* make memory step layouts consistent ([990bf61](https://github.com/lobu-ai/lobu/commit/990bf61d7af60d43c6487f99c2b73b27820e4468))
* map z-ai gateway slug to zai model registry provider name ([64b606e](https://github.com/lobu-ai/lobu/commit/64b606e1c274463e5b96419a77e42905a4abb0f4))
* **packages:** add repository.url to all published package.json files ([c3f14c0](https://github.com/lobu-ai/lobu/commit/c3f14c04649c690ee6d5ee02a69e94f0f55de279))
* pass TELEGRAM_BOT_TOKEN in community deploy workflow ([e9c86e9](https://github.com/lobu-ai/lobu/commit/e9c86e9d87cd1c41ad758daa51b6fb6e35149f00))
* pin redis chart version to avoid Helm OCI panic ([af348ef](https://github.com/lobu-ai/lobu/commit/af348ef5553e67dd88b637d976b2fc2cea6c3e95))
* point agent-community Try Now to venture-capital org ([b117767](https://github.com/lobu-ai/lobu/commit/b117767c65e1e817a39f567ad39cc2abf2459da0))
* properly configure Nix sandbox for arm64 builds ([71daf7b](https://github.com/lobu-ai/lobu/commit/71daf7be81f94753f543f9b07a22351eb5f232d5))
* **proxy:** handle CONNECT method in request handler for Bun on Linux ([320e028](https://github.com/lobu-ai/lobu/commit/320e028f6e8b2a24733fbca52d7a1880c9787590))
* README link rendering and enable auto-deploy on push ([f7743a8](https://github.com/lobu-ai/lobu/commit/f7743a8765bb6636b8c6db1270c7de136a1957ea))
* recreate scaled-down workers with fresh env vars on wake-up ([879cd41](https://github.com/lobu-ai/lobu/commit/879cd41ff25146c2724e62f170bbe6566a2bbbca))
* **release:** sync helm chart to 3.0.5 ([92c5142](https://github.com/lobu-ai/lobu/commit/92c51422bc96f3267f89d607fafa47237b2709e8))
* remove broken integration tests causing 6-hour CI timeout ([1abd9c4](https://github.com/lobu-ai/lobu/commit/1abd9c4f0d24d2752780dc55db20cb7bc1a20113))
* remove CLI_VERSION pinning, use latest for worker package ([9c33352](https://github.com/lobu-ai/lobu/commit/9c3335248df9ca1010a9931c8798616bf64d0305))
* repair failing tests and exclude workspaces from test discovery ([3227430](https://github.com/lobu-ai/lobu/commit/3227430cae3cebcf5e815c0274197615dff276b9))
* resolve biome lint and format errors in landing/ ([#107](https://github.com/lobu-ai/lobu/issues/107)) ([40965cb](https://github.com/lobu-ai/lobu/commit/40965cbfe60039311fc6f00f66ebef157d3c4b0f))
* resolve CI workflow syntax errors ([a312b9f](https://github.com/lobu-ai/lobu/commit/a312b9f909c7b5c96896add46d4bb5ffc488267e))
* resolve K8s deployment issues ([9d48358](https://github.com/lobu-ai/lobu/commit/9d48358c38f66b95522b0cb288060fc664bf2aab))
* resolve K8s deployment issues ([dcd6eff](https://github.com/lobu-ai/lobu/commit/dcd6eff4292c676d886b42991fab481949a58134))
* resolve linting issues in test files ([b214013](https://github.com/lobu-ai/lobu/commit/b2140138acc5c13812a6057029a5197930844a62))
* resolve worker CJS/ESM module error and missing Nix in production ([fda47de](https://github.com/lobu-ai/lobu/commit/fda47de2bb6169eef79c4df8d96f57d7ca0af0c2))
* respect installed provider order when no explicit model is set ([2319f36](https://github.com/lobu-ai/lobu/commit/2319f360ae653dcc00a54fc4a9b2efb3dfffe9a2))
* restart stream on message_not_in_streaming_state error ([32db4a1](https://github.com/lobu-ai/lobu/commit/32db4a157777224a1f6cbc93854aa1d3471e7a28))
* security hardening and reliability improvements across gateway/worker ([ea00cef](https://github.com/lobu-ai/lobu/commit/ea00cef9cc526d6c8a471a855a6a379c32af68c5))
* session reset clears history, Telegram plain-text fallback ([7af9703](https://github.com/lobu-ai/lobu/commit/7af9703ce7fe333473f067eb6d504379041e3a23))
* **settings:** make OAuth client optional so Telegram mini app works without it ([f51abed](https://github.com/lobu-ai/lobu/commit/f51abedb6f73055bba1ee91d3e4dde42afa758cb))
* **settings:** rename "Scheduled Reminders" to "Schedules" ([6a74299](https://github.com/lobu-ai/lobu/commit/6a74299e3ac7886da3217ecc081473e5e956605b))
* **settings:** skip identity linked notification if already linked ([1674a3b](https://github.com/lobu-ai/lobu/commit/1674a3be8a08516f273f21ea2691a60213c74572))
* simplify Docker multi-arch support and improve MCP configuration ([5f4e2d8](https://github.com/lobu-ai/lobu/commit/5f4e2d8d0f7d475663b0458d2075d878a263d646))
* simplify manual npm publish to use main branch ([423eb43](https://github.com/lobu-ai/lobu/commit/423eb436c21445fd42ed99129fd7a89469a00dc7))
* skip arm64 worker build due to Nix/QEMU seccomp issue ([fa3f96c](https://github.com/lobu-ai/lobu/commit/fa3f96cfa86272cd6523162154745790a01183ca))
* **telegram:** add platform=telegram param to provider setup URL ([61d9aed](https://github.com/lobu-ai/lobu/commit/61d9aed0ac706e33d08f469b231ec9a68f071c94))
* **telegram:** auto-enable when bot token is present ([a951747](https://github.com/lobu-ai/lobu/commit/a951747976c18d5b18930bcf6baf07da8d70a895))
* temporarily disable custom tools to fix npm build ([2065c74](https://github.com/lobu-ai/lobu/commit/2065c7456cb50bb7f7b8b413d0ec0b9f9509655e))
* track tailwind.config.js so CI CSS generation works ([ae6f1e7](https://github.com/lobu-ai/lobu/commit/ae6f1e753d1c02fb863fb17b64e041e622adada4))
* update ChatGPT device code OAuth flow and skill display ([a81594a](https://github.com/lobu-ai/lobu/commit/a81594af63c4050c2e315a76c0c74b90cb940712))
* update community deployment for Hetzner cluster ([fe5bf90](https://github.com/lobu-ai/lobu/commit/fe5bf908bd708ffad198991378e6054b1ff75fba))
* update README and landing page (Baileys→Cloud API, Anthropic→OpenRouter, bare lobu→npx) ([45ee64f](https://github.com/lobu-ai/lobu/commit/45ee64f1ced1ee883ea2db6b48c2255dc72ab229))
* update worker-job-router tests to match fire-and-forget architecture ([b7d00d2](https://github.com/lobu-ai/lobu/commit/b7d00d27311339312cf9aa2b08f87e5fe1ecb83a))
* upgrade Helm to 3.16 to fix OCI registry panic ([e4f88de](https://github.com/lobu-ai/lobu/commit/e4f88def1378c4f946b5f8f00f3a038e4562e716))
* use bun instead of tsx in gateway Helm template ([77dccfa](https://github.com/lobu-ai/lobu/commit/77dccfac62474062b26d5b2e7299b2f42f48c694))
* use npx @lobu/cli consistently across CLI output, docs, and landing page ([ca1133c](https://github.com/lobu-ai/lobu/commit/ca1133cde710605a017a79c7dd161cf6dca11d33))
* use PAT for repository_dispatch in deploy trigger ([10add7e](https://github.com/lobu-ai/lobu/commit/10add7e377bf4c27520264704b9fcea6d079a477))
* use strategic merge patch for K8s deployment scaling ([fde3201](https://github.com/lobu-ai/lobu/commit/fde320157297b6dae58d7f65e22c2dd743892137))
* use writable temp directory for git cache fallback ([c45fc01](https://github.com/lobu-ai/lobu/commit/c45fc01a5ada190bf467b2ab27f71f770c4e927a))
* **worker:** use string concatenation for session-context URL ([09d474e](https://github.com/lobu-ai/lobu/commit/09d474e6e2e5c8ec48505196803a0d7c8beb055d))

## [3.4.3](https://github.com/lobu-ai/lobu/compare/v3.4.2...v3.4.3) (2026-04-16)


### Bug Fixes

* **ci:** set empty component to fix release-please auto-tagging ([#192](https://github.com/lobu-ai/lobu/issues/192)) ([ec809f9](https://github.com/lobu-ai/lobu/commit/ec809f9069f0a8b79b0fab0b37eeb409783da67e))

## [3.4.2](https://github.com/lobu-ai/lobu/compare/v3.4.1...v3.4.2) (2026-04-16)


### Bug Fixes

* **ci:** drop package-name from release-please config to fix auto-tagging ([#190](https://github.com/lobu-ai/lobu/issues/190)) ([31056a2](https://github.com/lobu-ai/lobu/commit/31056a2e8af8e9347aa7e6680109162e85509f17))

## [3.4.1](https://github.com/lobu-ai/lobu/compare/v3.4.0...v3.4.1) (2026-04-16)


### Bug Fixes

* **ci:** restore release-please pull-request-title-pattern ([#186](https://github.com/lobu-ai/lobu/issues/186)) ([699f40b](https://github.com/lobu-ai/lobu/commit/699f40b0cf9375b25a76733f7351ca934730fe9d))
* **ci:** use simpler release-please title pattern that actually works ([#188](https://github.com/lobu-ai/lobu/issues/188)) ([11e1e70](https://github.com/lobu-ai/lobu/commit/11e1e7056674b1ed67be9678ed4c1fa2a988a9c2))

## [3.4.0](https://github.com/lobu-ai/lobu/compare/v3.3.0...v3.4.0) (2026-04-16)


### Features

* add /skills/for/{useCase} routes, version eval schema, clean up duplication ([d84a856](https://github.com/lobu-ai/lobu/commit/d84a856a307916b87641426e0d2de48f89442089))
* **gateway:** add MCP OAuth 2.1 auth-code + PKCE flow ([9ea9f45](https://github.com/lobu-ai/lobu/commit/9ea9f45dedb9aa0f5ef740b949cd6b51fa8bf2ee))
* **gateway:** add optional body text to link-button cards ([#183](https://github.com/lobu-ai/lobu/issues/183)) ([1e93013](https://github.com/lobu-ai/lobu/commit/1e93013d542d4021fe33b4029b58b6329c4b19bd))
* **landing:** add connect-from pages and refresh use-case content ([1ce6f6c](https://github.com/lobu-ai/lobu/commit/1ce6f6c0754aa8adfa45f6dc0738f5931717dbf1))
* **landing:** add terms of service page ([0347573](https://github.com/lobu-ai/lobu/commit/0347573d58d5aff6594713bb4a7277f7227d9e83))
* **landing:** remove Lobu for X labels and redundant use case summaries ([e861218](https://github.com/lobu-ai/lobu/commit/e861218120dbfc5265152bd09b2ab96a6202f5c3))
* **landing:** update copy prompt behavior and text ([a551a79](https://github.com/lobu-ai/lobu/commit/a551a7965c9c46aa2b44e2a29eecd065fd9c1f13))
* make examples/ single source of truth for use cases and Lobu orgs ([3fc5380](https://github.com/lobu-ai/lobu/commit/3fc5380a720681d4b54ca88ff401dcaa7462db70))
* make Hero GitHub button contextual to active use case ([f1ca9fe](https://github.com/lobu-ai/lobu/commit/f1ca9fed7cfbe4326599e546109eca7f6a45bb05))
* migrate lobu examples to models/ directory with type field ([3deeb77](https://github.com/lobu-ai/lobu/commit/3deeb77f5eea1cd9d1124691e42430e3bb6fa496))
* rename CTA to "Open in Lobu" and open in new tab ([179fc23](https://github.com/lobu-ai/lobu/commit/179fc239b240a31aabd3d412a98035353b638924))
* wire file-first lobu memory config ([46c7554](https://github.com/lobu-ai/lobu/commit/46c7554d27284724333d5aa043316fe208f278b1))
* **worker:** redact sandbox leaks, replace base prompt identity, use signed artifact URLs ([a5c33d8](https://github.com/lobu-ai/lobu/commit/a5c33d818d9de4e0bef8fd1710a2244f8592e33f))


### Bug Fixes

* **eval:** isolate trials + feat(worker): MCP-as-CLI for embedded mode ([#184](https://github.com/lobu-ai/lobu/issues/184)) ([c256d6d](https://github.com/lobu-ai/lobu/commit/c256d6d2604b514df9eb2c5658524079286e73b9))
* **landing:** clarify use-case source CTA ([d0b64f2](https://github.com/lobu-ai/lobu/commit/d0b64f2367c4c0f7e8c815c2ae89d92047ae38d8))
* **landing:** correct lobu demo links ([150a7c9](https://github.com/lobu-ai/lobu/commit/150a7c94f26b04e51271e6dc9074a649eb178099))
* **landing:** improve hero CTA labels ([ae6a807](https://github.com/lobu-ai/lobu/commit/ae6a807ae33679770e7f851ab0f4c8ef5dce2c3a))
* **landing:** keep homepage hero generic ([8078103](https://github.com/lobu-ai/lobu/commit/807810394c3d6ed87aa445075b4e9b7e4e248136))
* **landing:** left-align skills workspace preview ([54519ca](https://github.com/lobu-ai/lobu/commit/54519cab40a6f157c5f19761e7e5a3ca6a565813))

## [3.3.0](https://github.com/lobu-ai/lobu/compare/v3.2.0...v3.3.0) (2026-04-14)


### Features

* add agent-community use case and extract UseCaseTabs label prop ([ba956ad](https://github.com/lobu-ai/lobu/commit/ba956ad13bdb642e22c3ed6bc2a7c00128d2ff72))
* add ecommerce use case to landing page ([4982606](https://github.com/lobu-ai/lobu/commit/498260638532f7da16400a0bf6f1aca7e8ff3f46))
* add privacy policy page and footer link ([b9df04f](https://github.com/lobu-ai/lobu/commit/b9df04fffab714edaa569f447bb29b96c0c65c07))
* expand landing use cases and normalize network grants ([e9b0282](https://github.com/lobu-ai/lobu/commit/e9b02825b2c721fa4cde8a5a68d07e5ddfd4c993))
* harden file delivery flows and add OpenRouter CI evals ([676544c](https://github.com/lobu-ai/lobu/commit/676544c1d9871debd6116a638108ad2a757fd1af))
* **landing:** add posthog analytics ([b7b431d](https://github.com/lobu-ai/lobu/commit/b7b431d0bc30ddb1a104ed2473ab1aa7d695577c))
* **landing:** revamp memory page demo ([96dba19](https://github.com/lobu-ai/lobu/commit/96dba192e07b7861b333c9d7f3fc72701527436a))
* make skills page init preview contextual to selected use-case ([146e87a](https://github.com/lobu-ai/lobu/commit/146e87ad8838c5dd03c5f27900636e05c527823f))
* refresh landing pages and pricing UX ([c8d8b58](https://github.com/lobu-ai/lobu/commit/c8d8b58fd6ea4b16583d67259e61839dc9ee1f52))
* show nix packages in landing skill previews ([6095e13](https://github.com/lobu-ai/lobu/commit/6095e13447d9d7c3e6214a9995b9994645ee8bf9))


### Bug Fixes

* **ci:** guard docker sha tags on release events ([#181](https://github.com/lobu-ai/lobu/issues/181)) ([48b75ac](https://github.com/lobu-ai/lobu/commit/48b75ac8154c801bbdc8676412cf5fabe804d8aa))
* **cli:** replace RequestInfo with portable fetch input type ([ba23c4a](https://github.com/lobu-ai/lobu/commit/ba23c4a260949f75e81876dd4e85e35449d5cada))
* deduplicate lobu URL logic, fix skills card title, add skills link to memory reuse step ([78ad65e](https://github.com/lobu-ai/lobu/commit/78ad65e75faa689fbaa3715c0cc3eec1496c8527))
* make memory step layouts consistent ([990bf61](https://github.com/lobu-ai/lobu/commit/990bf61d7af60d43c6487f99c2b73b27820e4468))
* point agent-community Try Now to venture-capital org ([b117767](https://github.com/lobu-ai/lobu/commit/b117767c65e1e817a39f567ad39cc2abf2459da0))

## [3.2.0](https://github.com/lobu-ai/lobu/compare/v3.1.2...v3.2.0) (2026-04-11)


### Features

* refresh cli docs and restore release publish chain ([#179](https://github.com/lobu-ai/lobu/issues/179)) ([1ee0595](https://github.com/lobu-ai/lobu/commit/1ee0595d354b0dee1a85d4b3015fd1c9adcab4a0))

## [3.1.2](https://github.com/lobu-ai/lobu/compare/v3.1.1...v3.1.2) (2026-04-11)


### Bug Fixes

* **ci:** put version in release-please PR title + add workflow_dispatch ([#176](https://github.com/lobu-ai/lobu/issues/176)) ([9021308](https://github.com/lobu-ai/lobu/commit/9021308ed7162a7bd20e08817c351a64684ed7c1))
* **ci:** use default release-please title pattern variables ([#178](https://github.com/lobu-ai/lobu/issues/178)) ([26709e3](https://github.com/lobu-ai/lobu/commit/26709e3c19e01ebf58220118a056833caf6ea50b))

## [3.1.1](https://github.com/lobu-ai/lobu/compare/v3.1.0...v3.1.1) (2026-04-11)


### Bug Fixes

* **ci:** reconcile release-please config + Chart.yaml appVersion ([#174](https://github.com/lobu-ai/lobu/issues/174)) ([c6ea7c8](https://github.com/lobu-ai/lobu/commit/c6ea7c8368f312f2deb10deb5e723ef76e23ece6))

## [3.1.0](https://github.com/lobu-ai/lobu/compare/v3.0.19...v3.1.0) (2026-04-10)


### Features

* **gateway:** support leading-dot domain patterns in GrantStore ([f2a1006](https://github.com/lobu-ai/lobu/commit/f2a1006e4a9769c90bf5521332c87a8c0ed156ff))
* **mcp-auth:** surface login prompts as platform link buttons ([9ca5449](https://github.com/lobu-ai/lobu/commit/9ca5449a48321db1e6a81f3ab1172b8768f272fc))


### Bug Fixes

* **ci:** release-please triggers publish-packages via gh workflow run ([87b14cb](https://github.com/lobu-ai/lobu/commit/87b14cbaea46df47be6e5a71d7fc498523c23995))
* **ci:** use yaml updater for Chart.yaml version + appVersion ([58819bc](https://github.com/lobu-ai/lobu/commit/58819bc604ed04448a10e8a67535c8b1ff470911))

## [2.7.0](https://github.com/lobu-ai/lobu/compare/v2.6.1...v2.7.0) (2026-03-18)


### Features

* add Reddit and X (Twitter) as OAuth integrations ([7a57b9c](https://github.com/lobu-ai/lobu/commit/7a57b9c7b8a1f021923a5718c63e95000d20cf3e))
* **ci:** migrate Docker images from Docker Hub to GHCR ([c01824a](https://github.com/lobu-ai/lobu/commit/c01824a6e7a59ee202145df5471ee9f863380eb3))
* **cli,gateway:** multi-agent CLI, external OAuth, agent seeding ([d4dba49](https://github.com/lobu-ai/lobu/commit/d4dba4998f2914d07d9528abc0a3b48a564ec8cc))
* **config:** add system skills for integrations and LLM providers ([de25b3c](https://github.com/lobu-ai/lobu/commit/de25b3c885c6ec1301da998a1c38aac371b8e430))
* **config:** add system skills, skill registries, and MCP example config ([cb356d0](https://github.com/lobu-ai/lobu/commit/cb356d077eea2338d9b31b4c76db5e92d5f44e27))
* **core:** add integration, provider config, and skill metadata types ([94c1012](https://github.com/lobu-ai/lobu/commit/94c1012b28d1d7d9209f56ee8e8f237b212c0f7b))
* **gateway:** add integration framework — OAuth, credential store, API proxy ([0a19e2d](https://github.com/lobu-ai/lobu/commit/0a19e2d0ebaaf6910efe8e66a1135a2bbec0d419))
* **gateway:** improve OAuth UX on settings page by removing auto-redirect and adding login button ([2757725](https://github.com/lobu-ai/lobu/commit/2757725c6a4a2c450d003389235f334cb1e70f75))
* **gateway:** integration services, config-driven providers, and orchestration updates ([170e824](https://github.com/lobu-ai/lobu/commit/170e824c5c5f00f8ac8093d051f683e83d558cd6))
* **gateway:** settings page overhaul — skills section, integration status, remove env vars ([02b3160](https://github.com/lobu-ai/lobu/commit/02b3160d2b3234e99a2b714355096c76d75d9ec1))
* **landing:** add interactive prompt + output demo to skills section ([dc8a806](https://github.com/lobu-ai/lobu/commit/dc8a80640d748dc9a9bf46b7223d3739a52e1770))
* **landing:** embed OpenClaw creator tweet confirming single-user design ([4c6537b](https://github.com/lobu-ai/lobu/commit/4c6537b03aaa7218191c18a69b3b8d00c82e2297))
* **landing:** link OpenClaw runtime to comparison page with architecture reasoning ([2977bbb](https://github.com/lobu-ai/lobu/commit/2977bbb16d3415459793bacf1f3d769a763268b6))
* **landing:** migrate from Vite SPA to Astro with Starlight docs ([687c6f7](https://github.com/lobu-ai/lobu/commit/687c6f737f59f807d5e5723258d549593343b244))
* **landing:** rename skills-as-saas to skills and update hero copy ([42009c5](https://github.com/lobu-ai/lobu/commit/42009c5d709cbdac0455512326757813d7f27805))
* **landing:** replace Telegram chat with terminal log for connections row ([2a3467e](https://github.com/lobu-ai/lobu/commit/2a3467e385bef38a1f066ed90482f1bd91cf5b3b))
* migrate Lobu plugin to published @lobu/lobu-openclaw package ([b4666c5](https://github.com/lobu-ai/lobu/commit/b4666c50c375331aaf5fd2b8802b6891974459e0))
* migrate to Chat SDK platform adapters with typed OpenAPI schemas ([89573db](https://github.com/lobu-ai/lobu/commit/89573dbf3242249034f37543671db26493ccbd88))
* multi-auth settings UX, base provider module refactor, and infra improvements ([1c61b30](https://github.com/lobu-ai/lobu/commit/1c61b30e931f68ee37b9d8775fcae66c1e95643c))
* **oauth:** add PKCE, RFC 8707 resource, auto-grants, and MCP token endpoint ([63336a7](https://github.com/lobu-ai/lobu/commit/63336a78d92999384fa873216668467a2787666c))
* Lobu memory plugin, plugin hooks/services, test infrastructure, and misc improvements ([89c27f0](https://github.com/lobu-ai/lobu/commit/89c27f0736e74fe83de6b1664017b21130cd489f))
* **proxy:** resolve provider credentials via URL path agentId ([1dbcb8c](https://github.com/lobu-ai/lobu/commit/1dbcb8c3c3a9ee6471733cedfcadf9ee5e1b3f6d))
* settings page rewrite (Alpine→Preact), history page, Telegram enhancements, landing page ([b2cba55](https://github.com/lobu-ai/lobu/commit/b2cba551671812f2c54e9188fa74cc77ecd2f27c))
* **settings:** post-install callback with agent resume ([d96e99b](https://github.com/lobu-ai/lobu/commit/d96e99b120054cebad862f788eef427faefb4e40))
* **skills:** add scoring, URI, and system skill search to SearchSkills ([d63d7a8](https://github.com/lobu-ai/lobu/commit/d63d7a8e1a0b16dfcd8761a1ed54690cd84616c6))
* **worker:** ConnectService, CallService, DisconnectService tools and integration runtime ([af5a270](https://github.com/lobu-ai/lobu/commit/af5a270ba8e5d66e77cb7cd9c1d495d183e22a44))
* **worker:** expand ConnectService to support AI provider setup ([45b0c93](https://github.com/lobu-ai/lobu/commit/45b0c9396a759a14eb67c22347aee2de08e4543e))


### Bug Fixes

* add CSS generation step to gateway Dockerfile ([d361129](https://github.com/lobu-ai/lobu/commit/d3611292caadd929c89e4b7fbabb27da9f3c632c))
* add default model fallback per provider and fix z-ai base URL env var ([ebb8237](https://github.com/lobu-ai/lobu/commit/ebb82377c966a4cb44d033dc8744958f447f7133))
* **ci:** bump Bun to 1.3.5 to fix CONNECT test failures ([1970c9a](https://github.com/lobu-ai/lobu/commit/1970c9a7ad5380134c5da514a88847dbc520ca8d))
* **ci:** gate release steps on explicit true output ([47346e5](https://github.com/lobu-ai/lobu/commit/47346e54a866bc6700413e34621387b61d5cb924))
* **ci:** pin bun version for landing deploy ([0c62bf0](https://github.com/lobu-ai/lobu/commit/0c62bf09804b9e5851c51f85b22fdbafd744f278))
* **ci:** sync bun lockfile ([16c91dd](https://github.com/lobu-ai/lobu/commit/16c91dd052f7571da9c144787afef670ccc09338))
* **ci:** use GitHub secret for Telegram token, not k8s sealed secret ([ff27697](https://github.com/lobu-ai/lobu/commit/ff27697611db35e5c7d1c31e0b6fdcd1f27c045e))
* clear mismatched default model in auto-mode provider selection ([ab20949](https://github.com/lobu-ai/lobu/commit/ab20949514d09158e33c4a0951cdda498a226c8d))
* clear stale session when provider changes ([080afe0](https://github.com/lobu-ai/lobu/commit/080afe0b1bb818a3166b55804d285290e101d0e1))
* **deploy:** remove broken global.imageRegistry that caused double-slash in Bitnami Redis image paths ([e37d81c](https://github.com/lobu-ai/lobu/commit/e37d81c79593234b9fb44aa2f2e1b9150fa3678f))
* **deploy:** update sealed secrets with all required keys ([fbe588e](https://github.com/lobu-ai/lobu/commit/fbe588e8296746a29f1ddb12af56f56856f3b420))
* **gateway:** escape oauth callback template values ([#122](https://github.com/lobu-ai/lobu/issues/122)) ([d4cfc45](https://github.com/lobu-ai/lobu/commit/d4cfc45dacd6bec48c3c904f751a863b9f6510e6))
* **gateway:** redact secrets in agent config response ([#127](https://github.com/lobu-ai/lobu/issues/127)) ([6af4424](https://github.com/lobu-ai/lobu/commit/6af44241faa9f1fae60eba49423528a295d1a4c1))
* **gateway:** remove settings token query exposure ([#130](https://github.com/lobu-ai/lobu/issues/130)) ([9d4adb8](https://github.com/lobu-ai/lobu/commit/9d4adb83ffbcd128250704d5cf19859eaaf0193a))
* **gateway:** require auth for channel binding routes ([#123](https://github.com/lobu-ai/lobu/issues/123)) ([6736fe9](https://github.com/lobu-ai/lobu/commit/6736fe9ede187f71a7c513b20cf2f1c528188a10))
* **gateway:** require settings token for chatgpt start/poll ([#124](https://github.com/lobu-ai/lobu/issues/124)) ([4004401](https://github.com/lobu-ai/lobu/commit/4004401d78aa6e62a65661c1b0e3f229873a6c31))
* **gateway:** skip enqueuing worker delivery receipts to thread response queue ([c5c352d](https://github.com/lobu-ai/lobu/commit/c5c352d50b9dfd80570bb78743735eb94adb38d3))
* **gateway:** stop logging WhatsApp credential payloads ([#128](https://github.com/lobu-ai/lobu/issues/128)) ([68968b5](https://github.com/lobu-ai/lobu/commit/68968b57c8384e52939daca407c3f8f3a308050c))
* **helm:** expose ADMIN_PASSWORD and platform tokens as gateway env vars ([968f4a8](https://github.com/lobu-ai/lobu/commit/968f4a89b230c0608a48f851fcda7f77ce046992))
* **helm:** make claude-code-oauth-token secret ref optional ([992a2e6](https://github.com/lobu-ai/lobu/commit/992a2e6c2652781975285bd0b14618990c90ded0))
* **helm:** remove platform token env vars from gateway deployment ([062f18f](https://github.com/lobu-ai/lobu/commit/062f18f71f82538c0ee343e608e4861e78e9a281))
* include z.ai API path prefix in upstream base URL ([4ad79c9](https://github.com/lobu-ai/lobu/commit/4ad79c92da9d2b3ca0c0c39328956bf05b5aa60b))
* **landing:** correct homepage prompt and CLI command references ([5f4429f](https://github.com/lobu-ai/lobu/commit/5f4429fa118a23018df97db83cda7c8a62760602))
* **landing:** resolve zod alias from installed package ([f09e12d](https://github.com/lobu-ai/lobu/commit/f09e12d8409a122c8f33db3bb915c84af1d9e1c9))
* **landing:** use descriptive agent names in ConnectionsPanel ([f8f38c1](https://github.com/lobu-ai/lobu/commit/f8f38c118d703015580680eb3717c74755b2cb7b))
* map z-ai gateway slug to zai model registry provider name ([64b606e](https://github.com/lobu-ai/lobu/commit/64b606e1c274463e5b96419a77e42905a4abb0f4))
* **proxy:** handle CONNECT method in request handler for Bun on Linux ([320e028](https://github.com/lobu-ai/lobu/commit/320e028f6e8b2a24733fbca52d7a1880c9787590))
* recreate scaled-down workers with fresh env vars on wake-up ([879cd41](https://github.com/lobu-ai/lobu/commit/879cd41ff25146c2724e62f170bbe6566a2bbbca))
* resolve worker CJS/ESM module error and missing Nix in production ([fda47de](https://github.com/lobu-ai/lobu/commit/fda47de2bb6169eef79c4df8d96f57d7ca0af0c2))
* respect installed provider order when no explicit model is set ([2319f36](https://github.com/lobu-ai/lobu/commit/2319f360ae653dcc00a54fc4a9b2efb3dfffe9a2))
* session reset clears history, Telegram plain-text fallback ([7af9703](https://github.com/lobu-ai/lobu/commit/7af9703ce7fe333473f067eb6d504379041e3a23))
* **settings:** make OAuth client optional so Telegram mini app works without it ([f51abed](https://github.com/lobu-ai/lobu/commit/f51abedb6f73055bba1ee91d3e4dde42afa758cb))
* **settings:** rename "Scheduled Reminders" to "Schedules" ([6a74299](https://github.com/lobu-ai/lobu/commit/6a74299e3ac7886da3217ecc081473e5e956605b))
* **settings:** skip identity linked notification if already linked ([1674a3b](https://github.com/lobu-ai/lobu/commit/1674a3be8a08516f273f21ea2691a60213c74572))
* **telegram:** add platform=telegram param to provider setup URL ([61d9aed](https://github.com/lobu-ai/lobu/commit/61d9aed0ac706e33d08f469b231ec9a68f071c94))
* **telegram:** auto-enable when bot token is present ([a951747](https://github.com/lobu-ai/lobu/commit/a951747976c18d5b18930bcf6baf07da8d70a895))
