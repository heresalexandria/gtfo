#!/usr/bin/env node
/**
 * backfill-prompts.js
 *
 * Walks the Sora drafts API paginated endpoint and writes each draft's
 * metadata (prompt, creation_config, encodings, etc.) into
 * archive/<user>/drafts/<id>/draft.json, plus a plain-text prompt.txt for
 * convenience. Safe to re-run — drafts whose draft.json already exists are
 * skipped unless --rebuild is passed.
 *
 * The API used is the same one the Sora web app hits when you scroll through
 * your drafts page: GET /backend/project_y/profile/drafts/v2?limit=N&cursor=X
 * which returns { items: [...], cursor: string }.
 *
 * Usage:
 *   1. Quit Chrome completely.
 *   2. node backfill-prompts.js --username <your-sora-username>
 *   3. Log in to Sora in the Chrome window that opens, then press Enter.
 *   4. The script walks the API from newest → oldest, writing metadata.
 *
 * Flags:
 *   --username <user>    required, picks the archive subfolder
 *   --limit N            page size (default 100, API max seems ~100)
 *   --rebuild            overwrite existing draft.json/prompt.txt
 *   --stop-on-known      stop walking once we hit a draft we already have
 *                        (default: keep going to the end)
 *   --delay MS           ms to wait between API pages (default 300)
 *   --out <dir>          override archive root (default ./archive)
 *
 * Controls during run:
 *   ↑ / +     Faster (less delay between pages)
 *   ↓ / -     Slower (more delay between pages)
 *   space     Pause / Resume
 *   q         Quit gracefully
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
if (!USERNAME) {
  console.error('Missing --username. Usage: node backfill-prompts.js --username <your-sora-username>');
  process.exit(1);
}

const ARCHIVE_ROOT = argVal('--out', path.join(__dirname, 'archive'));
const USER_DIR     = path.join(ARCHIVE_ROOT, USERNAME);
const DRAFTS_DIR   = path.join(USER_DIR, 'drafts');
const LOGS_DIR     = path.join(USER_DIR, 'logs');
const LOG_FILE     = path.join(LOGS_DIR, 'drafts-backfill.log');

const PAGE_LIMIT    = parseInt(argVal('--limit', '100'), 10);
const REBUILD       = args.includes('--rebuild');
const STOP_ON_KNOWN = args.includes('--stop-on-known');

const DRAFTS_URL     = 'https://sora.chatgpt.com/drafts';
const SESSION_URL    = 'https://sora.chatgpt.com/api/auth/session';
const DRAFTS_API     = 'https://sora.chatgpt.com/backend/project_y/profile/drafts/v2';

/* ── State ──────────────────────────────────────────────────────── */
let delayMs       = parseInt(argVal('--delay', '300'), 10);
let paused        = false;
let stopping      = false;
let pagesFetched  = 0;
let itemsSeen     = 0;
let written       = 0;
let skipped       = 0;
let failed        = 0;
let currentStatus = 'starting';
const startTime   = Date.now();
const recent      = [];
const RECENT_KEEP = 4;

/* ── Logging ────────────────────────────────────────────────────── */
function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

