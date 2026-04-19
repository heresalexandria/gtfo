#!/usr/bin/env node
/**
 * backfill-cast.js
 *
 * Refreshes the `post` object (including `cameo_profiles` — the structured
 * cast list) for captured posts, using the authenticated `/post/{id}`
 * endpoint. Preserves existing comments and profile data. Useful when:
 *
 *   - Old captures predate cameo_profiles support
 *   - Cast members renamed / changed avatars / changed owner
 *   - You want to sanity-check a specific post's cast
 *
 * Rate-limited with Retry-After aware exponential backoff and auto-pause on
 * repeated 429/5xx, same pattern as capture-profile.js Phase 2.
 *
 * Usage:
 *   1. Quit Chrome completely.
 *   2. node backfill-cast.js [options]
 *   3. Log in when the Chrome window opens (auto-detected).
 *
 * Options:
 *   --username <name>     Which profile dir under archive/ to target (required)
 *   --missing             Only refresh posts where `cameo_profiles` is missing
 *                         from the stored post object (fast if everything's caught)
 *   --ids <a,b,c>         Only refresh these specific post IDs (comma-separated)
 *   --delay <ms>          Baseline delay between API calls (default 3000)
 *   (default is to refresh EVERY captured post)
 *
 * Controls:
 *   space   Pause / Resume
 *   q       Quit gracefully
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ── CLI args ───────────────────────────────────────────────────── */
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const USERNAME = argVal('--username', null);
const MISSING  = args.includes('--missing');
const IDS      = argVal('--ids', null);
const API_DELAY_MS = parseInt(argVal('--delay', '3000'), 10);
const ROOT     = argVal('--out', path.join(__dirname, 'archive'));

if (!USERNAME) {
  console.error('Missing --username. Usage: node backfill-cast.js --username <your-sora-username> [--missing | --ids a,b,c]');
  process.exit(1);
}

const OUT_DIR        = path.join(ROOT, USERNAME);
const POSTS_META_DIR = path.join(OUT_DIR, '_posts');
const LOGS_DIR       = path.join(OUT_DIR, 'logs');
const LOG_FILE       = path.join(LOGS_DIR, 'backfill-cast.log');

/* ── Backoff config (mirrors capture-profile.js Phase 2) ────────── */
const BACKOFF_INITIAL_MS     = 10_000;
const BACKOFF_MULT           = 3;
const BACKOFF_MAX_MS         = 300_000;
const CONSECUTIVE_FAIL_PAUSE = 5;

/* ── State ──────────────────────────────────────────────────────── */
let paused        = false;
let stopping      = false;
let currentStatus = 'starting';
let refreshed     = 0;
let skipped       = 0;
let failed        = 0;
let consecutiveFails = 0;
let totalTargets  = 0;
const startTime   = Date.now();

/* ── Helpers ────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function readPost(id) {
  return JSON.parse(fs.readFileSync(path.join(POSTS_META_DIR, `${id}.json`), 'utf-8'));
}

function writePost(id, payload) {
  const dest = path.join(POSTS_META_DIR, `${id}.json`);
  const tmp  = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, dest);
}

/* ── Progress UI ────────────────────────────────────────────────── */
function renderUI() {
  const processed = refreshed + skipped + failed;
  const pct = totalTargets > 0 ? Math.round((processed / totalTargets) * 100) : 0;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const pauseIndicator = paused ? ' ⏸  PAUSED' : '';
  const lines = [
    '',
    `  Sora Cast Backfill — @${USERNAME}${pauseIndicator}`,
    `  ${processed}/${totalTargets} (${pct}%)   Elapsed: ${formatDuration(elapsed)}`,
    '',
    `  Refreshed: ${refreshed}   Skipped: ${skipped}   Failed: ${failed}   Consecutive backoffs: ${consecutiveFails}`,
    `  Status: ${currentStatus}`,
    '',
    `  Controls:  space = pause/resume   q = quit`,
    '',
  ];
  process.stdout.write('\x1B[2J\x1B[H');
  process.stdout.write(lines.join('\n'));
}

/* ── Keyboard ───────────────────────────────────────────────────── */
function setupKeyboard() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === '\u0003') { stopping = true; paused = false; return; }
    if (key === ' ') {
      paused = !paused;
      log(paused ? 'Paused' : 'Resumed');
      renderUI();
    } else if (key === 'q' || key === 'Q') {
      stopping = true; paused = false;
    }
  });
}

async function waitWhilePaused() { while (paused && !stopping) await sleep(200); }
async function pausedSleep(ms) {
  const chunk = 200;
  let waited = 0;
  while (waited < ms && !stopping) {
    await waitWhilePaused();
    if (stopping) break;
    const step = Math.min(chunk, ms - waited);
    await sleep(step);
    waited += step;
  }
}

/* ── Authenticated fetch with backoff ───────────────────────────── */
async function authFetch(page, url) {
  return page.evaluate(async (u) => {
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const r = await fetch(u, {
      credentials: 'include',
      headers: { Authorization: 'Bearer ' + s.accessToken },
    });
    const retryAfter = r.headers.get('Retry-After');
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { _error: true, status: r.status, retryAfter, body: body.slice(0, 200) };
    }
    return { _ok: true, json: await r.json() };
  }, url);
}

