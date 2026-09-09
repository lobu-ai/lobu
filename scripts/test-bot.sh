#!/bin/bash
set -euo pipefail

# Bot testing script with multi-message and multi-platform support
# Usage: ./scripts/test-bot.sh "message 1" ["message 2"] ["message 3"] ...
# Or: ./scripts/test-bot.sh (uses default test message)
#
# Environment variables:
#   TEST_PLATFORM   - "slack", "whatsapp", or "telegram" (default: auto-detect)
#   TEST_CHANNEL    - Channel ID (Slack), phone number (WhatsApp), or peer/chat ID (Telegram)
#   TEST_TIMEOUT    - Timeout in seconds (default: 120)
#   TEST_EXPECT_RESPONSE - Exact Slack reply required for a successful smoke test
#
# Platform-specific:
#   Slack: QA_SLACK_CHANNEL, QA_SLACK_USER_TOKEN (xoxp-) to send as real user,
#          or QA_SLACK_BOT_TOKEN (xoxb- from a *separate* QA-only Slack app) to
#          send an explicit target mention as a distinct bot. The sender or
#          SLACK_BOT_TOKEN needs the relevant history scope for reply polling.
#          QA_SLACK_TARGET_USER_ID identifies the bot whose reply must match;
#          alternatively, SLACK_BOT_TOKEN resolves the target via auth.test.
#          When present, SLACK_BOT_TOKEN is also used for reply polling.
#   WhatsApp: WHATSAPP_SELF_PHONE (defaults to bot's own number for self-chat)
#   Telegram: TELEGRAM_TEST_CHAT_ID, TG_API_ID, TG_API_HASH (uses tguser to send as real user)
#
# Slack smoke example (tokens already exported):
#   marker="LOBU_SMOKE_$(date +%s)"
#   TEST_PLATFORM=slack TEST_EXPECT_RESPONSE="$marker" ./scripts/test-bot.sh \
#     "<@$QA_SLACK_TARGET_USER_ID> Reply exactly $marker. Do not use tools."

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8787/lobu}"

fetch_telegram_bot_peer() {
    local username

    username=$(
        curl -sf "$GATEWAY_URL/internal/connections" 2>/dev/null || \
        curl -sf "$GATEWAY_URL/api/internal/connections" 2>/dev/null || \
        echo ""
    )

    username=$(
        printf '%s' "$username" | jq -r '
            .connections[]? |
            select(.platform == "telegram") |
            select(.status == "active") |
            .metadata.botUsername // empty
        ' 2>/dev/null | head -n 1
    )

    if [ -n "$username" ]; then
        printf '@%s\n' "${username#@}"
    fi
}

resolve_tguser_python() {
    local tguser_bin shebang interpreter exec_python

    if [ -n "${TGUSER_PYTHON:-}" ] && [ -x "$TGUSER_PYTHON" ]; then
        printf '%s\n' "$TGUSER_PYTHON"
        return
    fi

    tguser_bin="$(command -v tguser || true)"
    if [ -n "$tguser_bin" ] && [ -f "$tguser_bin" ]; then
        shebang="$(head -n 1 "$tguser_bin" 2>/dev/null || true)"
        if [[ "$shebang" == '#!'* ]]; then
            interpreter="${shebang#\#!}"
            interpreter="${interpreter%% *}"
            if [ -x "$interpreter" ] && [ "$interpreter" != "/bin/sh" ]; then
                printf '%s\n' "$interpreter"
                return
            fi
        fi

        exec_python="$(sed -n '2s/^exec \"\([^\"]*python[^\"]*\)\" .*/\1/p' "$tguser_bin" | head -n 1)"
        exec_python="${exec_python/#\$HOME/$HOME}"
        if [ -n "$exec_python" ] && [ -x "$exec_python" ]; then
            printf '%s\n' "$exec_python"
            return
        fi
    fi

    command -v python3 || true
}

TGUSER_PYTHON="$(resolve_tguser_python)"
TG_SESSION_COPY_DIRS=()

