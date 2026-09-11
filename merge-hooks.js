#!/usr/bin/env node
/**
 * andon: merge-hooks.js
 *
 * Safely merges Andon's hooks into the user's existing
 * ~/.claude/settings.json and ~/.cursor/hooks.json — additive only,
 * never touches unrelated hooks, and safe to re-run (won't duplicate
 * entries if it's already installed).
 *
 * Also migrates anyone upgrading from the old "Claude Lights" naming:
 * renames ~/.claude-lights → ~/.andon if the old folder exists, and
 * replaces any hook entries still pointing at the old path instead of
 * leaving them alongside the new ones (which would double-fire).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.andon');
const OLD_STATE_DIR = path.join(HOME, '.claude-lights'); // pre-rename location
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const CURSOR_HOOKS_PATH = path.join(HOME, '.cursor', 'hooks.json');

const OLD_MARKER = '.claude-lights/update-status.js';
const NEW_MARKER = '.andon/update-status.js';
const SCRIPT_CMD = (state) => `node ~/.andon/update-status.js ${state}`;

// --- Claude Code hooks (nested shape: { hooks: [{ type, command }] }) ---
const CLAUDE_HOOKS = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('yellow') }] }],
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: SCRIPT_CMD('yellow') }] }],
  Notification: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('red') }] }],
  PermissionRequest: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('red') }] }],
  PermissionDenied: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('yellow') }] }],
  Stop: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('green') }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: SCRIPT_CMD('green') }] }],
};

// --- Cursor hooks (flat shape: { command }) — no red mapping, see README ---
const CURSOR_HOOKS = {
  beforeSubmitPrompt: [{ command: SCRIPT_CMD('yellow') }],
  beforeShellExecution: [{ command: SCRIPT_CMD('yellow') }],
  beforeMCPExecution: [{ command: SCRIPT_CMD('yellow') }],
  stop: [{ command: SCRIPT_CMD('green') }],
  sessionEnd: [{ command: SCRIPT_CMD('green') }],
};

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function referencesMarker(entry, marker) {
  return JSON.stringify(entry).includes(marker);
}

// One-time migration: if the old ~/.claude-lights folder exists and the new
// ~/.andon one doesn't, rename it (keeps state.json/widget-prefs.json history
// intact). If that's not possible for some reason, fall back to just
// creating a fresh ~/.andon — never fatal, worst case is losing history.
function migrateStateDir() {
  if (fs.existsSync(STATE_DIR)) return;

  if (fs.existsSync(OLD_STATE_DIR)) {
    try {
      fs.renameSync(OLD_STATE_DIR, STATE_DIR);
      console.log(`✓ Migrated ${OLD_STATE_DIR} → ${STATE_DIR}`);
      return;
    } catch (err) {
      console.error(`Could not migrate old data folder (${err.message}) — creating a fresh one instead.`);
    }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// Drops any entries still pointing at the old ~/.claude-lights path (they've
// been superseded — keeping both would fire the script twice per event),
// then adds our current entries if they're not already present.
function mergeHookEvent(existingArray, ourEntries) {
  let arr = Array.isArray(existingArray) ? existingArray.slice() : [];
  arr = arr.filter((e) => !referencesMarker(e, OLD_MARKER));

  const alreadyPresent = arr.some((e) => referencesMarker(e, NEW_MARKER));
  if (!alreadyPresent) {
    for (const entry of ourEntries) arr.push(entry);
  }
  return arr;
}

function installClaudeHooks() {
  ensureDirFor(CLAUDE_SETTINGS_PATH);
  const settings = loadJson(CLAUDE_SETTINGS_PATH, {});
  settings.hooks = settings.hooks || {};

  for (const [event, entries] of Object.entries(CLAUDE_HOOKS)) {
    settings.hooks[event] = mergeHookEvent(settings.hooks[event], entries);
  }

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`✓ Merged Claude Code hooks into ${CLAUDE_SETTINGS_PATH}`);
}

function installCursorHooks() {
  ensureDirFor(CURSOR_HOOKS_PATH);
  const config = loadJson(CURSOR_HOOKS_PATH, { version: 1 });
  config.version = config.version || 1;
  config.hooks = config.hooks || {};

  for (const [event, entries] of Object.entries(CURSOR_HOOKS)) {
    config.hooks[event] = mergeHookEvent(config.hooks[event], entries);
  }

  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(config, null, 2));
  console.log(`✓ Merged Cursor hooks into ${CURSOR_HOOKS_PATH}`);
}

function installAllHooks() {
  migrateStateDir();
  installClaudeHooks();
  installCursorHooks();
}

// CLI usage (bash install.sh) runs immediately.
// require('./merge-hooks') from main.js does NOT auto-run — main.js calls
// installAllHooks() itself, at a point it controls (app startup).
if (require.main === module) {
  installAllHooks();
  console.log('✓ Hook installation complete — existing hooks were preserved, nothing was overwritten.');
}

module.exports = { installAllHooks };
