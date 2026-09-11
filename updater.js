const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'augusterixon/andon';
const CURRENT_VERSION = require('./package.json').version;

function isNewerVersion(latest, current) {
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [lMajor, lMinor, lPatch] = parse(latest);
  const [cMajor, cMinor, cPatch] = parse(current);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

function findAssetUrl(releaseJson, arch) {
  const pattern = arch === 'arm64' ? 'arm64-mac.zip' : 'x64-mac.zip';
  const asset = (releaseJson.assets || []).find((a) => a.browser_download_url.endsWith(pattern));
  return asset ? asset.browser_download_url : null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Andon-updater' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

// GitHub release asset URLs 302-redirect to S3 — Node's http/https modules
// don't follow redirects automatically (unlike curl), so this is handled
// explicitly. Verified against a local test server before ever pointing
// this at the real GitHub API.
function downloadFollowingRedirects(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl, redirectsLeft) {
      const lib = currentUrl.startsWith('https') ? https : http;
      lib
        .get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            res.resume();
            attempt(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Unexpected status ${res.statusCode}`));
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', reject);
        })
        .on('error', reject);
    }
    attempt(url, maxRedirects);
  });
}

function notify(title, message) {
  execFile('terminal-notifier', ['-title', title, '-message', message, '-group', 'andon-update'], (err) => {
    if (err) {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
      execFile('osascript', ['-e', script], () => {});
    }
  });
}

/**
 * Checks for a newer release. If found, downloads it, swaps
 * /Applications/Andon.app, and relaunches. This deliberately does NOT use
 * macOS's built-in Squirrel-based auto-updater (what electron-updater wraps
 * on Mac) — that mechanism requires a paid Apple Developer ID certificate to
 * verify updates come from the same source, which this project doesn't
 * have. Instead this re-does exactly what curl-install.sh already does
 * manually (download the right zip, replace the app, relaunch), just
 * triggered automatically instead of by hand.
 */
async function checkForUpdates({ silent = true } = {}) {
  try {
    const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latestVersion = release.tag_name.replace(/^v/, '');

    if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
      if (!silent) notify('Andon', `You're up to date (v${CURRENT_VERSION}).`);
      return { updated: false, reason: 'up-to-date' };
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const assetUrl = findAssetUrl(release, arch);
    if (!assetUrl) {
      console.error(`Update ${latestVersion} found but no asset matches this Mac's architecture (${arch}).`);
      return { updated: false, reason: 'no-matching-asset' };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andon-update-'));
    const zipPath = path.join(tmpDir, 'andon.zip');

    await downloadFollowingRedirects(assetUrl, zipPath);

    await new Promise((resolve, reject) => {
      execFile('unzip', ['-q', zipPath, '-d', tmpDir], (err) => (err ? reject(err) : resolve()));
    });

    const newAppPath = path.join(tmpDir, 'Andon.app');
    if (!fs.existsSync(newAppPath)) {
      throw new Error('Downloaded update did not contain Andon.app as expected');
    }

    notify('Andon', `Updating to v${latestVersion}...`);

    // Swap + relaunch happens in a detached shell script, not inline here —
    // we're about to quit this process, and can't reliably delete/replace
    // our own running app bundle and then relaunch it from within itself.
    // A short sleep gives this process time to fully exit first.
    const swapScript = `
    sleep 1
    rm -rf "/Applications/Andon.app.old"
    if [ -d "/Applications/Andon.app" ]; then
      mv "/Applications/Andon.app" "/Applications/Andon.app.old"
    fi
    mv "${newAppPath}" "/Applications/Andon.app"
    rm -rf "/Applications/Andon.app.old"
    open "/Applications/Andon.app"
  `;
    const child = spawn('bash', ['-c', swapScript], { detached: true, stdio: 'ignore' });
    child.unref();

    return { updated: true, version: latestVersion };
  } catch (err) {
    console.error('Update check failed:', err.message);
    if (!silent) notify('Andon update check failed', err.message);
    return { updated: false, reason: 'error', error: err.message };
  }
}

module.exports = { checkForUpdates, isNewerVersion, findAssetUrl };