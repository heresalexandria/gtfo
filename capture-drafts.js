#!/usr/bin/env node
/**
 * capture-drafts.js
 *
 * Scrolls through https://sora.chatgpt.com/drafts capturing video
 * download URLs via Sora API response interception. No extension needed.
 *
 * When scrolling stalls (5 min with no new URLs), it pauses and asks
 * if you want to keep going — so you can manually nudge the page in
 * Chrome to trigger more content, then resume.
 *
 * Usage:
 *   1. Quit Chrome completely.
 *   2. node capture-drafts.js --username <your-sora-username>
 *   3. Log in to Sora in the Chrome window that opens.
 *   4. Press Enter in the terminal when you can see your drafts.
 *   5. The script scrolls and captures. When it stalls, it asks to continue.
 *   6. Run node download-drafts.js --username <your-sora-username> to download.
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
  console.error('Missing --username. Usage: node capture-drafts.js --username <your-sora-username>');
  process.exit(1);
}

/* ── Configuration ──────────────────────────────────────────────── */
const ARCHIVE_ROOT    = argVal('--out', path.join(__dirname, 'archive'));
const USER_DIR        = path.join(ARCHIVE_ROOT, USERNAME);
const DRAFTS_DIR      = process.env.DEST_DIR || path.join(USER_DIR, 'drafts');
const URLS_FILE       = process.env.URLS_FILE || path.join(USER_DIR, 'drafts.txt');
const SCROLL_PX       = 300;
const SCROLL_DELAY_MS = 5000;
const STALE_TIMEOUT_S = 300;     // 5 min before pausing
const DRAFTS_URL      = 'https://sora.chatgpt.com/drafts';

const MAX_STALE = Math.ceil(STALE_TIMEOUT_S / (SCROLL_DELAY_MS / 1000));

/* ── URL extraction (mirrors extension logic) ───────────────────── */
function bestDownloadUrl(item) {
  if (!item || typeof item !== 'object') return null;
  return [
    item?.encodings?.source?.path,
    item?.encodings?.source_wm?.path,
    item?.downloadable_url,
    item?.download_urls?.no_watermark,
    item?.download_urls?.watermark,
  ].find(u => typeof u === 'string' && u.length > 0) || null;
}

function extractDraftItems(json) {
  if (!json) return [];
  if (Array.isArray(json)) {
    const gens = [];
    for (const task of json) {
      if (Array.isArray(task?.generations)) {
        for (const gen of task.generations) {
          if (gen && typeof gen === 'object') gens.push(gen);
        }
      }
    }
    return gens.length > 0 ? gens : json;
  }
  return [].concat(json?.items || json?.data?.items || json?.generations || []);
}

