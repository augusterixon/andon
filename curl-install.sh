#!/usr/bin/env bash
set -e

# Andon curl installer.
# Usage:  curl -fsSL <raw-url-to-this-file> | bash
#
# Fill in REPO below once your GitHub repo exists.
REPO="augusterixon/andon"

fail() {
  echo ""
  echo "✗ $1"
  echo ""
  exit 1
}

if [ "$(uname)" != "Darwin" ]; then
  fail "Andon is macOS-only right now."
fi

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  ASSET_PATTERN="arm64-mac.zip"
elif [ "$ARCH" = "x86_64" ]; then
  ASSET_PATTERN="x64-mac.zip"
else
  fail "Unrecognized architecture: $ARCH"
fi

echo "Andon — installing for $ARCH"
echo ""

# Resolve the actual asset URL from the latest release rather than hardcoding
# a version number, so this script never goes stale.
API_URL="https://api.github.com/repos/$REPO/releases/latest"
DOWNLOAD_URL=$(curl -fsSL "$API_URL" | grep "browser_download_url.*$ASSET_PATTERN" | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  fail "Couldn't find a release asset matching *$ASSET_PATTERN at $API_URL — check the release was published with both zip files attached."
fi

TMP_DIR=$(mktemp -d)
ZIP_PATH="$TMP_DIR/andon.zip"

echo "Downloading..."
curl -fsSL "$DOWNLOAD_URL" -o "$ZIP_PATH" || fail "Download failed — check your network connection."

echo "Installing to /Applications..."
if [ -d "/Applications/Andon.app" ]; then
  # Quit the running instance first, if any, so we don't overwrite a locked binary.
  osascript -e 'tell application "Andon" to quit' 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/Andon.app"
fi

unzip -q "$ZIP_PATH" -d "$TMP_DIR"
mv "$TMP_DIR/Andon.app" "/Applications/Andon.app"

# curl downloads generally don't get the Gatekeeper quarantine flag the way
# browser downloads do, but strip it defensively in case this file gets
# relayed through Slack, AirDrop, etc. by someone before they run it.
xattr -dr com.apple.quarantine "/Applications/Andon.app" 2>/dev/null || true

rm -rf "$TMP_DIR"

# Copy hook merger out of the app bundle and run it now so ~/.cursor/hooks.json
# (beforeSubmitPrompt + stop) is ready before Andon even launches.
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required for Cursor/Claude hooks. Install it from https://nodejs.org (or 'brew install node') and re-run this script."
fi

mkdir -p "$HOME/.andon"
BUNDLED_HOOKS="/Applications/Andon.app/Contents/Resources/app/merge-hooks.js"
if [ ! -f "$BUNDLED_HOOKS" ]; then
  fail "Couldn't find merge-hooks.js inside Andon.app — the release zip looks incomplete."
fi
cp "$BUNDLED_HOOKS" "$HOME/.andon/merge-hooks.js"
BUNDLED_STATUS="/Applications/Andon.app/Contents/Resources/app/update-status.js"
if [ -f "$BUNDLED_STATUS" ]; then
  cp "$BUNDLED_STATUS" "$HOME/.andon/update-status.js"
fi

echo "Setting up Cursor/Claude hooks..."
if ! node "$HOME/.andon/merge-hooks.js"; then
  fail "Hook installation failed — see the error above. Your existing ~/.cursor/hooks.json was not overwritten."
fi

# Invite can come from env (ANDON_JOIN_URL / ANDON_INVITE_CODE) or a URL argument
# when piped as: curl ... | bash -s -- "andon://join?invite_code=..."
JOIN_URL=""
INVITE_CODE="${ANDON_INVITE_CODE:-}"
TEAM_ID="${ANDON_TEAM_ID:-}"
TEAM_NAME="${ANDON_TEAM_NAME:-}"
DASHBOARD_URL="${ANDON_DASHBOARD_URL:-https://andon-dashboard.vercel.app}"

if [ -n "${ANDON_JOIN_URL:-}" ]; then
  JOIN_URL="$ANDON_JOIN_URL"
elif [ -n "${1:-}" ]; then
  case "$1" in
    andon://*|anon://*|http://*|https://*) JOIN_URL="$1" ;;
  esac
fi

parse_join_fields() {
  node -e '
    const raw = process.env.ANDON_PARSE_URL || "";
    if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) process.exit(2);
    let url;
    try { url = new URL(raw); } catch { process.exit(2); }
    const proto = url.protocol;
    if (proto !== "andon:" && proto !== "anon:" && proto !== "http:" && proto !== "https:") process.exit(2);
    const invite = (url.searchParams.get("invite_code") || "").trim();
    const teamId = (url.searchParams.get("team_id") || "").trim();
    const teamName = (url.searchParams.get("team_name") || "").trim();
    const dash = (url.searchParams.get("dashboard_url") || "").trim();
    if (!/^[A-Za-z0-9]{4,32}$/.test(invite) || !/^[A-Za-z0-9._:-]{1,128}$/.test(teamId)) process.exit(3);
    if (teamName && (teamName.length > 80 || /[\u0000-\u001f\u007f]/.test(teamName))) process.exit(3);
    const out = { invite_code: invite, team_id: teamId, team_name: teamName, dashboard_url: dash };
    process.stdout.write(JSON.stringify(out));
  '
}