cleanup_tg_session_copies() {
    local dir
    for dir in "${TG_SESSION_COPY_DIRS[@]:-}"; do
        [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
    done
    return 0
}

trap cleanup_tg_session_copies EXIT

prepare_tg_session() {
    local source_input source_file temp_dir temp_base temp_file

    source_input="${1:-${TG_SESSION:-$HOME/.config/tguser/session}}"
    source_input="${source_input/#\~/$HOME}"
    source_input="${source_input%.session}"

    source_file="${source_input}.session"
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tguser-session.XXXXXX")" || return 1
    TG_SESSION_COPY_DIRS+=("$temp_dir")
    temp_base="$temp_dir/$(basename "$source_input")"
    temp_file="${temp_base}.session"

    if [ ! -f "$source_file" ]; then
        printf '%s\n' "$source_input"
        return 0
    fi

    if command -v sqlite3 > /dev/null 2>&1 && sqlite3 "$source_file" ".backup '$temp_file'" > /dev/null 2>&1; then
        printf '%s\n' "$temp_base"
        return 0
    fi

    cp "$source_file" "$temp_file"
    printf '%s\n' "$temp_base"
}

# Load .env if it exists (line-by-line to handle unquoted special chars)
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        # Extract key=value, strip surrounding quotes from value
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*) ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            # Strip surrounding quotes
            if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
                val="${BASH_REMATCH[1]}"
            fi
            export "$key=$val"
        fi
    done < .env
fi

QA_SEND_TOKEN="${QA_SLACK_USER_TOKEN:-${QA_SLACK_BOT_TOKEN:-}}"
if [ -z "${TEST_PLATFORM:-}" ] && [ -n "${TEST_EXPECT_RESPONSE:-}" ] && [ -n "$QA_SEND_TOKEN" ]; then
    TEST_PLATFORM=slack
fi
if [ -n "${TEST_EXPECT_RESPONSE:-}" ] && { [ "${TEST_PLATFORM:-}" != "slack" ] || [ -z "$QA_SEND_TOKEN" ]; }; then
    echo "❌ TEST_EXPECT_RESPONSE requires Slack with a QA sender token"
    exit 1
fi

resolve_auth_token() {
    if [ -n "${TEST_AUTH_TOKEN:-}" ]; then
        printf '%s\n' "$TEST_AUTH_TOKEN"
        return
    fi
    if [ -n "${LOBU_API_TOKEN:-}" ]; then
        printf '%s\n' "$LOBU_API_TOKEN"
        return
    fi
    if command -v lobu > /dev/null 2>&1; then
        lobu token --raw 2>/dev/null || true
    fi
}

telegram_send_and_wait() {
    local peer="$1"
    local message="$2"
    local timeout="$3"
    local session_path

    session_path="$(prepare_tg_session "${TG_SESSION:-$HOME/.config/tguser/session}")"

    TG_SEND_PEER="$peer" \
    TG_SEND_TEXT="$message" \
    TG_SEND_TIMEOUT="$timeout" \
    TG_SESSION="$session_path" \
    "$TGUSER_PYTHON" - <<'PY'
import asyncio
import json
import os
import sys
import time
from telethon import TelegramClient


async def resolve_peer(client: TelegramClient, peer: str):
    try:
        return await client.get_entity(peer)
    except Exception:
        normalized = peer.lower().lstrip("@")
        async for dialog in client.iter_dialogs():
            username = getattr(dialog.entity, "username", None)
            if username and username.lower() == normalized:
                return dialog.entity
        raise


async def main() -> int:
    api_id_s = os.environ.get("TG_API_ID", "").strip()
    api_hash = os.environ.get("TG_API_HASH", "").strip()
    peer = os.environ.get("TG_SEND_PEER", "").strip()
    message = os.environ.get("TG_SEND_TEXT", "")
    timeout = float(os.environ.get("TG_SEND_TIMEOUT", "60"))
    session = os.environ.get("TG_SESSION", "").strip() or os.path.expanduser(
        "~/.config/tguser/session"
    )

    if not api_id_s or not api_hash or not peer:
        print("Missing TG_API_ID, TG_API_HASH, or Telegram peer.", file=sys.stderr)
        return 2

    client = TelegramClient(session, int(api_id_s), api_hash)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("Not authenticated. Run `tguser login`.", file=sys.stderr)
            return 1

        entity = await resolve_peer(client, peer)
        sent = await client.send_message(entity, message)
        sent_ts = sent.date.timestamp()
        deadline = time.time() + timeout

        while time.time() < deadline:
            async for reply in client.iter_messages(entity, limit=10):
                reply_ts = reply.date.timestamp()
                if reply_ts <= sent_ts:
                    break
                if reply.out:
                    continue

                text = (reply.message or "").strip()
                if not text:
                    media = type(reply.media).__name__ if reply.media else "unknown"
                    text = f"[non-text reply: {media}]"

                print(
                    json.dumps(
                        {
                            "sentMessageId": sent.id,
                            "responseText": text,
                        }
                    )
                )
                return 0

            await asyncio.sleep(2)

        print(
            f"Timeout waiting for Telegram reply within {int(timeout)}s",
            file=sys.stderr,
        )
        return 1
    finally:
        await client.disconnect()


raise SystemExit(asyncio.run(main()))
PY
}

