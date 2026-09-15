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
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.andon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PREFS_FILE = path.join(STATE_DIR, 'widget-prefs.json');
const TEAMS_FILE = path.join(STATE_DIR, 'teams.json');
const DASHBOARD_STATES = new Set(['green', 'yellow', 'red']);
const PRIORITY = { red: 3, yellow: 2, green: 1 };
const STALE_MS = 1000 * 60 * 10;

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
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Same rules as the tray: selected project, or worst-of-all, ignoring stale entries.
function computeDisplayState() {
  const data = loadJson(STATE_FILE, { projects: {} });
  const prefs = loadJson(PREFS_FILE, { selected: 'All' });
  const now = Date.now();
  const entries = Object.entries(data.projects || {}).filter(
    ([, v]) => now - new Date(v.updatedAt).getTime() < STALE_MS
  );

  if (entries.length === 0) return 'off';

  if (prefs.selected != null && prefs.selected !== '' && prefs.selected !== 'All') {
    const match = entries.find(([cwd]) => path.basename(cwd) === prefs.selected);
    return match ? match[1].state : 'off';
  }

  let best = 'green';
  for (const [, v] of entries) {
    if ((PRIORITY[v.state] || 0) > (PRIORITY[best] || 0)) best = v.state;
  }
  return best;
}

function dashboardState(state) {
  if (DASHBOARD_STATES.has(state)) return state;
  if (state === 'off') return 'green';
  return null;
}

function postDashboardState(urlString, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }

    const payload = Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'User-Agent': 'Andon',
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`dashboard returned ${res.statusCode}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('dashboard notify timed out'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function loadTeamsStore() {
  if (!fs.existsSync(TEAMS_FILE)) return { active_team_id: null, teams: {} };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  } catch (err) {
    console.error('Andon: ~/.andon/teams.json is corrupted, ignoring', err && err.message ? err.message : err);
    return { active_team_id: null, teams: {} };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('Andon: ~/.andon/teams.json is corrupted, ignoring');
    return { active_team_id: null, teams: {} };
  }

  const teams =
    raw.teams && typeof raw.teams === 'object' && !Array.isArray(raw.teams) ? raw.teams : {};
  let activeId = typeof raw.active_team_id === 'string' && raw.active_team_id ? raw.active_team_id : null;
  if (!activeId || !teams[activeId]) {
    activeId = Object.keys(teams)[0] || null;
  }
  return { active_team_id: activeId, teams };
}

function getActiveTeam() {
  const store = loadTeamsStore();
  if (!store.active_team_id) return null;
  const team = store.teams[store.active_team_id];
  return team && typeof team === 'object' ? team : null;
}

function notifyDashboard(state) {
  try {
    const team = getActiveTeam();
    if (!team) {
      console.error('Andon: no active team in ~/.andon/teams.json, skipping dashboard notify');
      return Promise.resolve();
    }

    const dashboardUrl = typeof team.dashboard_url === 'string' ? team.dashboard_url.trim() : '';
    const teamId = typeof team.team_id === 'string' ? team.team_id.trim() : '';
    const memberId = typeof team.member_id === 'string' ? team.member_id.trim() : '';
    const authToken = typeof team.auth_token === 'string' ? team.auth_token.trim() : '';

    if (!dashboardUrl || !teamId || !memberId || !authToken) {
      console.error('Andon: active team config is incomplete, skipping dashboard notify');
      return Promise.resolve();
    }

    const mapped = dashboardState(state);
    if (!mapped) {
      console.error(`Andon: skipping dashboard notify for invalid state "${state}"`);
      return Promise.resolve();
    }

    const url = `${dashboardUrl.replace(/\/$/, '')}/api/state`;
    return postDashboardState(url, {
      team_id: teamId,
      member_id: memberId,
      state: mapped,
      auth_token: authToken,
    }).catch((err) => {
      console.error('Andon: dashboard notify failed', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('Andon: dashboard notify failed', err && err.message ? err.message : err);
    return Promise.resolve();
  }
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
  const dashboardNotify = notifyDashboard(computeDisplayState());

  if (newState === 'red') {
    notifyNative('Andon needs you', `${projectName} is waiting on a permission prompt`);
  }

  // Stay alive until the POST finishes so a hook process exit can't drop it.
  // Errors are swallowed inside notifyDashboard — this never fails the hook.
  await dashboardNotify;
})();
