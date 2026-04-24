#!/usr/bin/env node
/**
 * thumbnail-drafts.js
 *
 * Extracts a still frame from each draft video and saves it as thumbnail.jpg
 * using a parallel pool of ffmpeg workers. Safe to re-run — files that already
 * have a thumbnail are skipped.
 *
 * Usage:
 *   node thumbnail-drafts.js --username <your-sora-username>
 *
 * Controls:
 *   ↑ / +     More workers
 *   ↓ / -     Fewer workers (min 1; running workers drain naturally)
 *   space     Pause (no new jobs dispatched; in-flight jobs finish)
 *   q         Quit gracefully (waits for in-flight jobs)
 *   Ctrl+C    Hard stop
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

/* ── CLI args ───────────────────────────────────────────────────── */
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const USERNAME = argVal('--username', null);
if (!USERNAME) {
  console.error('Missing --username. Usage: node thumbnail-drafts.js --username <your-sora-username>');
  process.exit(1);
}

const ARCHIVE_ROOT = argVal('--out', path.join(__dirname, 'archive'));
const USER_DIR     = path.join(ARCHIVE_ROOT, USERNAME);
const DRAFTS_DIR   = path.join(USER_DIR, 'drafts');
const LOGS_DIR     = path.join(USER_DIR, 'logs');
const LOG_FILE     = path.join(LOGS_DIR, 'drafts-thumbnail.log');

const INITIAL_WORKERS = parseInt(argVal('--workers', '4'), 10);
const MAX_WORKERS     = parseInt(argVal('--max-workers', String(Math.max(8, os.cpus().length))), 10);
const THUMB_WIDTH     = parseInt(argVal('--width', '360'), 10);
const SEEK_SECONDS    = argVal('--seek', '0.5');  // seek offset before frame grab

/* ── State ──────────────────────────────────────────────────────── */
let targetWorkers = Math.max(1, Math.min(MAX_WORKERS, INITIAL_WORKERS));
let paused        = false;
let stopping      = false;
let generated     = 0;
let skipped       = 0;
let failed        = 0;
let totalJobs     = 0;
let currentStatus = 'starting';
const startTime   = Date.now();
const recentIds   = [];   // last N completions, shown under progress
const RECENT_KEEP = 3;

/* ── Logging ────────────────────────────────────────────────────── */
function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

/* ── Job discovery ──────────────────────────────────────────────── */
function discoverJobs() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const jobs = [];
  for (const id of fs.readdirSync(DRAFTS_DIR)) {
    const dir   = path.join(DRAFTS_DIR, id);
    const video = path.join(dir, 'video.mp4');
    const thumb = path.join(dir, 'thumbnail.jpg');
    if (!fs.existsSync(video)) continue;
    if (fs.existsSync(thumb) && fs.statSync(thumb).size > 0) {
      skipped++;
      continue;
    }
    jobs.push({ id, video, thumb });
  }
  return jobs;
}

/* ── Worker pool ────────────────────────────────────────────────── */
const active = new Map();      // id -> child process
let resolveWait = null;         // called when any worker finishes
function waitForCompletion() {
  return new Promise(resolve => { resolveWait = resolve; });
}

function spawnWorker(job) {
  const proc = spawn('ffmpeg', [
    '-nostdin',
    '-loglevel', 'error',
    '-ss', SEEK_SECONDS,
    '-i', job.video,
    '-vframes', '1',
    '-vf', `scale=${THUMB_WIDTH}:-2`,
    '-q:v', '3',
    '-y',
    job.thumb,
  ]);

  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

  proc.on('error', err => {
    log(`ERR spawn ${job.id}: ${err.message}`);
  });

  proc.on('close', code => {
    active.delete(job.id);
    const okFile = fs.existsSync(job.thumb) && fs.statSync(job.thumb).size > 0;
    if (code === 0 && okFile) {
      generated++;
      recentIds.unshift(`OK ${job.id}`);
      log(`OK ${job.id}`);
    } else {
      failed++;
      recentIds.unshift(`FAIL ${job.id}`);
      log(`FAIL ${job.id} (exit ${code}): ${stderr.trim().slice(0, 200)}`);
      // Remove partial/empty thumbnail so it retries next run.
      if (fs.existsSync(job.thumb)) {
        try { fs.unlinkSync(job.thumb); } catch {}
      }
    }
    while (recentIds.length > RECENT_KEEP) recentIds.pop();

    if (resolveWait) {
      const r = resolveWait;
      resolveWait = null;
      r();
    }
  });

  active.set(job.id, proc);
}

