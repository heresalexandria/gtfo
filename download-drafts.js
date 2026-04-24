#!/usr/bin/env node
/**
 * download-drafts.js
 *
 * Interactive Sora draft video downloader with:
 *   - Adjustable rate limiting (keyboard shortcuts)
 *   - Pause / resume
 *   - Progress bar + live stats
 *   - Failed download detection (HTTP errors + suspiciously small files)
 *   - Log file for tracking
 *
 * Usage:
 *   node download-drafts.js --username <your-sora-username>
 *   node download-drafts.js --username <user> --urls /path/to/drafts.txt
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/* ── CLI args ───────────────────────────────────────────────────── */
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const USERNAME = argVal('--username', null);
if (!USERNAME) {
  console.error('Missing --username. Usage: node download-drafts.js --username <your-sora-username> [--urls <path>]');
  process.exit(1);
}

/* ── Configuration ──────────────────────────────────────────────── */
const ARCHIVE_ROOT = argVal('--out', path.join(__dirname, 'archive'));
const USER_DIR     = path.join(ARCHIVE_ROOT, USERNAME);
const DRAFTS_DIR   = process.env.DEST_DIR || path.join(USER_DIR, 'drafts');
const URLS_FILE    = argVal('--urls', null) || process.env.URLS_FILE || path.join(USER_DIR, 'drafts.txt');
const LOGS_DIR     = process.env.LOGS_DIR || path.join(USER_DIR, 'logs');
const LOG_FILE     = path.join(LOGS_DIR, 'drafts-download.log');
const MIN_FILE_KB = 50;      // files under 50 KB are suspicious
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;    // ms before retry
const RATE_STEP   = 1;       // seconds to add/remove per keypress

/* ── State ──────────────────────────────────────────────────────── */
let delaySeconds  = 4;        // 15/min = 4s between downloads
let paused        = false;
let stopping      = false;
let downloaded    = 0;
let skipped       = 0;
let failed        = 0;
let totalEntries  = 0;
let currentId     = '';
let currentStatus = 'starting';
let startTime     = Date.now();
let downloadedIds = new Set();

/* ── Logging ────────────────────────────────────────────────────── */
function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

/* ── URL list parsing ───────────────────────────────────────────── */
function loadUrls() {
  if (!fs.existsSync(URLS_FILE)) {
    console.error(`URL file not found: ${URLS_FILE}`);
    process.exit(1);
  }
  return fs.readFileSync(URLS_FILE, 'utf-8')
    .split('\n')
    .filter(line => line.includes('|'))
    .map(line => {
      const sep = line.indexOf('|');
      return { id: line.slice(0, sep), url: line.slice(sep + 1) };
    });
}

function loadDownloadedIds() {
  // Only trust the filesystem. Log entries are not gated on DRAFTS_DIR, so trusting
  // them caused every run after a scripts/dest move to skip already-logged IDs
  // even though the mp4s lived in the old folder.
  const ids = new Set();
  if (fs.existsSync(DRAFTS_DIR)) {
    for (const id of fs.readdirSync(DRAFTS_DIR)) {
      const video = path.join(DRAFTS_DIR, id, 'video.mp4');
      if (!fs.existsSync(video)) continue;
      if (fs.statSync(video).size > MIN_FILE_KB * 1024) ids.add(id);
    }
  }
  return ids;
}

function alreadyDownloaded(id) {
  return downloadedIds.has(id);
}