/* ── Helpers ────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function loadKnownIds() {
  const ids = new Set();
  if (fs.existsSync(URLS_FILE)) {
    for (const line of fs.readFileSync(URLS_FILE, 'utf-8').split('\n')) {
      const id = line.split('|')[0];
      if (id) ids.add(id);
    }
  }
  // Per-draft subfolder layout: DRAFTS_DIR/<id>/video.mp4
  if (fs.existsSync(DRAFTS_DIR)) {
    for (const id of fs.readdirSync(DRAFTS_DIR)) {
      const video = path.join(DRAFTS_DIR, id, 'video.mp4');
      if (fs.existsSync(video)) ids.add(id);
    }
  }
  return ids;
}

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(URLS_FILE), { recursive: true });

  const knownIds = loadKnownIds();
  if (knownIds.size > 0) console.log(`Skipping ${knownIds.size} already-captured drafts.\n`);

  // Launch Chrome
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

  // State shared with response interceptor
  let newThisScroll = 0;
  let totalCaptured = 0;

  // Intercept API responses for draft data
  page.on('response', async (response) => {
    const url = response.url();
    const match =
      /\/(backend\/project_[a-z]+\/)?profile\/drafts($|\/|\?)/i.test(url) ||
      /\/backend\/nf\/pending\/v2/i.test(url) ||
      /\/(backend\/project_[a-z]+\/)?profile_feed/i.test(url);
    if (!match) return;

    try {
      const json = await response.json();
      for (const item of extractDraftItems(json)) {
        const id = item?.id || item?.generation_id || item?.draft_id;
        if (!id || knownIds.has(id)) continue;
        const downloadUrl = bestDownloadUrl(item);
        if (!downloadUrl) continue;

        knownIds.add(id);
        newThisScroll++;
        totalCaptured++;
        fs.appendFileSync(URLS_FILE, `${id}|${downloadUrl}\n`);
      }
    } catch {}
  });

  // Navigate and wait for login
  console.log(`Opening ${DRAFTS_URL}...\n`);
  await page.goto(DRAFTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ask('Press Enter when logged in and you can see your drafts... ');

  // Scroll to top
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(4000);
  console.log(`\nCaptured from page load: ${totalCaptured}`);

  // ── Scroll loop with interactive pause/resume ──
  let runNumber = 1;

  while (true) {
    console.log(`\n--- Run ${runNumber} (patience: ${STALE_TIMEOUT_S}s) ---\n`);

    let staleCount = 0;
    let scrollNum = 0;
    let lastPageH = 0;
    let capturedThisRun = 0;

    while (staleCount < MAX_STALE) {
      scrollNum++;
      newThisScroll = 0;

      await page.evaluate(px => window.scrollBy({ top: px, behavior: 'smooth' }), SCROLL_PX);
      await sleep(SCROLL_DELAY_MS);

      const info = await page.evaluate(() => ({
        scrollY: window.scrollY,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight,
        pageH: document.documentElement.scrollHeight,
      }));
      const pct = Math.round((info.scrollY / Math.max(1, info.maxScroll)) * 100);
      const atBottom = pct >= 99;

      if (newThisScroll > 0) {
        staleCount = 0;
        capturedThisRun += newThisScroll;
        console.log(
          `[${scrollNum}] +${newThisScroll} URLs (total: ${totalCaptured}, scroll: ${pct}%, page: ${info.pageH}px)`
        );
      } else {
        staleCount++;

        // At bottom: nudge scroll to re-trigger infinite scroll loader
        if (atBottom && staleCount % 6 === 0) {
          console.log(`[${scrollNum}] Nudging scroll to trigger loader...`);
          await page.evaluate(() => window.scrollBy({ top: -600, behavior: 'smooth' }));
          await sleep(2000);
          await page.evaluate(() =>
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
          );
          await sleep(3000);
        }

        // Page grew = content loading, be more patient
        if (info.pageH > lastPageH) {
          staleCount = Math.max(0, staleCount - 3);
          console.log(
            `[${scrollNum}] Page grew → ${info.pageH}px, resetting patience (stale ${staleCount}/${MAX_STALE})`
          );
        } else {
          const secsLeft = Math.round((MAX_STALE - staleCount) * SCROLL_DELAY_MS / 1000);
          console.log(
            `[${scrollNum}] No new URLs (stale ${staleCount}/${MAX_STALE}, ${secsLeft}s left, scroll: ${pct}%)`
          );
        }
      }

      lastPageH = info.pageH;
    }

    // ── Stalled — ask user what to do ──
    console.log(`\n=== Paused after ${capturedThisRun} new URLs this run (${totalCaptured} total) ===`);
    console.log('No new URLs for 5 minutes.');
    console.log('');
    console.log('You can now:');
    console.log('  - Manually scroll in Chrome to trigger more content');
    console.log('  - Wait for the page to load more');
    console.log('  - Check if you\'ve reached the end');
    console.log('');

    const answer = await ask('Keep going? [y/n] ');
    if (answer.trim().toLowerCase() !== 'y') break;

    runNumber++;
    console.log('Resuming from current scroll position...');
  }

  console.log(`\n=== DONE ===`);
  console.log(`Total URLs captured: ${totalCaptured}`);
  console.log(`File: ${URLS_FILE}`);
  console.log(`\nDownload with: node download-drafts.js`);

  await browser.close();
  process.exit(0);
})();