# Fetch gateway's active test targets once; used for both platform auto-detect
# and agent-id fallback so explicit TEST_PLATFORM runs still resolve the owning
# agent (otherwise the default `test-<platform>` placeholder has no provider).
TEST_TARGETS=""
if [ "${TEST_PLATFORM:-}" != "slack" ] || [ -z "$QA_SEND_TOKEN" ]; then
    TEST_TARGETS=$(curl -sf "$GATEWAY_URL/internal/connections/test-targets" 2>/dev/null || \
        curl -sf "$GATEWAY_URL/api/internal/connections/test-targets" 2>/dev/null || \
        echo "")
fi

if [ -n "$TEST_TARGETS" ] && [ -z "${TEST_AGENT_ID:-}" ]; then
    if [ -n "${TEST_PLATFORM:-}" ]; then
        TEST_AGENT_ID=$(echo "$TEST_TARGETS" | jq -r --arg p "$TEST_PLATFORM" '.[]? | select(.platform == $p) | .agentId // empty' 2>/dev/null | head -n 1)
    else
        TEST_AGENT_ID=$(echo "$TEST_TARGETS" | jq -r '.[0].agentId // empty' 2>/dev/null || echo "")
    fi
fi

# Auto-detect platform from active messaging connections, fall back to env vars
if [ -z "${TEST_PLATFORM:-}" ]; then
    if [ -n "$TEST_TARGETS" ]; then
        TEST_PLATFORM=$(echo "$TEST_TARGETS" | jq -r '.[0].platform // empty' 2>/dev/null || echo "")
        if [ -z "${TEST_CHANNEL:-}" ]; then
            TEST_CHANNEL=$(echo "$TEST_TARGETS" | jq -r '.[0].defaultTarget // empty' 2>/dev/null || echo "")
        fi
        if [ "$TEST_PLATFORM" = "telegram" ] && [ -z "${TELEGRAM_TEST_BOT_USERNAME:-}" ]; then
            TELEGRAM_TEST_BOT_USERNAME="$(fetch_telegram_bot_peer)"
        fi
    fi

    # Fall back to env var detection if gateway didn't respond
    if [ -z "$TEST_PLATFORM" ]; then
        TELEGRAM_CHANNEL="${TEST_CHANNEL:-${TELEGRAM_TEST_CHAT_ID:-}}"
        TELEGRAM_READY="false"
        if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "$TELEGRAM_CHANNEL" ] && command -v tguser > /dev/null 2>&1 && [ -n "${TG_API_ID:-}" ] && [ -n "${TG_API_HASH:-}" ]; then
            TELEGRAM_READY="true"
        fi

        if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
            TEST_PLATFORM="slack"
        elif [ "$TELEGRAM_READY" = "true" ]; then
            TEST_PLATFORM="telegram"
        elif [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
            TEST_PLATFORM="telegram"
        else
            echo "❌ No platform detected. Set TEST_PLATFORM=slack|telegram|whatsapp"
            exit 1
        fi
    fi
fi

TIMEOUT="${TEST_TIMEOUT:-120}"

# Platform-specific setup
case "$TEST_PLATFORM" in
    slack)
        AUTH_TOKEN=""
        if [ -z "$QA_SEND_TOKEN" ]; then
            AUTH_TOKEN="$(resolve_auth_token)"
        fi
        CHANNEL="${TEST_CHANNEL:-${QA_SLACK_CHANNEL:-}}"
        if [ -z "$CHANNEL" ]; then
            echo "❌ QA_SLACK_CHANNEL or TEST_CHANNEL environment variable is required for Slack"
            exit 1
        fi
        if [ -n "$QA_SEND_TOKEN" ]; then
            TARGET_BOT_USER_ID="${QA_SLACK_TARGET_USER_ID:-}"
            if [ -z "$TARGET_BOT_USER_ID" ] && [ -n "${SLACK_BOT_TOKEN:-}" ]; then
                TARGET_AUTH=$(curl -fsS --max-time 30 https://slack.com/api/auth.test \
                    -H "Authorization: Bearer $SLACK_BOT_TOKEN")
                if ! printf '%s' "$TARGET_AUTH" | jq -e '.ok == true' >/dev/null; then
                    echo "❌ Target auth.test failed: $(printf '%s' "$TARGET_AUTH" | jq -r '.error')"
                    exit 1
                fi
                TARGET_BOT_USER_ID=$(printf '%s' "$TARGET_AUTH" | jq -r '.user_id // empty')
            fi
            if [ -z "$TARGET_BOT_USER_ID" ]; then
                echo "❌ Set QA_SLACK_TARGET_USER_ID or SLACK_BOT_TOKEN to identify the target bot"
                exit 1
            fi
            SENDER_AUTH=$(curl -fsS --max-time 30 https://slack.com/api/auth.test \
                -H "Authorization: Bearer $QA_SEND_TOKEN")
            if ! printf '%s' "$SENDER_AUTH" | jq -e '.ok == true and (.user_id | type == "string")' >/dev/null; then
                echo "❌ Sender auth.test failed: $(printf '%s' "$SENDER_AUTH" | jq -r '.error')"
                exit 1
            fi
            if [ "$(printf '%s' "$SENDER_AUTH" | jq -r '.user_id')" = "$TARGET_BOT_USER_ID" ]; then
                echo "❌ QA sender and target are the same Slack user; use a separate sender"
                exit 1
            fi
        fi
        ;;
    whatsapp)
        AUTH_TOKEN="$(resolve_auth_token)"
        CHANNEL="${TEST_CHANNEL:-${WHATSAPP_SELF_PHONE:-}}"
        if [ -z "$CHANNEL" ]; then
            # For self-chat mode, we can use "self" as a special channel
            if [ "${WHATSAPP_SELF_CHAT:-}" = "true" ]; then
                CHANNEL="self"
            else
                echo "❌ TEST_CHANNEL or WHATSAPP_SELF_PHONE environment variable is required for WhatsApp"
                exit 1
            fi
        fi
        ;;
    telegram)
        AUTH_TOKEN="$(resolve_auth_token)"
        CHANNEL="${TEST_CHANNEL:-${TELEGRAM_TEST_CHAT_ID:-}}"
        ACTIVE_TELEGRAM_BOT_PEER="$(fetch_telegram_bot_peer)"
        TELEGRAM_BOT_PEER="${TELEGRAM_TEST_BOT_USERNAME:-}"
        if [[ -n "$TELEGRAM_BOT_PEER" && "$TELEGRAM_BOT_PEER" != @* ]]; then
            TELEGRAM_BOT_PEER="@${TELEGRAM_BOT_PEER}"
        fi
        if [[ "$CHANNEL" == @* ]]; then
            TELEGRAM_BOT_PEER="$CHANNEL"
        elif [ -z "$TELEGRAM_BOT_PEER" ]; then
            TELEGRAM_BOT_PEER="$ACTIVE_TELEGRAM_BOT_PEER"
        fi
        if [[ "$TELEGRAM_BOT_PEER" == @* ]] && [[ -n "$ACTIVE_TELEGRAM_BOT_PEER" ]] && [[ "$TELEGRAM_BOT_PEER" != "$ACTIVE_TELEGRAM_BOT_PEER" ]]; then
            echo "⚠️  Requested Telegram bot peer $TELEGRAM_BOT_PEER does not match active gateway connection $ACTIVE_TELEGRAM_BOT_PEER"
            echo "   Using active gateway bot peer instead."
            TELEGRAM_BOT_PEER="$ACTIVE_TELEGRAM_BOT_PEER"
            if [[ "$CHANNEL" == @* ]]; then
                CHANNEL="$ACTIVE_TELEGRAM_BOT_PEER"
            fi
        fi
        if [ -z "$CHANNEL" ] && [ -z "$TELEGRAM_BOT_PEER" ]; then
            echo "❌ Telegram testing requires TEST_CHANNEL/TELEGRAM_TEST_CHAT_ID or TELEGRAM_TEST_BOT_USERNAME"
            exit 1
        fi
        ;;
    *)
        echo "❌ Unknown platform: $TEST_PLATFORM. Use 'slack', 'whatsapp', or 'telegram'"
        exit 1
        ;;
