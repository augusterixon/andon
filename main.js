const { app, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { renderCirclePNG } = require('./pulse-icon');
const { installAllHooks } = require('./merge-hooks');
const { checkForUpdates } = require('./updater');

const STATE_DIR = path.join(os.homedir(), '.andon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PREFS_FILE = path.join(STATE_DIR, 'widget-prefs.json');
const TEAMS_FILE = path.join(STATE_DIR, 'teams.json');
const TEAM_CONFIG_HOST = '127.0.0.1';
const TEAM_CONFIG_PORT = 9876;
const JOIN_FIELDS = ['team_id', 'member_id', 'auth_token', 'team_name'];
const DEFAULT_DASHBOARD_URL = 'https://andon-dashboard.vercel.app';
const ANDON_SCHEMES = new Set(['andon:', 'anon:']);
const SAFE_INVITE = /^[A-Za-z0-9]{4,32}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DASHBOARD_STATES = new Set(['green', 'yellow', 'red']);
const DEFAULT_READY_SOUND = 'sound-1';
const READY_SOUNDS = [
  { id: 'sound-1', label: 'Default' },
  { id: 'sound-2', label: "That's awkward" },
  { id: 'sound-3', label: "Let's go" },
  { id: 'sound-4', label: 'Kör föffan' },
  { id: 'sound-5', label: "It's done" },
  { id: 'sound-6', label: 'Work work' },
  { id: 'sound-7', label: 'Ready to work' },
];

const EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', off: '⚪' };
const PRIORITY = { red: 3, yellow: 2, green: 1 };
const STALE_MS = 1000 * 60 * 10;

let tray = null;
let lastColor = null;
let isAnimating = false;
let isCheckingForUpdates = false;
let joinNotice = null;
let pendingJoinUrl = null;
let teamConfigReady = false;
let skipFirstLaunchDashboard = false;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file);
}

function isAllProjects(selected) {
  return selected == null || selected === '' || selected === 'All';
}

function isKnownReadySound(id) {
  return READY_SOUNDS.some((sound) => sound.id === id);
}

function getPrefs() {
  const prefs = loadJson(PREFS_FILE, { selected: 'All', soundEnabled: true, readySound: DEFAULT_READY_SOUND });
  if (isAllProjects(prefs.selected)) prefs.selected = 'All';
  if (!isKnownReadySound(prefs.readySound)) prefs.readySound = DEFAULT_READY_SOUND;
  return prefs;
}

function toggleSound() {
  const prefs = getPrefs();
  saveJson(PREFS_FILE, { ...prefs, soundEnabled: !prefs.soundEnabled });
  updateMenu();
  notifyDashboard(computeState().color);
}

function setSelected(name) {
  const prefs = getPrefs();
  const selected = isAllProjects(name) ? 'All' : name;
  saveJson(PREFS_FILE, { ...prefs, selected });
  updateMenu();
  refresh();
  notifyDashboard(computeState().color);
}

function setReadySound(id) {
  if (!isKnownReadySound(id)) return;
  const prefs = getPrefs();
  saveJson(PREFS_FILE, { ...prefs, readySound: id });
  updateMenu();
}

function computeState() {
  const data = loadJson(STATE_FILE, { projects: {} });
  const prefs = getPrefs();
  const now = Date.now();

  const entries = Object.entries(data.projects || {}).filter(
    ([, v]) => now - new Date(v.updatedAt).getTime() < STALE_MS
  );

  if (entries.length === 0) return { color: 'off', projects: [] };

  const projectNames = entries.map(([cwd]) => path.basename(cwd));

  if (!isAllProjects(prefs.selected)) {
    const match = entries.find(([cwd]) => path.basename(cwd) === prefs.selected);
    return { color: match ? match[1].state : 'off', projects: projectNames };
  }

  let worst = 'green';
  for (const [, v] of entries) {
    if ((PRIORITY[v.state] || 0) > (PRIORITY[worst] || 0)) worst = v.state;
  }
  return { color: worst, projects: projectNames };
}

function resetAll() {
  saveJson(STATE_FILE, { projects: {} });
  updateMenu();
  refresh();
  notifyDashboard(computeState().color);
}

