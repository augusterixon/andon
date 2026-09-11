const { app, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { renderCirclePNG } = require('./pulse-icon');
const { installAllHooks } = require('./merge-hooks');
const { checkForUpdates } = require('./updater');

const STATE_DIR = path.join(os.homedir(), '.andon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PREFS_FILE = path.join(STATE_DIR, 'widget-prefs.json');

const EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', off: '⚪' };
const PRIORITY = { red: 3, yellow: 2, green: 1 };
const STALE_MS = 1000 * 60 * 10;

let tray = null;
let lastColor = null;
let isAnimating = false;
let isCheckingForUpdates = false;

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

function getPrefs() {
  return loadJson(PREFS_FILE, { selected: 'All', soundEnabled: true });
}

function toggleSound() {
  const prefs = getPrefs();
  saveJson(PREFS_FILE, { ...prefs, soundEnabled: !prefs.soundEnabled });
  updateMenu();
}

function setSelected(name) {
  const prefs = getPrefs();
  saveJson(PREFS_FILE, { ...prefs, selected: name });
  updateMenu();
  refresh();
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

  if (prefs.selected !== 'All') {
    const match = entries.find(([cwd]) => path.basename(cwd) === prefs.selected);
    return { color: match ? match[1].state : 'off', projects: projectNames };
  }

  let best = 'green';
  for (const [, v] of entries) {
    if ((PRIORITY[v.state] || 0) > (PRIORITY[best] || 0)) best = v.state;
  }
  return { color: best, projects: projectNames };
}

function resetAll() {
  saveJson(STATE_FILE, { projects: {} });
  updateMenu();
  refresh();
}

function buildMenu(projects) {
  const prefs = getPrefs();
  const items = [
    { label: 'All projects', type: 'radio', checked: prefs.selected === 'All', click: () => setSelected('All') },
    { type: 'separator' },
    ...projects.map((name) => ({
      label: name,
      type: 'radio',
      checked: prefs.selected === name,
      click: () => setSelected(name),
    })),
    { type: 'separator' },
    { label: 'Play sound on done', type: 'checkbox', checked: prefs.soundEnabled !== false, click: toggleSound },
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
  execFile('afplay', [path.join(__dirname, 'assets', 'pluck.wav')], () => {});
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
  const key = stateImages[color] ? color : 'off';
  // Colored PNGs actually change in the menu bar; same-length emoji titles often don't.
  tray.setTitle('');
  tray.setImage(stateImages[key]);
  tray.setToolTip(`Andon ${EMOJI[key]}`);
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

  lastColor = color;
}

function updateMenu() {
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
  runSetup();

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

app.dock && app.dock.hide();