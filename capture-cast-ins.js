#!/usr/bin/env node
/**
 * capture-cast-ins.js
 *
 * Captures the "Cast in" tab on a Sora profile — posts authored by OTHER
 * users where the target user was cast. Same two-phase design as
 * capture-profile.js:
 *
 *   Phase 1 (discovery): opens the profile page, clicks the "Cast in" tab,
 *                        and scrolls. Intercepts the feed responses and
 *                        saves each post's metadata to disk. Rides the
 *                        app's natural request rate.
 *   Phase 2 (comments):  fetches each post's comment tree via API with
 *                        Retry-After aware exponential backoff. Auto-pauses
 *                        after repeated 429/5xx.
 *
 * Output:
 *   archive/<user>/_cast_ins/<postId>.json   { post, profile, comments }
 *
 * Re-runnable: already-captured cast-in posts are skipped. Pass --refresh
 * to ignore existing and refetch everything.
 *
 * Usage:
 *   1. Quit Chrome completely.
 *   2. node capture-cast-ins.js --username <your-sora-username> [--refresh] [--comments-only]
 *   3. Log in when Chrome opens.
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
const USERNAME       = argVal('--username', null);
const REFRESH        = args.includes('--refresh');
const COMMENTS_ONLY  = args.includes('--comments-only');
const ROOT           = argVal('--out', path.join(__dirname, 'archive'));

if (!USERNAME) {
  console.error('Missing --username. Usage: node capture-cast-ins.js --username <your-sora-username> [--refresh] [--comments-only]');
  process.exit(1);
}

const OUT_DIR        = path.join(ROOT, USERNAME);
const CAST_META_DIR  = path.join(OUT_DIR, '_cast_ins');
const LOGS_DIR       = path.join(OUT_DIR, 'logs');
const LOG_FILE       = path.join(LOGS_DIR, 'capture-cast-ins.log');

/* ── Scroll config (mirrors capture-profile.js) ─────────────────── */
const SCROLL_PX       = 300;
const SCROLL_DELAY_MS = 5000;
const STALE_TIMEOUT_S = 300;
const MAX_STALE       = Math.ceil(STALE_TIMEOUT_S / (SCROLL_DELAY_MS / 1000));

/* ── Comment fetch pacing + backoff ─────────────────────────────── */
const COMMENT_DELAY_MS       = 3000;
const BACKOFF_INITIAL_MS     = 10_000;
const BACKOFF_MULT           = 3;
const BACKOFF_MAX_MS         = 300_000;
const CONSECUTIVE_FAIL_PAUSE = 5;

/* ── State ──────────────────────────────────────────────────────── */
let paused       = false;
let stopping     = false;
let phase        = 'starting';
let currentStatus = '';
const startTime  = Date.now();
let capturedNewInRun = 0;
let postsSeen = 0;
let commentsOK = 0;
let commentsFailed = 0;
let consecutiveFails = 0;

/* ── Helpers ────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); }

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

function existingStatus() {
  const map = new Map();
  if (!fs.existsSync(CAST_META_DIR)) return map;
  for (const f of fs.readdirSync(CAST_META_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CAST_META_DIR, f), 'utf-8'));
      map.set(id, j.comments?._pending ? 'pending' : 'complete');
    } catch { /* corrupt file, treat as missing */ }
  }
  return map;
}

function writePost(id, payload) {
  const dest = path.join(CAST_META_DIR, `${id}.json`);
  const tmp  = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, dest);
}

function readPost(id) {
  return JSON.parse(fs.readFileSync(path.join(CAST_META_DIR, `${id}.json`), 'utf-8'));
}

/* ── UI ─────────────────────────────────────────────────────────── */
function renderUI() {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const pauseIndicator = paused ? ' ⏸  PAUSED' : '';
  const lines = [
    '',
    `  Sora Cast-in Capture — @${USERNAME}${pauseIndicator}`,
    '',
    `  Phase: ${phase}`,
    `  Posts seen: ${postsSeen}   New this run: ${capturedNewInRun}`,
    `  Comments OK: ${commentsOK}   Failed: ${commentsFailed}   Consecutive backoffs: ${consecutiveFails}`,
    `  Elapsed: ${formatDuration(elapsed)}`,
    `  Status: ${currentStatus}`,
    '',
    '  Controls:',
    '    space   Pause / Resume',
    '    q       Quit gracefully',
    '',
  ];
  process.stdout.write('\x1B[2J\x1B[H');
  process.stdout.write(lines.join('\n'));
}