esac

if [ -z "$AUTH_TOKEN" ] && { [ "$TEST_PLATFORM" != "slack" ] || [ -z "$QA_SEND_TOKEN" ]; }; then
    echo "❌ Authentication token required. Set TEST_AUTH_TOKEN/LOBU_API_TOKEN or run \`lobu login\`."
    exit 1
fi

# Get messages from arguments or use default
if [ $# -eq 0 ]; then
    MESSAGES=("@me test message")
else
    MESSAGES=("$@")
fi

echo "🧪 Testing bot with ${#MESSAGES[@]} message(s)"
echo "📱 Platform: $TEST_PLATFORM"
if [ "$TEST_PLATFORM" = "telegram" ] && [ -n "$TELEGRAM_BOT_PEER" ]; then
    echo "📍 Channel: ${CHANNEL:-"(none)"}"
    echo "🤖 Bot peer: $TELEGRAM_BOT_PEER"
else
    echo "📍 Channel: $CHANNEL"
fi
echo "⏱️  Timeout: ${TIMEOUT}s"
echo ""

LAST_THREAD_ID=""

# Send each message sequentially
for i in "${!MESSAGES[@]}"; do
    MESSAGE="${MESSAGES[$i]}"
    MSG_NUM=$((i + 1))

    echo "[$MSG_NUM/${#MESSAGES[@]}] 📤 Sending: $MESSAGE"

    if [ "$TEST_PLATFORM" = "telegram" ] && [ -n "${TGUSER_PYTHON:-}" ] && [ -n "${TG_API_ID:-}" ] && [ -n "${TG_API_HASH:-}" ]; then
        if [ -z "$TELEGRAM_BOT_PEER" ]; then
            echo "   ❌ Missing Telegram bot peer. Set TELEGRAM_TEST_BOT_USERNAME or TEST_CHANNEL=@botusername."
            exit 1
        fi

        echo "   ✅ Sending via Telegram user session to $TELEGRAM_BOT_PEER"
        echo "   ⏳ Waiting for bot response..."
        TELEGRAM_RESULT=$(TG_API_ID="$TG_API_ID" TG_API_HASH="$TG_API_HASH" telegram_send_and_wait "$TELEGRAM_BOT_PEER" "$MESSAGE" "$TIMEOUT" 2>&1) || {
            echo "   ❌ Failed Telegram E2E message $MSG_NUM:"
            printf '%s\n' "$TELEGRAM_RESULT" | sed 's/^/      /'
            exit 1
        }
        MESSAGE_ID=$(printf '%s' "$TELEGRAM_RESULT" | jq -r '.sentMessageId')
        BOT_RESPONSE=$(printf '%s' "$TELEGRAM_RESULT" | jq -r '.responseText')
        echo "   ✅ Sent: messageId=$MESSAGE_ID"
        echo "   ✅ Bot responded:"
        printf '%s\n' "$BOT_RESPONSE" | sed 's/^/      /'
        echo ""
        continue
    elif [ "$TEST_PLATFORM" = "telegram" ]; then
        echo "   ℹ️  TG_API_ID/TG_API_HASH not configured; falling back to gateway-side Telegram send"
    fi

    # Slack QA-sender path: post via chat.postMessage so the target bot sees a
    # genuine Slack event instead of a gateway-forged enqueue.
    #   - QA_SLACK_USER_TOKEN (xoxp-): posts as a real user.
    #   - QA_SLACK_BOT_TOKEN  (xoxb-): posts an explicit target mention as a
    #     separate QA bot.
    if [ "$TEST_PLATFORM" = "slack" ] && [ -z "$QA_SEND_TOKEN" ]; then
        echo "   ⚠️  No QA Slack token set — using gateway-forged send."
        echo "       The message is queued directly to the worker; nothing"
        echo "       appears in Slack as an inbound message."
        echo "       To exercise the real webhook flow, set either"
        echo "       QA_SLACK_USER_TOKEN=<xoxp-...> or QA_SLACK_BOT_TOKEN=<xoxb-...>"
        echo "       (the latter must come from a *separate* Slack app)."
    fi
    if [ "$TEST_PLATFORM" = "slack" ] && [ -n "$QA_SEND_TOKEN" ]; then
        if [ -n "${QA_SLACK_USER_TOKEN:-}" ]; then
            echo "   ✅ Sending via QA user token to $CHANNEL"
        else
            echo "   ✅ Sending via QA bot token to $CHANNEL"
        fi
        POST_BODY="channel=$CHANNEL&text=$(printf '%s' "$MESSAGE" | jq -sRr @uri)"
        if [ -n "$LAST_THREAD_ID" ]; then
            POST_BODY="$POST_BODY&thread_ts=$LAST_THREAD_ID"
        fi
        POST_RESP=$(curl -fsS --max-time 30 -X POST https://slack.com/api/chat.postMessage \
            -H "Authorization: Bearer $QA_SEND_TOKEN" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "$POST_BODY")
        if ! echo "$POST_RESP" | jq -e '.ok' > /dev/null 2>&1; then
            echo "   ❌ Slack chat.postMessage failed:"
            echo "$POST_RESP" | jq 2>/dev/null || echo "$POST_RESP"
            exit 1
        fi
        MESSAGE_ID=$(echo "$POST_RESP" | jq -r '.ts')
        echo "   ✅ Sent: ts=$MESSAGE_ID"
        if [ -z "$LAST_THREAD_ID" ]; then
            LAST_THREAD_ID="$MESSAGE_ID"
        fi

        POLL_TOKEN="${SLACK_BOT_TOKEN:-$QA_SEND_TOKEN}"
        echo "   ⏳ Waiting for bot response..."
        START_TIME=$(date +%s)
        BOT_RESPONSE=""
        while true; do
            CURRENT_TIME=$(date +%s)
            ELAPSED=$((CURRENT_TIME - START_TIME))
            if [ $ELAPSED -ge $TIMEOUT ]; then
                echo "   ❌ Timeout: No matching reply from $TARGET_BOT_USER_ID within ${TIMEOUT}s"
                if [ -n "$BOT_RESPONSE" ]; then
                    printf '      Last reply: %s\n' "$BOT_RESPONSE"
                fi
                exit 1
            fi
            REPLIES=$(curl -fsS --max-time 30 -X POST https://slack.com/api/conversations.replies \
                -H "Authorization: Bearer $POLL_TOKEN" \
                -H "Content-Type: application/x-www-form-urlencoded" \
                -d "channel=$CHANNEL&ts=$LAST_THREAD_ID&oldest=$MESSAGE_ID&limit=20")
            if ! printf '%s' "$REPLIES" | jq -e '.ok == true' >/dev/null; then
                echo "   ❌ Slack conversations.replies failed: $(printf '%s' "$REPLIES" | jq -r '.error')"
                exit 1
            fi
            BOT_RESPONSE=$(printf '%s' "$REPLIES" | jq -r \
                --arg user "$TARGET_BOT_USER_ID" --arg expected "${TEST_EXPECT_RESPONSE:-}" \
                '([.messages[]? | select(.user == $user and .text != null) | .text]) as $responses
                | if $expected != "" and any($responses[]; . == $expected)
                  then $expected
                  else ($responses | last // empty)
                  end')
            if [ -n "$BOT_RESPONSE" ]; then
                if [ -z "${TEST_EXPECT_RESPONSE:-}" ] || [ "$BOT_RESPONSE" = "$TEST_EXPECT_RESPONSE" ]; then
                    if [ -n "${TEST_EXPECT_RESPONSE:-}" ]; then
                        printf '   ✅ Matched expected response: %s\n' "$BOT_RESPONSE"
                    else
                        printf '   ✅ Target bot responded: %s\n' "$BOT_RESPONSE"
                    fi
                    break
                fi
            fi
            sleep 2
        done
        echo ""
        continue
    fi

    # Escape message for JSON (handle newlines, quotes, backslashes)
    ESCAPED_MESSAGE=$(printf '%s' "$MESSAGE" | jq -Rs .)

    # Build request body using jq for proper JSON
    # Use TEST_AGENT_ID or generate a default test agent ID
    AGENT_ID="${TEST_AGENT_ID:-test-$TEST_PLATFORM}"

    # Build request body (must match /api/v1/agents/{agentId}/messages schema)
    BODY=$(jq -n \
        --arg platform "$TEST_PLATFORM" \
        --argjson content "$ESCAPED_MESSAGE" \
        '{platform: $platform, content: $content}')

    # Add platform-specific routing info
    case "$TEST_PLATFORM" in
        slack)
            if [ -n "$LAST_THREAD_ID" ]; then
                BODY=$(echo "$BODY" | jq --arg channel "$CHANNEL" --arg thread "$LAST_THREAD_ID" '. + {slack: {channel: $channel, thread: $thread}}')
            else
                BODY=$(echo "$BODY" | jq --arg channel "$CHANNEL" '. + {slack: {channel: $channel}}')
            fi
            ;;
        whatsapp)
            BODY=$(echo "$BODY" | jq --arg chat "$CHANNEL" '. + {whatsapp: {chat: $chat}}')
            ;;
        telegram)
            BODY=$(echo "$BODY" | jq --arg chatId "$CHANNEL" '. + {telegram: {chatId: $chatId}}')
            ;;
    esac

    # Send message
    RESPONSE=$(curl -s -X POST "$GATEWAY_URL/api/v1/agents/$AGENT_ID/messages" \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$BODY")

    # Check success
    if ! echo "$RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
        echo "   ❌ Failed to send message $MSG_NUM:"
        echo "$RESPONSE" | jq 2>/dev/null || echo "$RESPONSE"
        exit 1
    fi

    MESSAGE_ID=$(echo "$RESPONSE" | jq -r '.messageId')
    QUEUED=$(echo "$RESPONSE" | jq -r '.queued')

    echo "   ✅ Sent: messageId=$MESSAGE_ID, queued=$QUEUED"

    # Save thread for subsequent messages
    if [ -z "$LAST_THREAD_ID" ]; then
        LAST_THREAD_ID="$MESSAGE_ID"
    fi

    # Platform-specific response handling
    case "$TEST_PLATFORM" in
        slack)
            # For Slack, we can optionally poll for responses when a bot token is available.
            if [ "$QUEUED" = "true" ]; then
                echo "   📋 Queued directly - checking logs..."
                sleep 2
            elif [ -z "${SLACK_BOT_TOKEN:-}" ]; then
                echo "   📋 Sent via configured Slack connection"
                echo "   ℹ️  Set SLACK_BOT_TOKEN to enable automatic reply polling"
            else
                echo "   ⏳ Waiting for bot response..."
                START_TIME=$(date +%s)

                while true; do
                    CURRENT_TIME=$(date +%s)
                    ELAPSED=$((CURRENT_TIME - START_TIME))

                    if [ $ELAPSED -ge $TIMEOUT ]; then
                        echo "   ❌ Timeout: No bot response within ${TIMEOUT}s"
                        exit 1
                    fi

                    # Check for replies in thread
                    REPLIES=$(curl -s -X POST https://slack.com/api/conversations.replies \
                        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
                        -H "Content-Type: application/x-www-form-urlencoded" \
                        -d "channel=$CHANNEL&ts=$LAST_THREAD_ID&limit=20")

                    # Check if we got bot messages after our message
                    BOT_RESPONSE=$(echo "$REPLIES" | jq -r '.messages[]? | select(.bot_id != null) | select(.ts > "'"$MESSAGE_ID"'") | .text' | head -1)

                    if [ -n "$BOT_RESPONSE" ]; then
                        echo "   ✅ Bot responded:"
                        echo "      $(echo "$BOT_RESPONSE" | head -c 200)..."
                        break
                    fi

                    sleep 2
                done
            fi
            ;;
        whatsapp)
            # For WhatsApp, we can't poll for responses - just wait and check logs
            echo "   📋 Message sent to WhatsApp - check your phone for response"
            if [ "$QUEUED" = "true" ]; then
                echo "   ⏳ Waiting for processing..."
                sleep 5
            fi
            ;;
        telegram)
            echo "   📋 Message sent to Telegram via configured connection"
            echo "   ℹ️  Automatic reply polling is unavailable without tguser credentials"
            ;;
    esac

    echo ""
done

echo "🎉 All messages sent successfully!"
exit 0