/* ── Helpers ────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '--:--';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/* ── UI ─────────────────────────────────────────────────────────── */
function renderUI(totalKnown) {
  const elapsed = (Date.now() - startTime) / 1000;
  const itemsPerSec = itemsSeen > 0 ? itemsSeen / elapsed : 0;
  const perMin = (itemsPerSec * 60).toFixed(0);
  const remaining = totalKnown > 0 ? Math.max(0, totalKnown - itemsSeen) : 0;
  const etaSec = itemsPerSec > 0 && remaining > 0 ? remaining / itemsPerSec : null;

  const pauseIndicator = paused ? ' ⏸  PAUSED' : (stopping ? ' ⏹  STOPPING' : '');
  const lines = [
    '',
    `  Draft Prompt Backfill — @${USERNAME}${pauseIndicator}`,
    '',
    `  Pages: ${pagesFetched}    Items seen: ${itemsSeen}${totalKnown ? ` / ~${totalKnown}` : ''}`,
    `  Written: ${written}    Skipped (exists): ${skipped}    Failed: ${failed}`,
    `  Rate: ${perMin}/min    Delay: ${delayMs}ms    Elapsed: ${formatDuration(elapsed)}    ETA: ${etaSec ? formatDuration(etaSec) : '--:--'}`,
    `  Current: ${currentStatus}`,
    '',
    '  Recent:',
    ...(recent.length ? recent.map(r => `    · ${r}`) : ['    (none yet)']),
    '',
    '  Controls:',
    '    ↑ / +   Faster (less delay)',
    '    ↓ / -   Slower (more delay)',
    '    space   Pause / Resume',
    '    q       Quit gracefully',
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
    switch (key) {
      case '\u001B[A': case '+': case '=':
        delayMs = Math.max(0, delayMs - 100); break;
      case '\u001B[B': case '-': case '_':
        delayMs = delayMs + 100; break;
      case ' ':
        paused = !paused;
        log(paused ? 'Paused' : 'Resumed'); break;
      case 'q': case 'Q':
        stopping = true; paused = false; break;
    }
  });
}

async function waitWhilePaused() {
  while (paused && !stopping) await sleep(150);
}

