#!/usr/bin/env bash
# Exercise the workflow conditions with terminal job results, including jobs
# cancelled before they emit outputs. GitHub scheduling still needs live proof.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../../.."

bun --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const results = ['success', 'failure', 'cancelled', 'skipped'];
const main = { event_name: 'push', ref: 'refs/heads/main', event: {} };
const read = (file) => Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, 'utf8')).jobs;
const dependencies = (job) => [].concat(job.needs);

// These guards use boolean operators and string comparisons shared with JS.
// Translate GHA object filters and hyphenated job keys, then evaluate the actual
// YAML condition rather than a second copy of the notification decision.
function fires(job, needs, github) {
  assert.match(job.if, /\balways\(\)/, 'job must override the default success() guard');
  const expression = job.if
    .replaceAll('needs.*.result', 'Object.values(needs).map(job => job.result)')
    .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  return Boolean(new Function('needs', 'github', 'always', 'failure', 'contains', 'startsWith',
    `return (${expression});`)(needs, github, () => true,
    () => Object.values(needs).some(job => job.result === 'failure'),
    (values, value) => values.includes(value), (value, prefix) => value.startsWith(prefix)));
}

for (const [file, dependency] of [
  ['prod-smoke.yml', 'smoke'],
  ['slack-qa-token-liveness.yml', 'liveness'],
]) {
  const job = read(file)['notify-failure'];
  assert.deepEqual(dependencies(job), [dependency]);
  assert.equal(job.steps[0].if, undefined, 'notification step must not suppress cancellation');
  for (const event_name of ['schedule', 'workflow_dispatch', 'workflow_run']) {
    for (const result of results) {
      const expected = ['failure', 'cancelled'].includes(result)
        && (dependency === 'smoke' || event_name === 'schedule');
      assert.equal(fires(job, { [dependency]: { result } }, { ...main, event_name }), expected,
        `${file}: ${event_name}, ${result}`);
    }
  }
  console.log(`ok - ${file}: failure, cancellation, success, skip and event filters`);
}

const jobs = read('build-images.yml');
const job = jobs['notify-failure'];
const buildJobs = Object.keys(jobs).filter(name => name !== 'notify-failure');
assert.deepEqual(new Set(dependencies(job)), new Set(buildJobs), 'alarm must observe every build dependency');
assert.equal(job.steps[0].if, undefined);
for (const github of [
  main,
  { ...main, event_name: 'workflow_dispatch' },
  { ...main, event_name: 'workflow_dispatch', ref: 'refs/heads/feature' },
  ...['lobu-v1.0.0', 'owletto-mac-v1.0.0'].map(tag_name => ({
    event_name: 'release', ref: `refs/tags/${tag_name}`, event: { release: { tag_name } },
  })),
]) {
  const eligible = github.ref === main.ref || github.event.release?.tag_name === 'lobu-v1.0.0';
  for (const name of buildJobs) {
    for (const result of results) {
      const needs = Object.fromEntries(buildJobs.map(key => [key, { result: 'success', outputs: {} }]));
      needs['generate-tag'].outputs.should_publish = eligible ? 'true' : 'false';
      needs[name].result = result;
      if (['current-main-guard', 'generate-tag'].includes(name) && result !== 'success') {
        // An interrupted prerequisite emits no tag output; its descendants skip.
        for (const key of buildJobs) needs[key] = { result: 'skipped', outputs: { should_publish: '' } };
        needs[name].result = result;
      }
      assert.equal(fires(job, needs, github), eligible && ['failure', 'cancelled'].includes(result),
        `build-images.yml: ${github.event_name}, ${github.ref}, ${name}=${result}`);
    }
  }
}
console.log('ok - build-images.yml: every dependency, missing outputs and release/ref filters');
JS