JOIN_PAYLOAD=""
if [ -n "$JOIN_URL" ]; then
  ANDON_PARSE_URL="$JOIN_URL"
  export ANDON_PARSE_URL
  PARSED="$(parse_join_fields)" || PARSED=""
  unset ANDON_PARSE_URL
  if [ -n "$PARSED" ]; then
    JOIN_PAYLOAD="$PARSED"
  else
    echo "Warning: invite URL was ignored because it was invalid."
  fi
elif [ -n "$INVITE_CODE" ] && [ -n "$TEAM_ID" ]; then
  JOIN_PAYLOAD="$(INVITE_CODE="$INVITE_CODE" TEAM_ID="$TEAM_ID" TEAM_NAME="$TEAM_NAME" DASHBOARD_URL="$DASHBOARD_URL" node -e '
    const invite = (process.env.INVITE_CODE || "").trim();
    const teamId = (process.env.TEAM_ID || "").trim();
    const teamName = (process.env.TEAM_NAME || "").trim();
    const dash = (process.env.DASHBOARD_URL || "").trim();
    if (!/^[A-Za-z0-9]{4,32}$/.test(invite) || !/^[A-Za-z0-9._:-]{1,128}$/.test(teamId)) process.exit(3);
    if (teamName && (teamName.length > 80 || /[\u0000-\u001f\u007f]/.test(teamName))) process.exit(3);
    process.stdout.write(JSON.stringify({
      invite_code: invite,
      team_id: teamId,
      team_name: teamName,
      dashboard_url: dash
    }));
  ')" || JOIN_PAYLOAD=""
  if [ -z "$JOIN_PAYLOAD" ]; then
    echo "Warning: invite environment variables were ignored because they were invalid."
  fi
fi

echo "Launching Andon (first-time team config)..."
open "/Applications/Andon.app"

if [ -n "$JOIN_PAYLOAD" ]; then
  echo "Waiting for Andon to accept the invite..."
  JOINED=0
  for i in $(seq 1 20); do
    if curl -fsS -X POST "http://127.0.0.1:9876/join" \
      -H "Content-Type: application/json" \
      --data-binary "$JOIN_PAYLOAD" >/dev/null 2>&1; then
      JOINED=1
      break
    fi
    sleep 0.5
  done
  if [ "$JOINED" = "1" ]; then
    echo "Joined team from invite."
  else
    echo "Andon launched, but auto-join did not complete. Open the andon:// link again once the menu bar icon is up."
  fi
else
  echo "No invite code provided — Andon will open the dashboard so you can create or join a team."
fi

echo ""
echo "──────────────────────────────────────────────"
echo " Done. Andon is running in your menu bar."
echo "──────────────────────────────────────────────"
echo ""
echo "One more step: fully restart Claude Code and/or Cursor"
echo "(quit, don't just close the window) so they pick up the new hooks."
echo ""