/* ── Persistence ────────────────────────────────────────────────── */
function writeDraft(item) {
  const id = item?.id;
  if (!id) {
    failed++;
    recent.unshift(`FAIL (no id)`);
    while (recent.length > RECENT_KEEP) recent.pop();
    return 'failed';
  }
  const dir = path.join(DRAFTS_DIR, id);
  const jsonPath = path.join(dir, 'draft.json');
  const promptPath = path.join(dir, 'prompt.txt');

  if (!REBUILD && fs.existsSync(jsonPath)) {
    skipped++;
    return 'skipped';
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(item, null, 2));
    const prompt = item.prompt || item.creation_config?.prompt || '';
    fs.writeFileSync(promptPath, prompt + (prompt.endsWith('\n') ? '' : '\n'));
    written++;
    recent.unshift(`OK ${id}  ${prompt.slice(0, 40).replace(/\s+/g, ' ')}${prompt.length > 40 ? '…' : ''}`);
    while (recent.length > RECENT_KEEP) recent.pop();
    return 'written';
  } catch (e) {
    failed++;
    recent.unshift(`FAIL ${id}: ${e.message}`);
    while (recent.length > RECENT_KEEP) recent.pop();
    log(`FAIL ${id}: ${e.stack || e.message}`);
    return 'failed';
  }
}

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // Seed an estimate of total drafts from how many ID folders already exist.
  const totalKnownLocal = fs.existsSync(DRAFTS_DIR)
    ? fs.readdirSync(DRAFTS_DIR).length
    : 0;

  console.log('Launching Chrome...');
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

  console.log(`Opening ${DRAFTS_URL}...`);
  await page.goto(DRAFTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ask('Press Enter once logged in and you can see your drafts... ');

  // Fetch bearer token from the authenticated session.
  //
  // IMPORTANT: NextAuth's /api/auth/session endpoint is picky about headers
  // (Origin/Referer/sec-fetch-* must match a same-origin browser request).
  // page.request.get() hits it from Node's request context and gets 403, so
  // we run the fetch INSIDE the page via evaluate — that goes out of the
  // actual rendering context with correct cookies and headers.
  async function getToken() {
    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      const text = await r.text();
      return { status: r.status, text };
    }, SESSION_URL);
    if (result.status !== 200) {
      throw new Error(`session endpoint ${result.status}: ${result.text.slice(0, 200)}`);
    }
    let j;
    try { j = JSON.parse(result.text); } catch { throw new Error('session response was not JSON'); }
    if (!j.accessToken) throw new Error('no accessToken in session response');
    return j.accessToken;
  }

  let token;
  try { token = await getToken(); }
  catch (e) { console.error('Could not get token:', e.message); process.exit(1); }

  log(`--- Session started. user=@${USERNAME} localKnown=${totalKnownLocal} limit=${PAGE_LIMIT} rebuild=${REBUILD} ---`);
  setupKeyboard();

  // UI refresh tick so we update even during long awaits.
  const uiTimer = setInterval(() => renderUI(totalKnownLocal), 400);

  let cursor = null;
  let sawAnyKnown = false;

  try {
    while (!stopping) {
      await waitWhilePaused();
      if (stopping) break;

      const url = `${DRAFTS_API}?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      currentStatus = cursor ? `fetching page ${pagesFetched + 1} (cursor ${cursor.slice(0, 12)}…)` : 'fetching first page';
      renderUI(totalKnownLocal);

      let resp;
      try {
        // Run the API call inside the browser for consistent CF/auth handling.
        resp = await page.evaluate(async ({ url, token }) => {
          const r = await fetch(url, {
            credentials: 'include',
            headers: { authorization: `Bearer ${token}` },
          });
          const text = await r.text();
          return { status: r.status, text };
        }, { url, token });
      } catch (e) {
        log(`NETWORK error: ${e.message}. Retrying after 3s.`);
        failed++;
        await sleep(3000);
        continue;
      }

      // Token may have expired — refresh and retry once.
      if (resp.status === 401) {
        log('401 — refreshing token and retrying');
        try { token = await getToken(); } catch (e) { log(`token refresh failed: ${e.message}`); break; }
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        log(`HTTP ${resp.status} on ${url}\n${resp.text.slice(0, 500)}`);
        failed++;
        await sleep(2000);
        if (resp.status >= 500) continue;  // transient
        break;
      }

      let data;
      try { data = JSON.parse(resp.text); }
      catch (e) {
        log(`JSON parse error on page ${pagesFetched + 1}: ${e.message}`);
        failed++;
        break;
      }
      pagesFetched++;
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0 && !data.cursor) {
        log('Empty page and no cursor — end of drafts.');
        break;
      }

      let newThisPage = 0;
      for (const item of items) {
        itemsSeen++;
        const result = writeDraft(item);
        if (result === 'written') newThisPage++;
        if (result === 'skipped') sawAnyKnown = true;
      }

      log(`page ${pagesFetched}: items=${items.length} new=${newThisPage} cursor=${data.cursor ? 'yes' : 'no'}`);
      if (STOP_ON_KNOWN && sawAnyKnown && newThisPage === 0) {
        currentStatus = 'stopping (entire page was already-known drafts, --stop-on-known)';
        renderUI(totalKnownLocal);
        log('Stopping early — --stop-on-known and no new items on this page.');
        break;
      }

      if (!data.cursor) {
        currentStatus = 'reached end of drafts';
        log('Walked to end of drafts feed.');
        break;
      }
      cursor = data.cursor;

      // Rate-limited delay.
      const target = delayMs;
      const chunk = 100;
      let waited = 0;
      while (waited < target && !stopping) {
        await waitWhilePaused();
        if (stopping) break;
        await sleep(Math.min(chunk, target - waited));
        waited += chunk;
      }
    }
  } finally {
    clearInterval(uiTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    await browser.close().catch(() => {});
  }

  const finalMsg = stopping
    ? `Stopped. Pages: ${pagesFetched}  Items: ${itemsSeen}  Written: ${written}  Skipped: ${skipped}  Failed: ${failed}`
    : `Complete! Pages: ${pagesFetched}  Items: ${itemsSeen}  Written: ${written}  Skipped: ${skipped}  Failed: ${failed}`;
  log(finalMsg);
  console.clear();
  console.log(`\n  ${finalMsg}`);
  console.log(`  Log: ${LOG_FILE}\n`);
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