function setupKeyboard() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === '\u0003') { stopping = true; paused = false; return; }
    if (key === ' ') { paused = !paused; log(paused ? 'Paused' : 'Resumed'); renderUI(); }
    else if (key === 'q' || key === 'Q') { stopping = true; paused = false; }
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

/* ── Backoff-aware authed fetch ─────────────────────────────────── */
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

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  fs.mkdirSync(CAST_META_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const already = existingStatus();
  log(`--- Session start. username=${USERNAME} refresh=${REFRESH} commentsOnly=${COMMENTS_ONLY} existing=${already.size} ---`);

  phase = 'launching chrome';
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

  // Intercept profile_feed responses where cut=appearances.
  // These carry the cast-in feed.
  const pendingIds = new Set();
  page.on('response', async (response) => {
    const url = response.url();
    if (!/\/backend\/project_[a-z]+\/profile_feed\//i.test(url)) return;
    if (!/[?&]cut=appearances(&|$)/.test(url)) return;
    try {
      const json = await response.json();
      const items = json?.items || [];
      for (const item of items) {
        const post = item?.post;
        if (!post?.id) continue;
        postsSeen++;
        const existing = already.get(post.id);
        if (!REFRESH && existing === 'complete') continue;
        const payload = {
          post,
          profile: item.profile,       // the poster (someone else)
          reposter_profile: item.reposter_profile,
          comments: { items: [], _pending: true },
        };
        writePost(post.id, payload);
        already.set(post.id, 'pending');
        pendingIds.add(post.id);
        if (!existing) capturedNewInRun++;
      }
    } catch { /* non-json */ }
  });

  console.log('Opening profile page...');
  const profileUrl = `https://sora.chatgpt.com/profile/${USERNAME}`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Auto-detect login
  console.log('Waiting for login (log in in the Chrome window)...');
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
  const via = await Promise.race([enterPromise, pollPromise]);
  console.log(`\nProceeding (${via === 'auto' ? 'auto-detected session' : 'user confirmed'}).`);

  setupKeyboard();

  // ── Phase 1: click "Cast in" tab and scroll ──
  if (COMMENTS_ONLY) {
    phase = 'scroll (skipped)';
    currentStatus = '--comments-only: skipping scroll, going straight to Phase 2';
    renderUI();
    log('Skipping Phase 1 — --comments-only mode');
  } else {
    phase = 'cast-in tab click';
    currentStatus = 'clicking Cast in tab';
    renderUI();
    try {
      await page.getByRole('tab', { name: /^Cast in/i }).click({ timeout: 15000 });
    } catch (e) {
      log(`Tab click failed: ${e.message} — falling back to DOM text selector`);
      try {
        await page.locator('button:has-text("Cast in"), [role="tab"]:has-text("Cast in")').first().click({ timeout: 10000 });
      } catch (e2) {
        log(`Fallback tab click failed too: ${e2.message}`);
        currentStatus = `WARN: could not click Cast in tab (${e2.message}). Continuing — hopefully you clicked it already.`;
        renderUI();
      }
    }
    await sleep(3000);

    phase = 'scroll';
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
    await sleep(2000);

    let runNumber = 1;
    while (!stopping) {
      currentStatus = `scroll run ${runNumber} (patience: ${STALE_TIMEOUT_S}s)`;
      renderUI();
      log(`Scroll run ${runNumber} starting`);

      let staleCount = 0;
      let scrollNum  = 0;
      let lastPageH  = 0;
      let newThisRun = 0;

      while (staleCount < MAX_STALE && !stopping) {
        await waitWhilePaused();
        if (stopping) break;
        scrollNum++;

        const before = pendingIds.size;
        await page.evaluate(px => window.scrollBy({ top: px, behavior: 'smooth' }), SCROLL_PX).catch(() => {});
        await pausedSleep(SCROLL_DELAY_MS);
        const after = pendingIds.size;
        const newlyCaptured = after - before;

        let info;
        try {
          info = await page.evaluate(() => ({
            scrollY: window.scrollY,
            maxScroll: document.documentElement.scrollHeight - window.innerHeight,
            pageH: document.documentElement.scrollHeight,
          }));
        } catch { info = { scrollY: 0, maxScroll: 1, pageH: 0 }; }
        const pct = Math.round((info.scrollY / Math.max(1, info.maxScroll)) * 100);
        const atBottom = pct >= 99;

        if (newlyCaptured > 0) {
          staleCount = 0;
          newThisRun += newlyCaptured;
          currentStatus = `scroll #${scrollNum}  +${newlyCaptured} posts (${pct}% · page ${info.pageH}px)`;
        } else {
          staleCount++;
          if (atBottom && staleCount % 6 === 0) {
            currentStatus = `scroll #${scrollNum}  nudging loader at bottom`;
            renderUI();
            await page.evaluate(() => window.scrollBy({ top: -600, behavior: 'smooth' })).catch(() => {});
            await pausedSleep(2000);
            await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })).catch(() => {});
            await pausedSleep(3000);
          }
          if (info.pageH > lastPageH) {
            staleCount = Math.max(0, staleCount - 3);
            currentStatus = `scroll #${scrollNum}  page grew → ${info.pageH}px (stale ${staleCount}/${MAX_STALE})`;
          } else {
            const secsLeft = Math.round((MAX_STALE - staleCount) * SCROLL_DELAY_MS / 1000);
            currentStatus = `scroll #${scrollNum}  no new posts (stale ${staleCount}/${MAX_STALE}, ${secsLeft}s left)`;
          }
        }
        lastPageH = info.pageH;
        renderUI();
      }

      if (stopping) break;

      log(`Scroll run ${runNumber} paused: +${newThisRun} new posts`);
      if (process.stdin.isTTY) {
        currentStatus = `scroll stalled (+${newThisRun} new). Keep scrolling? [y/n] — see terminal`;
        renderUI();
        process.stdin.setRawMode(false);
        const answer = await ask('\n\nKeep scrolling? [y/n] ');
        process.stdin.setRawMode(true); process.stdin.resume();
        if (answer.trim().toLowerCase() !== 'y') break;
      } else {
        log('Non-TTY session — stopping scroll after first stall');
        break;
      }
      runNumber++;
    }
  }

  // ── Phase 2: comments ──
  phase = 'comments';
  const todo = [];
  for (const f of fs.readdirSync(CAST_META_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    try {
      const j = readPost(id);
      if (REFRESH || j.comments?._pending) todo.push(id);
    } catch {}
  }
  log(`Phase 2: ${todo.length} cast-in posts need comment trees`);

  for (let i = 0; i < todo.length; i++) {
    if (stopping) break;
    await waitWhilePaused();
    if (stopping) break;

    const id = todo[i];
    currentStatus = `comments ${i + 1}/${todo.length}: ${id}`;
    renderUI();

    try {
      const tree = await authFetchBackoff(
        page,
        `/backend/project_y/post/${id}/tree?limit=100&max_depth=10`,
        `tree ${id}`
      );
      const existing = readPost(id);
      existing.comments = tree.children || { items: [] };
      writePost(id, existing);
      commentsOK++;
      consecutiveFails = 0;
      log(`OK comments ${id} (${existing.comments.items?.length || 0})`);
    } catch (e) {
      if (String(e.message).includes('stopped')) break;
      commentsFailed++;
      log(`FAIL comments ${id}: ${e.message}`);
      try {
        const existing = readPost(id);
        existing.comments = { items: [], _pending: true, _lastError: e.message };
        writePost(id, existing);
      } catch {}
    }

    await pausedSleep(COMMENT_DELAY_MS);
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await browser.close();

  const msg = stopping
    ? `Stopped. New cast-ins: ${capturedNewInRun}  Comments OK: ${commentsOK}  Failed: ${commentsFailed}`
    : `Complete! New cast-ins: ${capturedNewInRun}  Comments OK: ${commentsOK}  Failed: ${commentsFailed}`;
  log(msg);
  console.clear();
  console.log(`\n  ${msg}`);
  console.log(`  Log: ${LOG_FILE}`);
  console.log(`\n  Next: node build-archive.js --username ${USERNAME}\n`);
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
