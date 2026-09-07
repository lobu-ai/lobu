# Releasing

The published packages ship as a synchronized release: `@lobu/core`, `@lobu/cli`, `@lobu/connector-sdk`, `@lobu/connector-worker`, `@lobu/worker`, `@lobu/embeddings`, `@lobu/client`, and `@lobu/promptfoo-provider`. (The previously published `lobu` unscoped package was retired when its commands moved into `@lobu/cli` as the `lobu memory` namespace.) [release-please](https://github.com/googleapis/release-please) reads conventional commits on `main` and drives versioning. Automated publishing prefers npm OIDC trusted publishing and keeps `NPM_TOKEN` only as a fallback for packages that are not registered as trusted publishers yet.

## Flow

1. Merge feature PRs into `main` with conventional commit messages.
2. The push to `main` starts `build-images.yml`. When it finishes, `release-please.yml` runs on its `workflow_run` and attests the producer before touching anything: the run must be a completed-success push to the current `main` tip, all seven required image jobs must be completed-success, and there must be an exact successful `ci.yml` run for the same commit.
3. Against that attested commit, release-please opens a `chore(main): release lobu <version>` PR with bumped `package.json`s and a generated `CHANGELOG.md`. It runs with `skip-github-release: true`, so it never creates the tag or the release itself.
4. Merging the release PR repeats steps 2–3 for the new commit. The workflow then asks whether the attested commit's manifest version already has a stable `lobu-v<version>` GitHub release; if it does not, it creates the tag and release bound to that exact attested SHA. The question is deliberately about the release list rather than about whether the attested commit is the one that bumped the manifest — keyed on a parent diff, the release could only be cut while the bump commit was still `main`'s tip, so anything merging behind the release PR stranded it permanently. Publishing the release starts `build-images.yml` again, now on a `release` event. One consequence of asking the release list rather than the parent commit: if the bump commit's own image build does not get to cut the release, the tag binds to a later `main` tip instead, and release-please computes the following changelog from that tag — so commits that landed in the gap do not appear in the next `CHANGELOG.md`. That is deliberate; a release that ships with a short changelog is strictly better than a release that never ships at all.
5. That release run pushes candidate image tags outside Flux's policy, boots the app candidate by immutable digest in `app-image-smoke`, then runs `promote-images` to publish the deployment and release tags from the tested digests. Only after promotion succeeds does `trigger-package-publish` dispatch `publish-packages.yml` from `main` with the release tag and its own run id. Automated npm publication is therefore downstream of a green image smoke and successful promotion — a red or still-queued image build leaves the version unpublished rather than shipping an unverified tree.

Every provenance decision in that chain is one subcommand of `scripts/release-provenance.mjs`, covered by `scripts/__tests__/release-publish-order.test.ts`. Change the attestation policy there, not in the workflow YAML.

To force a specific version, land a commit on `main` whose body contains `Release-As: 7.2.0`; release-please then opens or updates the release PR for that version.

Only stable `X.Y.Z` versions can be released. The attestation chain rejects anything else — `parseStableVersion` in `scripts/release-provenance.mjs` throws, so a prerelease `Release-As:` fails the release step with `invalid stable Lobu version` rather than shipping. Release a prerelease by publishing from a branch by hand instead.

## Commit prefixes → version bump

| Prefix | Effect |
| --- | --- |
| `feat:` | minor |
| `fix:` | patch |
| `feat!:` / `BREAKING CHANGE:` footer | major |
| `docs:` `chore:` `ci:` `test:` `style:` `refactor:` `perf:` | changelog only, no bump |

Scope is optional (`feat(gateway): ...`). Breaking changes go in the footer:

```
feat(gateway): rename runtime credential resolver contract

BREAKING CHANGE: RuntimeProviderCredentialResolver now returns
`{ credential?, credentialRef?, authType }` instead of a bare string.
```

## Adding a new published package

1. `release-please-config.json` — add to `packages["."].extra-files[]`:
   ```json
   { "type": "json", "path": "packages/<new-pkg>/package.json", "jsonpath": "$.version" }
   ```
   (`extra-files[]` is also where the synchronized version is propagated to `charts/lobu/Chart.yaml` — both `$.version` and `$.appVersion` are bumped there on every release.)
2. `scripts/publish-packages.mjs` — add to the `PACKAGES` array (use `transform: rewriteWorkspaceRefs` if it has `workspace:*` deps).

## Recovery

**Release PR version looks wrong** — land a commit on `main` whose body contains `Release-As: <version>`. release-please updates the open release PR on its next run.

**Publish step fails after release PR merge** — re-running `release-please.yml` does NOT re-publish: the release already exists, so no new release event fires and nothing dispatches the publish. Recover from the artifact side instead:

- **`build-images` failed or was evicted** — re-run that run (`gh run rerun <id>`). A successful `app-image-smoke` and `promote-images` re-fire `trigger-package-publish` on their own.
- **`build-images` is green but `publish-packages` failed** — re-dispatch it from `main`, naming the release tag and the exact producing run. Both inputs are required and there is no fallback that guesses either one:
  ```bash
  gh workflow run publish-packages.yml --ref main \
    -f release_tag=lobu-v<version> \
    -f image_run_id=<the build-images run id for the release event>
  ```
  The workflow must be dispatched from `main` so it runs main's policy; the release tag is data, not the ref.
- **`release-please.yml` skipped a push because `main` moved** — the attestation binds to one commit, so a merge landing mid-attestation aborts that run rather than releasing a commit it did not verify. The next push re-attests from scratch; nothing needs unsticking. To release without waiting, dispatch it manually from `main` with the exact producing run: `gh workflow run release-please.yml --ref main -f image_run_id=<build-images run id>`.

`publish-packages.mjs` is idempotent (skips already-published packages), so re-running is safe.

**Helm publish says the chart package is private** — GitHub does not expose a package-visibility update API. A package administrator must open the `charts/lobu` package settings once and change its visibility to **Public**. Organization owners have admin permission to organization packages. Re-run the failed Helm workflow afterward. The workflow verifies the live package visibility and fails closed; it never treats a private chart as a successful public release.

**Bad build reached npm** — prefer deprecation over unpublish:
```bash
npm deprecate '@lobu/core@<bad-version>' "broken build, use <good-version>"
```
Then land a fix and let release-please cut a patch (e.g. `6.1.2`).

## Manual publish fallback

If CI is broken and you need a hotfix:

```bash
npm login --auth-type=web
node scripts/publish-packages.mjs patch        # bump + build + publish
node scripts/publish-packages.mjs 6.2.0        # explicit version
node scripts/publish-packages.mjs --skip-bump  # publish current version
```

After a local publish, land a `chore(main): release lobu <version>` commit on `main` so `.release-please-manifest.json` stays in sync.

## Verify

```bash
for pkg in @lobu/core @lobu/cli @lobu/connector-sdk @lobu/connector-worker @lobu/worker @lobu/embeddings @lobu/client @lobu/promptfoo-provider; do
  npm view "$pkg" version
done
```

All versions should match the release PR.
