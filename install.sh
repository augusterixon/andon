#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

fail() {
  echo ""
  echo "✗ $1"
  echo ""
  exit 1
}

echo "Andon — installing"
echo ""

# --- Preflight checks ---
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required but wasn't found. Install it from https://nodejs.org (or 'brew install node') and re-run this script."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required but wasn't found. It normally ships with Node.js — reinstalling Node from https://nodejs.org should fix this."
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 16 ]; then
  fail "Node.js 16+ is required (found $(node -v)). Update Node and re-run this script."
fi

echo "✓ Node.js $(node -v) found"
echo ""

# --- 1. Hooks — additive merge, creates ~/.claude and ~/.cursor if missing, ---
#     never overwrites your existing config in either. This also handles
#     migrating an old ~/.claude-lights data folder (from before the app was
#     renamed) to ~/.andon — must run BEFORE step 2 creates that folder, or
#     it would block its own migration by finding the folder already there.
if ! node merge-hooks.js; then
  fail "Hook installation failed — see the error above. Your existing ~/.claude/settings.json and ~/.cursor/hooks.json were not touched."
fi

# --- 2. Runtime data folder + the script Claude Code / Cursor hooks call ---
mkdir -p ~/.andon
cp update-status.js ~/.andon/update-status.js
echo "✓ Installed update-status.js to ~/.andon"

# --- 3. Sound asset — ship the tuned one; only regenerate if truly missing ---
if [ ! -f assets/pluck.wav ]; then
  mkdir -p assets
  node generate-pluck.js
  echo "✓ Generated notification sound"
else
  echo "✓ Notification sound present"
fi

# --- 4. Dependencies ---
if [ ! -d node_modules ]; then
  echo ""
  echo "Installing dependencies (Electron — this can take a minute)..."
  if ! npm install; then
    fail "npm install failed — check your network connection and try running 'npm install' manually in $DIR."
  fi
fi
echo "✓ Dependencies installed"

echo ""
echo "──────────────────────────────────────────────"
echo " Install complete."
echo "──────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  1. Fully restart Claude Code and/or Cursor (quit, don't just close the window) so they pick up the new hooks."
echo "  2. Run:"
echo ""
echo "       npm start"
echo ""
echo "     to launch the menu bar widget."
echo ""
