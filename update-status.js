#!/usr/bin/env node
/**
 * andon: update-status.js
 *
 * Called by Claude Code hooks. Usage:
 *   node update-status.js <yellow|green|red>
 *
 * Reads the hook's JSON payload from stdin to get the working directory,
 * so state is tracked per-project. Writes to ~/.andon/state.json.
 *
 * On "red" (waiting for permission), also fires a native OS notification.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.andon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const newState = process.argv[2]; // 'yellow' | 'green' | 'red'
if (!['yellow', 'green', 'red'].includes(newState)) {
  console.error('Usage: update-status.js <yellow|green|red>');
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve({});
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    // Safety timeout in case stdin never closes (e.g. run manually for testing)
    setTimeout(() => resolve({}), 300);
  });
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(cwd, state) {
  ensureDir();
  const current = loadJson(STATE_FILE, { projects: {} });
  current.projects[cwd] = {
    state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
}

function notifyNative(title, message) {
  if (process.platform === 'darwin') {
    execFile(
      'terminal-notifier',
      ['-title', title, '-message', message, '-sound', 'Ping', '-group', 'andon'],
      (err) => {
        if (err) {
          const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Ping"`;
          execFile('osascript', ['-e', script], () => {});
        }
      }
    );
  } else if (process.platform === 'win32') {
    const psScript = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
      $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $text = $template.GetElementsByTagName("text")
      $text[0].AppendChild($template.CreateTextNode("${title}")) > $null
      $text[1].AppendChild($template.CreateTextNode("${message}")) > $null
      $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Andon").Show($toast)
    `;
    execFile('powershell', ['-Command', psScript], () => {});
  } else {
    // linux fallback
    execFile('notify-send', [title, message], () => {});
  }
}

(async () => {
  const payload = await readStdin();
  const cwd = payload.cwd || (payload.workspace_roots && payload.workspace_roots[0]) || process.cwd();
  const projectName = path.basename(cwd);

  writeState(cwd, newState);

  if (newState === 'red') {
    notifyNative('Andon needs you', `${projectName} is waiting on a permission prompt`);
  }
})();