function emptyTeamsStore() {
  return { active_team_id: null, teams: {}, dashboard_url: DEFAULT_DASHBOARD_URL };
}

function ensureTeamsConfig() {
  if (fs.existsSync(TEAMS_FILE)) return false;
  saveTeamsStore(emptyTeamsStore());
  return true;
}

function resolveDashboardUrl(team) {
  const fromTeam = team && typeof team.dashboard_url === 'string' ? team.dashboard_url.trim() : '';
  return (fromTeam || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
}

function loadTeamsStore() {
  if (!fs.existsSync(TEAMS_FILE)) return emptyTeamsStore();

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  } catch (err) {
    console.error('Andon: ~/.andon/teams.json is corrupted, ignoring', err && err.message ? err.message : err);
    return emptyTeamsStore();
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('Andon: ~/.andon/teams.json is corrupted, ignoring');
    return emptyTeamsStore();
  }

  const teams =
    raw.teams && typeof raw.teams === 'object' && !Array.isArray(raw.teams) ? raw.teams : {};
  let activeId = typeof raw.active_team_id === 'string' && raw.active_team_id ? raw.active_team_id : null;
  if (activeId && !teams[activeId]) {
    activeId = Object.keys(teams)[0] || null;
  } else if (!activeId) {
    activeId = Object.keys(teams)[0] || null;
  }

  return { active_team_id: activeId, teams, dashboard_url: DEFAULT_DASHBOARD_URL };
}

function saveTeamsStore(store) {
  saveJson(TEAMS_FILE, {
    active_team_id: store.active_team_id,
    teams: store.teams,
    dashboard_url: DEFAULT_DASHBOARD_URL,
  });
}

function getActiveTeam() {
  const store = loadTeamsStore();
  if (!store.active_team_id) return null;
  const team = store.teams[store.active_team_id];
  return team && typeof team === 'object' ? team : null;
}

function isSafePlainString(value, maxLen) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !CONTROL_CHARS.test(value);
}

function isSafeDashboardUrl(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string' || value.length > 512 || CONTROL_CHARS.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

function sanitizeDashboardUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_DASHBOARD_URL;
  if (!isSafeDashboardUrl(trimmed)) return null;
  return trimmed.replace(/\/$/, '');
}

function readJoinPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const result = {};
  for (const key of JOIN_FIELDS) {
    if (typeof body[key] !== 'string' || !body[key].trim()) return null;
    const value = body[key].trim();
    if (key === 'team_name') {
      if (!isSafePlainString(value, 80)) return null;
    } else if (!SAFE_ID.test(value)) {
      return null;
    }
    result[key] = value;
  }
  const dashboardUrl = sanitizeDashboardUrl(typeof body.dashboard_url === 'string' ? body.dashboard_url.trim() : '');
  if (!dashboardUrl) return null;
  result.dashboard_url = dashboardUrl;
  return result;
}

function readInviteJoinPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const inviteCode = typeof body.invite_code === 'string' ? body.invite_code.trim() : '';
  const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
  if (!SAFE_INVITE.test(inviteCode) || !SAFE_ID.test(teamId)) return null;
  const teamName = typeof body.team_name === 'string' ? body.team_name.trim() : '';
  if (teamName && !isSafePlainString(teamName, 80)) return null;
  const dashboardUrl = sanitizeDashboardUrl(typeof body.dashboard_url === 'string' ? body.dashboard_url.trim() : '');
  if (!dashboardUrl) return null;
  return {
    invite_code: inviteCode,
    team_id: teamId,
    team_name: teamName,
    dashboard_url: dashboardUrl,
  };
}

function parseAndonJoinUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.length > 2048 || CONTROL_CHARS.test(urlString)) {
    return { error: 'Invalid join link' };
  }
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { error: 'Invalid join link' };
  }
  if (!ANDON_SCHEMES.has(url.protocol)) {
    return { error: 'Invalid join link' };
  }
  const host = (url.hostname || url.host || '').replace(/^\/+/, '');
  const path = (url.pathname || '').replace(/^\/+/, '');
  const action = host === 'join' || path === 'join' ? 'join' : host || path;
  if (action !== 'join') {
    return { error: 'Invalid join link' };
  }
  const invite = readInviteJoinPayload({
    invite_code: url.searchParams.get('invite_code') || '',
    team_id: url.searchParams.get('team_id') || '',
    team_name: url.searchParams.get('team_name') || '',
    dashboard_url: url.searchParams.get('dashboard_url') || '',
  });
  if (!invite) {
    return { error: 'Join link is missing a valid invite_code or team_id' };
  }
  return { invite };
}