/* ── Download a single file ─────────────────────────────────────── */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 120000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadWithRetries(id, url) {
  const destDir = path.join(DRAFTS_DIR, id);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'video.mp4');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFile(url, dest);

      // Check file size
      const stat = fs.statSync(dest);
      const sizeKB = Math.round(stat.size / 1024);

      if (sizeKB < MIN_FILE_KB) {
        fs.unlinkSync(dest);
        throw new Error(`suspicious size: ${sizeKB} KB`);
      }

      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      log(`OK ${id} (${sizeMB} MB)`);
      return { ok: true, size: sizeMB };
    } catch (err) {
      log(`FAIL ${id} attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY);
      }
    }
  }

  log(`FAILED ${id} after ${MAX_RETRIES} attempts`);
  return { ok: false };
}

/* ── Progress display ───────────────────────────────────────────── */
function renderUI() {
  const processed = downloaded + skipped + failed;
  const pct = totalEntries > 0 ? Math.round((processed / totalEntries) * 100) : 0;
  const rate = Math.round(60 / delaySeconds);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const elapsedStr = formatDuration(elapsed);
  const remaining = downloaded > 0
    ? Math.round(((totalEntries - processed) * elapsed) / downloaded)
    : 0;
  const etaStr = remaining > 0 ? formatDuration(remaining) : '--:--';

  // Progress bar
  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  const pauseIndicator = paused ? ' ⏸  PAUSED' : '';

  const lines = [
    '',
    `  Sora Drafts Downloader${pauseIndicator}`,
    `  ${bar} ${pct}%  (${processed}/${totalEntries})`,
    '',
    `  Downloaded: ${downloaded}    Skipped: ${skipped}    Failed: ${failed}`,
    `  Rate: ${rate}/min (${delaySeconds}s delay)    Elapsed: ${elapsedStr}    ETA: ${etaStr}`,
    `  Current: ${currentStatus}`,
    '',
    `  Controls:`,
    `    ↑ / +   Faster (decrease delay by ${RATE_STEP}s)`,
    `    ↓ / -   Slower (increase delay by ${RATE_STEP}s)`,
    `    space    ${paused ? 'Resume' : 'Pause'}`,
    `    q        Quit gracefully`,
    '',
  ];

  // Clear screen and redraw
  process.stdout.write('\x1B[2J\x1B[H');
  process.stdout.write(lines.join('\n'));
}

function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/* ── Keyboard input ─────────────────────────────────────────────── */
function setupKeyboard() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    // Ctrl+C
    if (key === '\u0003') {
      stopping = true;
      paused = false;   // unpause so the loop can exit
      return;
    }

    switch (key) {
      case '\u001B[A':  // up arrow
      case '+':
      case '=':
        delaySeconds = Math.max(1, delaySeconds - RATE_STEP);
        renderUI();
        break;

      case '\u001B[B':  // down arrow
      case '-':
      case '_':
        delaySeconds = delaySeconds + RATE_STEP;
        renderUI();
        break;

      case ' ':
        paused = !paused;
        if (paused) log('Paused by user');
        else log('Resumed by user');
        renderUI();
        break;

      case 'q':
      case 'Q':
        stopping = true;
        paused = false;
        break;
    }
  });
}

/* ── Sleep (interruptible by unpause/stop) ──────────────────────── */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitWhilePaused() {
  while (paused && !stopping) {
    await sleep(200);
  }
}

async function rateDelay() {
  // Sleep in small chunks so rate changes and pause take effect quickly
  const target = delaySeconds * 1000;
  const chunk = 200;
  let waited = 0;
  while (waited < target && !stopping) {
    await waitWhilePaused();
    if (stopping) break;
    await sleep(Math.min(chunk, target - waited));
    waited += chunk;
  }
}

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  downloadedIds = loadDownloadedIds();
  const entries = loadUrls();
  totalEntries = entries.length;

  log(`--- Session started: ${totalEntries} entries in ${URLS_FILE} ---`);
  if (downloadedIds.size > 0) log(`Skipping ${downloadedIds.size} previously downloaded drafts`);
  log(`Destination: ${DRAFTS_DIR}`);
  log(`Initial rate: ${Math.round(60 / delaySeconds)}/min (${delaySeconds}s delay)`);

  setupKeyboard();
  renderUI();

  for (const { id, url } of entries) {
    if (stopping) break;
    await waitWhilePaused();
    if (stopping) break;

    currentId = id;

    // Skip already downloaded
    if (alreadyDownloaded(id)) {
      skipped++;
      currentStatus = `skipped ${id} (exists)`;
      renderUI();
      continue;
    }

    // Download
    currentStatus = `downloading ${id}...`;
    renderUI();

    const result = await downloadWithRetries(id, url);

    if (result.ok) {
      downloaded++;
      currentStatus = `${id} OK (${result.size} MB)`;
    } else {
      failed++;
      currentStatus = `${id} FAILED`;
    }

    renderUI();

    // Rate-limited delay before next download
    if (!stopping) await rateDelay();
  }

  // Cleanup
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const finalMsg = stopping
    ? `Stopped by user. Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`
    : `Complete! Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`;

  log(finalMsg);
  console.clear();
  console.log(`\n  ${finalMsg}`);
  console.log(`  Log: ${LOG_FILE}\n`);

  process.exit(0);
})();
