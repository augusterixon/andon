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

echo "Launching Andon (first-time team config + dashboard)..."
open "/Applications/Andon.app"

echo ""
echo "──────────────────────────────────────────────"
echo " Done. Andon is running in your menu bar."
echo "──────────────────────────────────────────────"
echo ""
echo "One more step: fully restart Claude Code and/or Cursor"
echo "(quit, don't just close the window) so they pick up the new hooks."
echo ""