function setJoinNotice(ok, message) {
  joinNotice = { ok: !!ok, message: String(message || '').slice(0, 80) };
  try {
    updateMenu();
  } catch {
    // Tray may not exist yet.
  }
}

function postLocalJoin(fields) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(fields));
    const req = http.request(
      {
        hostname: TEAM_CONFIG_HOST,
        port: TEAM_CONFIG_PORT,
        path: '/join',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            parsed = {};
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) {
            resolve(parsed);
          } else {
            reject(new Error((parsed && parsed.error) || `join failed (${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('join timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function handleOpenUrl(urlString) {
  const parsed = parseAndonJoinUrl(urlString);
  if (parsed.error) {
    console.error('Andon: ignored join URL:', parsed.error);
    setJoinNotice(false, parsed.error);
    return;
  }
  skipFirstLaunchDashboard = true;
  if (!teamConfigReady) {
    pendingJoinUrl = urlString;
    return;
  }
  postLocalJoin(parsed.invite)
    .then(() => {
      const label = parsed.invite.team_name ? `Joined ${parsed.invite.team_name}` : 'Joined team';
      setJoinNotice(true, label);
    })
    .catch((err) => {
      console.error('Andon: join from URL failed', err && err.message ? err.message : err);
      setJoinNotice(false, err && err.message ? err.message : 'Could not join team');
    });
}

function flushPendingJoinUrl() {
  if (!pendingJoinUrl) return;
  const url = pendingJoinUrl;
  pendingJoinUrl = null;
  handleOpenUrl(url);
}

function postJson(urlString, body, timeoutMs = 8000) {
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
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            parsed = {};
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error((parsed && parsed.error) || `request failed (${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function joinViaInvite(invite) {
  let memberName;
  try {
    const username = os.userInfo().username;
    if (isSafePlainString(username, 40)) memberName = username;
  } catch {
    memberName = undefined;
  }
  const joined = await postJson(`${invite.dashboard_url}/api/team/join`, {
    invite_code: invite.invite_code,
    name: memberName,
  });
  const teamId = typeof joined.team_id === 'string' ? joined.team_id.trim() : '';
  const memberId = typeof joined.member_id === 'string' ? joined.member_id.trim() : '';
  const authToken = typeof joined.auth_token === 'string' ? joined.auth_token.trim() : '';
  const teamName =
    (typeof joined.team_name === 'string' && joined.team_name.trim()) || invite.team_name;
  if (!SAFE_ID.test(teamId) || !SAFE_ID.test(memberId) || !SAFE_ID.test(authToken)) {
    throw new Error('dashboard returned invalid join credentials');
  }
  if (teamId !== invite.team_id) {
    throw new Error('team_id does not match this invite');
  }
  if (teamName && !isSafePlainString(teamName, 80)) {
    throw new Error('dashboard returned an invalid team name');
  }
  return {
    dashboard_url: invite.dashboard_url,
    team_id: teamId,
    member_id: memberId,
    auth_token: authToken,
    team_name: teamName || teamId,
  };
}

function setActiveTeam(teamId) {
  const store = loadTeamsStore();
  if (!store.teams[teamId]) return;
  store.active_team_id = teamId;
  saveTeamsStore(store);
  updateMenu();
  applyTrayColor(computeState().color);
  refresh();
  notifyDashboard(computeState().color);
}

function copyJoinLink() {
  try {
    const team = getActiveTeam();
    if (!team) return;
    const dashboardUrl = resolveDashboardUrl(team);
    if (!dashboardUrl) return;
    const payload = {
      dashboard_url: dashboardUrl,
      team_id: team.team_id,
      member_id: team.member_id,
      auth_token: team.auth_token,
      team_name: team.team_name,
    };
    const encoded = encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString('base64'));
    clipboard.writeText(`${dashboardUrl}/join?config=${encoded}`);
  } catch (err) {
    console.error('Andon: failed to copy join link', err && err.message ? err.message : err);
  }
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

// Fire-and-forget POST to the active team dashboard. Missing teams.json
// or a down server must never delay or break the tray icon.
function notifyDashboard(state) {
  try {
    const team = getActiveTeam();
    if (!team) {
      console.log('Andon: no active team in ~/.andon/teams.json, skipping dashboard notify');
      return;
    }

    const dashboardUrl = resolveDashboardUrl(team);
    const teamId = typeof team.team_id === 'string' ? team.team_id.trim() : '';
    const memberId = typeof team.member_id === 'string' ? team.member_id.trim() : '';
    const authToken = typeof team.auth_token === 'string' ? team.auth_token.trim() : '';

    if (!dashboardUrl || !teamId || !memberId || !authToken) {
      console.log('Andon: active team config is incomplete, skipping dashboard notify');
      return;
    }

    const mapped = dashboardState(state);
    if (!mapped) {
      console.log(`Andon: skipping dashboard notify for invalid state "${state}"`);
      return;
    }

    const url = `${dashboardUrl.replace(/\/$/, '')}/api/state`;
    postDashboardState(url, {
      team_id: teamId,
      member_id: memberId,
      state: mapped,
      auth_token: authToken,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      console.error('Andon: dashboard notify failed', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('Andon: dashboard notify failed', err && err.message ? err.message : err);
  }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleTeamConfigRequest(req, res) {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid url' });
    return;
  }

  if (pathname !== '/join') {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  let parsed;
  try {
    const raw = await readRequestBody(req);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  const invite = readInviteJoinPayload(parsed);
  const fields = invite ? null : readJoinPayload(parsed);
  if (!invite && !fields) {
    sendJson(res, 400, { ok: false, error: 'missing fields' });
    return;
  }

  let teamRecord;
  try {
    teamRecord = invite ? await joinViaInvite(invite) : fields;
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err && err.message ? err.message : 'join failed' });
    return;
  }

  const store = loadTeamsStore();
  store.teams[teamRecord.team_id] = {
    dashboard_url: teamRecord.dashboard_url,
    team_id: teamRecord.team_id,
    member_id: teamRecord.member_id,
    auth_token: teamRecord.auth_token,
    team_name: teamRecord.team_name,
  };
  store.active_team_id = teamRecord.team_id;
  saveTeamsStore(store);

  try {
    const label = teamRecord.team_name ? `Joined ${teamRecord.team_name}` : 'Joined team';
    setJoinNotice(true, label);
    updateMenu();
    applyTrayColor(computeState().color);
    refresh();
    notifyDashboard(computeState().color);
  } catch (err) {
    console.error('Andon: failed to refresh after team join', err && err.message ? err.message : err);
  }

  sendJson(res, 200, { ok: true });
}

function startTeamConfigServer() {
  try {
    const server = http.createServer((req, res) => {
      handleTeamConfigRequest(req, res).catch((err) => {
        console.error('Andon: team config request failed', err && err.message ? err.message : err);
        try {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
          else res.end();
        } catch {
          // Never let a failed join request take down the tray.
        }
      });
    });
    server.on('error', (err) => {
      console.error('Andon: team config server failed', err && err.message ? err.message : err);
    });
    server.listen(TEAM_CONFIG_PORT, TEAM_CONFIG_HOST, () => {
      console.log(`Andon: team config server listening on ${TEAM_CONFIG_HOST}:${TEAM_CONFIG_PORT}`);
      teamConfigReady = true;
      flushPendingJoinUrl();
    });
  } catch (err) {
    console.error('Andon: could not start team config server', err && err.message ? err.message : err);
  }
}

function buildTeamsSubmenu() {
  const store = loadTeamsStore();
  const teamIds = Object.keys(store.teams);
  const noticeItem = joinNotice
    ? [{ label: joinNotice.message, enabled: false }, { type: 'separator' }]
    : [];
  if (teamIds.length === 0) {
    return [
      ...noticeItem,
      { label: 'Open dashboard', click: () => shell.openExternal(DEFAULT_DASHBOARD_URL) },
      { label: 'No teams yet', enabled: false },
    ];
  }

  return [
    ...noticeItem,
    ...teamIds.map((id) => {
      const team = store.teams[id] || {};
      const label = typeof team.team_name === 'string' && team.team_name ? team.team_name : id;
      return {
        label,
        type: 'radio',
        checked: id === store.active_team_id,
        click: () => setActiveTeam(id),
      };
    }),
    { type: 'separator' },
    { label: 'Open dashboard', click: () => shell.openExternal(DEFAULT_DASHBOARD_URL) },
    { label: 'Copy join link', click: copyJoinLink },
  ];
}

function buildMenu(projects) {
  const prefs = getPrefs();
  const items = [
    { label: 'All projects', type: 'radio', checked: isAllProjects(prefs.selected), click: () => setSelected(null) },
    ...projects.map((name) => ({
      label: name,
      type: 'radio',
      checked: prefs.selected === name,
      click: () => setSelected(name),
    })),
    { type: 'separator' },
    { label: 'Teams', submenu: buildTeamsSubmenu() },
    { label: 'Play sound on done', type: 'checkbox', checked: prefs.soundEnabled !== false, click: toggleSound },
    {
      label: 'Ready sound',
      submenu: READY_SOUNDS.map((sound) => ({
        label: sound.label,
        type: 'radio',
        checked: prefs.readySound === sound.id,
        click: () => setReadySound(sound.id),
      })),
    },
    { label: 'Reset All (clear stuck state)', click: resetAll },
    {
      label: isCheckingForUpdates ? 'Checking for Updates...' : 'Check for Updates...',
      enabled: !isCheckingForUpdates,
      click: () => runUpdateCheck(false),
    },
    { label: 'Quit Andon', click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(items);
}

function playDoneSound() {
  const prefs = getPrefs();
  const file = path.join(__dirname, 'assets', `${prefs.readySound}.wav`);
  execFile('afplay', [file], () => {});
}

const GREEN_TOP = [90, 200, 100];
const GREEN_BOTTOM = [45, 150, 60];
const ICON_SIZE = 50;
const PULSE_FRAMES = 20;
const PULSE_COUNT = 3;
const FRAME_INTERVAL_MS = 20;

const ICON_COLORS = {
  red: { top: [255, 90, 80], bottom: [200, 35, 30] },
  yellow: { top: [255, 210, 70], bottom: [220, 150, 20] },
  green: { top: GREEN_TOP, bottom: GREEN_BOTTOM },
  off: { top: [210, 210, 215], bottom: [150, 150, 155] },
};

function makeCircleImage(top, bottom, alpha) {
  const png = renderCirclePNG(ICON_SIZE, top, bottom, alpha);
  const img = nativeImage.createFromBuffer(png, { width: ICON_SIZE, height: ICON_SIZE, scaleFactor: 2 });
  img.setTemplateImage(false);
  return img;
}

const stateImages = {};
for (const [name, colors] of Object.entries(ICON_COLORS)) {
  stateImages[name] = makeCircleImage(colors.top, colors.bottom, 1);
}

const pulseFrames = [];
for (let p = 0; p < PULSE_COUNT; p++) {
  for (let f = 0; f < PULSE_FRAMES; f++) {
    const t = f / (PULSE_FRAMES - 1);
    const alpha = Math.sin(Math.PI * t);
    pulseFrames.push(makeCircleImage(GREEN_TOP, GREEN_BOTTOM, Math.max(0.05, alpha)));
  }
}

function applyTrayColor(color) {
  if (!tray) return;
  const key = stateImages[color] ? color : 'off';
  // Colored PNGs actually change in the menu bar; same-length emoji titles often don't.
  tray.setTitle('');
  tray.setImage(stateImages[key]);
  const team = getActiveTeam();
  const teamName = team && typeof team.team_name === 'string' && team.team_name ? team.team_name : null;
  tray.setToolTip(teamName ? `Andon ${EMOJI[key]} · ${teamName}` : `Andon ${EMOJI[key]}`);
}

function pulseDone() {
  isAnimating = true;
  tray.setTitle('');
  let i = 0;
  const anim = setInterval(() => {
    tray.setImage(pulseFrames[i]);
    i += 1;
    if (i >= pulseFrames.length) {
      clearInterval(anim);
      isAnimating = false;
      applyTrayColor(computeState().color);
    }
  }, FRAME_INTERVAL_MS);
}

function refresh() {
  const { color } = computeState();
  const prefs = getPrefs();

  if (!isAnimating) {
    if (color === 'green' && lastColor !== null && lastColor !== 'green') {
      if (prefs.soundEnabled !== false) playDoneSound();
      pulseDone();
    } else if (color !== lastColor) {
      applyTrayColor(color);
    }
  }

  if (color !== lastColor) {
    notifyDashboard(color);
  }

  lastColor = color;
}

function updateMenu() {
  if (!tray) return;
  const { projects } = computeState();
  tray.setContextMenu(buildMenu(projects));
}

function runSetup() {
  try {
    installAllHooks();
  } catch (err) {
    console.error('Hook setup failed:', err);
  }

  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const bundledScript = fs.readFileSync(path.join(__dirname, 'update-status.js'), 'utf8');
  fs.writeFileSync(path.join(STATE_DIR, 'update-status.js'), bundledScript);
  fs.copyFileSync(path.join(__dirname, 'merge-hooks.js'), path.join(STATE_DIR, 'merge-hooks.js'));

  const firstLaunch = ensureTeamsConfig();
  return { firstLaunch };
}

const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4;

function handleUpdateResult(result) {
  if (result.updated) {
    setTimeout(() => app.quit(), 500);
  }
}

async function runUpdateCheck(silent) {
  isCheckingForUpdates = true;
  try {
    const result = await checkForUpdates({ silent });
    handleUpdateResult(result);
  } finally {
    isCheckingForUpdates = false;
  }
}

app.whenReady().then(() => {
  const { firstLaunch } = runSetup();
  startTeamConfigServer();

  if (firstLaunch && !skipFirstLaunchDashboard && !pendingJoinUrl) {
    shell.openExternal(DEFAULT_DASHBOARD_URL).catch((err) => {
      console.error('Andon: could not open dashboard', err && err.message ? err.message : err);
    });
  }

  tray = new Tray(stateImages.off);
  tray.setTitle('');
  tray.setToolTip('Andon');
  applyTrayColor('off');

  tray.on('click', updateMenu);
  tray.on('right-click', updateMenu);
  updateMenu();

  refresh();
  setInterval(refresh, 1000);

  runUpdateCheck(true);
  setInterval(() => {
    runUpdateCheck(true);
  }, UPDATE_CHECK_INTERVAL_MS);
});

function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('andon', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('andon');
  }
}

function ingestLaunchInvites() {
  const envUrl = process.env.ANDON_JOIN_URL;
  if (typeof envUrl === 'string' && envUrl) {
    handleOpenUrl(envUrl);
  } else if (process.env.ANDON_INVITE_CODE && process.env.ANDON_TEAM_ID) {
    const params = new URLSearchParams();
    params.set('invite_code', process.env.ANDON_INVITE_CODE);
    params.set('team_id', process.env.ANDON_TEAM_ID);
    if (process.env.ANDON_TEAM_NAME) params.set('team_name', process.env.ANDON_TEAM_NAME);
    if (process.env.ANDON_DASHBOARD_URL) params.set('dashboard_url', process.env.ANDON_DASHBOARD_URL);
    handleOpenUrl(`andon://join?${params.toString()}`);
  }
  for (const arg of process.argv) {
    if (typeof arg === 'string' && (arg.startsWith('andon:') || arg.startsWith('anon:'))) {
      handleOpenUrl(arg);
    }
  }
}

registerProtocolClient();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  ingestLaunchInvites();
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => typeof arg === 'string' && (arg.startsWith('andon:') || arg.startsWith('anon:')));
    if (url) handleOpenUrl(url);
  });
}

app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleOpenUrl(url);
  });
});

app.dock && app.dock.hide();