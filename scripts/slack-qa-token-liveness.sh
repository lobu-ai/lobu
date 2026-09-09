#!/usr/bin/env bash
# slack-qa-token-liveness.sh — report whether the stored Slack QA credentials
# can still authenticate, without posting anything to Slack.
#
# Why this is separate from scripts/test-bot.sh: the QA_SLACK_* secrets were
# added to this repo in April 2026 and no workflow ever consumed them, so
# nothing noticed when they stopped working. The exact-response smoke in
# test-bot.sh cannot distinguish "the bot regressed" from "the sender token
# died" — it exits 1 either way. This answers only the credential question. It
# posts no message and writes nothing, which is what makes it safe to schedule.
#
# Exit 0 means every credential that IS set authenticates AND the smoke has
# every input it needs. Exit 1 names what is wrong.
#
# A stored-but-dead credential fails the run even when a fallback sender still
# works: on a schedule, "a secret you are keeping has rotted" is the whole
# signal. Fix it or unset it — do not let it sit there looking configured.
#
# DEAD means Slack rejected the credential — rotate or unset it. UNREACHABLE
# means Slack never answered a verdict (curl failed, or a non-200: auth.test
# answers 200 even for a token it rejects), which is Slack's problem, not the
# secret's. Both fail the run, so an outage is visible rather than silent.
#
# Output discipline: token VALUES are never printed. Each credential is
# reported by env-var name and byte length only, alongside whatever identity
# Slack itself returns. Slack's auth.test error is a fixed enum
# (invalid_auth, account_inactive, token_revoked, ...) and carries no secret.
#
# Env (all optional here; the smoke's own requirements are what is checked):
#   QA_SLACK_USER_TOKEN     xoxp- QA sender, posts as a real user (preferred)
#   QA_SLACK_BOT_TOKEN      xoxb- QA sender, from a *separate* Slack app
#   SLACK_BOT_TOKEN         the target Lobu bot; also the reply-poll token
#   QA_SLACK_TARGET_USER_ID target bot's user id, if not resolved via the above
#   QA_SLACK_CHANNEL        channel the smoke posts into
set -uo pipefail

failures=0
sender_name=""
sender_user_id=""
target_user_id="${QA_SLACK_TARGET_USER_ID:-}"

fail() {
  printf '  ✗ %s\n' "$1"
  failures=$((failures + 1))
}

# Sets PROBE_USER_ID on success. Returns 0 = alive, 1 = set but broken,
# 2 = not set (not a failure on its own; the caller decides whether the
# smoke actually needs this one).
PROBE_USER_ID=""
probe() {
  local name="$1" token="$2" resp status body detail
  PROBE_USER_ID=""
  if [ -z "$token" ]; then
    printf '  %-24s not set\n' "$name"
    return 2
  fi
  if ! resp=$(curl -sS --max-time 30 -w '\n%{http_code}' https://slack.com/api/auth.test \
    -H "Authorization: Bearer $token" 2>/dev/null); then
    printf '  %-24s len=%s  UNREACHABLE (curl failed)\n' "$name" "${#token}"
    return 1
  fi
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  # auth.test answers 200 with ok:false for every credential verdict, so a
  # non-200 is Slack's problem (edge 5xx, rate limit), not a dead token.
  # Calling that DEAD would page the devops channel during a Slack outage.
  if [ "$status" != "200" ]; then
    printf '  %-24s len=%s  UNREACHABLE (HTTP %s)\n' "$name" "${#token}" "$status"
    return 1
  fi
  if ! printf '%s' "$body" | jq -e '.ok == true' >/dev/null 2>&1; then
    # jq's `//` fallback only fires on a body that PARSES, so it cannot
    # describe a non-JSON body — an empty extraction is what identifies one.
    detail=$(printf '%s' "$body" | jq -r '.error // empty' 2>/dev/null) || detail=""
    [ -n "$detail" ] || detail="unparseable response"
    printf '  %-24s len=%s  DEAD (%s)\n' "$name" "${#token}" "$detail"
    return 1
  fi
  PROBE_USER_ID=$(printf '%s' "$body" | jq -r '.user_id // empty')
  printf '  %-24s len=%s  alive  team=%s user_id=%s\n' "$name" "${#token}" \
    "$(printf '%s' "$body" | jq -r '.team // "?"')" "${PROBE_USER_ID:-?}"
  return 0
}

echo "Slack QA credential liveness — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "credentials:"

probe QA_SLACK_USER_TOKEN "${QA_SLACK_USER_TOKEN:-}"
case $? in
0)
  sender_name=QA_SLACK_USER_TOKEN
  sender_user_id="$PROBE_USER_ID"
  ;;
1) failures=$((failures + 1)) ;;
esac

probe QA_SLACK_BOT_TOKEN "${QA_SLACK_BOT_TOKEN:-}"
case $? in
0)
  # A user token is the better sender (a real Slack user, not a second app),
  # so it wins when both authenticate.
  if [ -z "$sender_name" ]; then
    sender_name=QA_SLACK_BOT_TOKEN
    sender_user_id="$PROBE_USER_ID"
  fi
  ;;
1) failures=$((failures + 1)) ;;
esac

probe SLACK_BOT_TOKEN "${SLACK_BOT_TOKEN:-}"
case $? in
0) [ -n "$target_user_id" ] || target_user_id="$PROBE_USER_ID" ;;
1) failures=$((failures + 1)) ;;
esac

echo
echo "smoke prerequisites:"

if [ -n "$sender_name" ]; then
  printf '  ✓ sender: %s (%s)\n' "$sender_name" "$sender_user_id"
else
  fail "no QA sender token authenticates; set QA_SLACK_USER_TOKEN (xoxp-) or QA_SLACK_BOT_TOKEN (xoxb-)"
fi

if [ -n "$target_user_id" ]; then
  printf '  ✓ target bot: %s\n' "$target_user_id"
else
  fail "target bot unresolved; set QA_SLACK_TARGET_USER_ID or a working SLACK_BOT_TOKEN"
fi

# The smoke rejects this before posting, because a sender that is also the
# target reads its own message back as the bot's reply and passes for free.
if [ -n "$sender_user_id" ] && [ "$sender_user_id" = "$target_user_id" ]; then
  fail "sender and target are the same Slack user ($sender_user_id); the smoke needs a separate sender"
fi

if [ -n "${QA_SLACK_CHANNEL:-}" ]; then
  printf '  ✓ channel: %s\n' "$QA_SLACK_CHANNEL"
else
  fail "QA_SLACK_CHANNEL is not set; the scheduled smoke has nowhere to post (test-bot.sh also takes TEST_CHANNEL, but only a hand-run has it)"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "❌ $failures problem(s); the exact-response Slack smoke cannot run."
  exit 1
fi
echo "✅ Slack QA credentials are usable; scripts/test-bot.sh can run the exact-response smoke."