/* ── UI ─────────────────────────────────────────────────────────── */
function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '--:--';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function renderUI(queueLen) {
  const processed = generated + failed;
  const totalToDo = generated + failed + queueLen + active.size;
  const pct = totalToDo > 0 ? Math.round((processed / totalToDo) * 100) : 0;
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = generated > 0 ? generated / elapsed : 0;   // jobs/sec
  const remaining = queueLen + active.size;
  const etaSec = rate > 0 ? remaining / rate : Infinity;
  const ratePerMin = (rate * 60).toFixed(1);

  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  const pauseIndicator = paused ? ' ⏸  PAUSED' : (stopping ? ' ⏹  STOPPING' : '');

  const recentBlock = recentIds.length
    ? recentIds.map(s => `    · ${s}`)
    : ['    (waiting for first completion...)'];

  const lines = [
    '',
    `  Draft Thumbnails — @${USERNAME}${pauseIndicator}`,
    `  ${bar} ${pct}%  (${processed}/${totalToDo})`,
    '',
    `  Generated: ${generated}    Skipped: ${skipped}    Failed: ${failed}`,
    `  Workers: ${active.size} active / ${targetWorkers} target (max ${MAX_WORKERS})`,
    `  Rate: ${ratePerMin}/min    Elapsed: ${formatDuration(elapsed)}    ETA: ${formatDuration(etaSec)}`,
    '',
    `  Recent:`,
    ...recentBlock,
    '',
    `  Controls:`,
    `    ↑ / +   More workers`,
    `    ↓ / -   Fewer workers`,
    `    space   ${paused ? 'Resume' : 'Pause'}`,
    `    q       Quit gracefully`,
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
    if (key === '\u0003') {  // Ctrl+C
      stopping = true;
      paused = false;
      for (const proc of active.values()) {
        try { proc.kill('SIGTERM'); } catch {}
      }
      return;
    }
    switch (key) {
      case '\u001B[A': case '+': case '=':
        targetWorkers = Math.min(MAX_WORKERS, targetWorkers + 1);
        log(`targetWorkers → ${targetWorkers}`);
        break;
      case '\u001B[B': case '-': case '_':
        targetWorkers = Math.max(1, targetWorkers - 1);
        log(`targetWorkers → ${targetWorkers}`);
        break;
      case ' ':
        paused = !paused;
        log(paused ? 'Paused' : 'Resumed');
        break;
      case 'q': case 'Q':
        stopping = true;
        paused = false;
        break;
    }
    // Wake the main loop so it re-reads state immediately.
    if (resolveWait) {
      const r = resolveWait;
      resolveWait = null;
      r();
    }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Main ───────────────────────────────────────────────────────── */
(async () => {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (!fs.existsSync(DRAFTS_DIR)) {
    console.error(`Drafts directory not found: ${DRAFTS_DIR}`);
    console.error(`Run: node download-drafts.js --username ${USERNAME}`);
    process.exit(1);
  }

  const queue = discoverJobs();
  totalJobs = queue.length;

  log(`--- Session started: ${totalJobs} jobs, ${skipped} already-thumbnailed, initial workers=${targetWorkers} ---`);

  if (totalJobs === 0) {
    console.log(`\n  Nothing to do: all ${skipped} drafts already have thumbnails.\n`);
    process.exit(0);
  }

  setupKeyboard();
  renderUI(queue.length);

  // UI refresh tick so progress updates even when no worker finishes.
  const uiTimer = setInterval(() => renderUI(queue.length), 500);

  while ((queue.length > 0 || active.size > 0) && !stopping) {
    // Fill up to target.
    while (!paused && !stopping && queue.length > 0 && active.size < targetWorkers) {
      spawnWorker(queue.shift());
    }

    // Wait for any active worker to finish, or a keyboard-triggered wake.
    if (active.size > 0) {
      await waitForCompletion();
    } else if (queue.length > 0 && paused) {
      // Paused with work left → poll until unpaused / quit.
      await Promise.race([waitForCompletion(), sleep(200)]);
    } else {
      // No active, nothing else to wait for.
      break;
    }
  }

  // If stopping, give active workers a moment to finish cleanly.
  if (stopping && active.size > 0) {
    currentStatus = 'stopping — waiting for active workers...';
    renderUI(queue.length);
    await Promise.race([
      Promise.all(Array.from(active.values()).map(p =>
        new Promise(r => p.once('close', r)))),
      sleep(10000),
    ]);
  }

  clearInterval(uiTimer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const remaining = queue.length + active.size;
  const finalMsg = stopping
    ? `Stopped. Generated: ${generated}, Failed: ${failed}, Remaining: ${remaining}`
    : `Complete! Generated: ${generated}, Skipped: ${skipped}, Failed: ${failed}`;
  log(finalMsg);

  console.clear();
  console.log(`\n  ${finalMsg}`);
  console.log(`  Log: ${LOG_FILE}\n`);
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