async function authFetchBackoff(page, url, label) {
  let delay = BACKOFF_INITIAL_MS;
  for (let attempt = 1; ; attempt++) {
    await waitWhilePaused();
    if (stopping) throw new Error('stopped');

    const res = await authFetch(page, url).catch(e => ({ _error: true, status: 0, body: e.message }));
    if (res._ok) { consecutiveFails = 0; return res.json; }

    const is429 = res.status === 429;
    const is5xx = res.status >= 500;
    const retryable = is429 || is5xx || res.status === 0;
    if (!retryable) throw new Error(`HTTP ${res.status} for ${label}: ${res.body || ''}`);

    const retryAfterSec = Number(res.retryAfter);
    const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(BACKOFF_MAX_MS, delay);

    consecutiveFails = Math.max(consecutiveFails, attempt);
    log(`BACKOFF ${label} attempt ${attempt} status=${res.status} wait=${wait}ms`);
    currentStatus = `backoff ${label}: HTTP ${res.status}, waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`;
    renderUI();

    if (attempt >= CONSECUTIVE_FAIL_PAUSE && !paused) {
      paused = true;
      log('Auto-paused after repeated 429/5xx');
      currentStatus = `AUTO-PAUSED after ${attempt} failures — press space to resume, q to quit`;
      renderUI();
    }

    await pausedSleep(wait);
    if (stopping) throw new Error('stopped');
    delay = Math.min(BACKOFF_MAX_MS, delay * BACKOFF_MULT);
  }
}

/* ── Pick posts to refresh ──────────────────────────────────────── */
function selectTargets() {
  const allFiles = fs.readdirSync(POSTS_META_DIR).filter(f => f.endsWith('.json'));
  const allIds = allFiles.map(f => f.replace(/\.json$/, ''));

  if (IDS) {
    const wanted = new Set(IDS.split(',').map(s => s.trim()).filter(Boolean));
    return allIds.filter(id => wanted.has(id));
  }

  if (MISSING) {
    return allIds.filter(id => {
      try {
        const j = readPost(id);
        return !Array.isArray(j.post?.cameo_profiles);
      } catch { return true; }
    });
  }

  return allIds;
}

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  if (!fs.existsSync(POSTS_META_DIR)) {
    console.error(`No captures found at ${POSTS_META_DIR}.`);
    console.error(`Run capture-profile.js --username ${USERNAME} first.`);
    process.exit(1);
  }
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const targets = selectTargets();
  totalTargets = targets.length;
  log(`--- Session start. targets=${targets.length} mode=${IDS ? 'ids' : MISSING ? 'missing' : 'all'} ---`);
  if (targets.length === 0) {
    console.log('\n  Nothing to refresh.\n');
    process.exit(0);
  }

  console.log(`Refreshing cast metadata for ${targets.length} posts.`);
  console.log('Launching Chrome (make sure Chrome is quit)...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto('https://sora.chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Auto-detect login
  console.log('Waiting for login...');
  const loggedIn = async () => {
    try {
      const s = await page.evaluate(async () => {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        return r.json();
      });
      return !!(s && s.accessToken && s.user);
    } catch { return false; }
  };
  const enterPromise = process.stdin.isTTY
    ? ask('(or press Enter once logged in) ').then(() => 'enter')
    : new Promise(() => {});
  const pollPromise = (async () => {
    while (true) { if (await loggedIn()) return 'auto'; await sleep(3000); }
  })();
  await Promise.race([enterPromise, pollPromise]);

  setupKeyboard();
  renderUI();

  for (let i = 0; i < targets.length; i++) {
    if (stopping) break;
    await waitWhilePaused();
    if (stopping) break;

    const id = targets[i];
    currentStatus = `refreshing ${i + 1}/${targets.length}: ${id}`;
    renderUI();

    try {
      const fresh = await authFetchBackoff(page, `/backend/project_y/post/${id}`, `post ${id}`);
      if (!fresh || !fresh.post) throw new Error('no post in response');

      const existing = readPost(id);
      // Preserve comments + existing profile; refresh post + posting-user profile
      const merged = {
        post: fresh.post,
        profile: fresh.profile || existing.profile,
        comments: existing.comments,
      };
      writePost(id, merged);
      refreshed++;
      const cast = (fresh.post.cameo_profiles || [])
        .filter(p => p.username !== USERNAME)
        .map(p => '@' + p.username);
      log(`OK ${id} (cast: ${cast.length ? cast.join(', ') : 'none'})`);
      currentStatus = `${id} refreshed (${cast.length} cast)`;
    } catch (e) {
      if (String(e.message).includes('stopped')) break;
      failed++;
      log(`FAIL ${id}: ${e.message}`);
      currentStatus = `FAIL ${id}: ${e.message}`;
    }

    renderUI();
    await pausedSleep(API_DELAY_MS);
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await browser.close();

  const msg = stopping
    ? `Stopped. Refreshed: ${refreshed}, Failed: ${failed}`
    : `Complete! Refreshed: ${refreshed}, Failed: ${failed}`;
  log(msg);
  console.clear();
  console.log(`\n  ${msg}`);
  console.log(`  Log: ${LOG_FILE}`);
  console.log(`\n  Next: node build-archive.js --rebuild\n`);
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
