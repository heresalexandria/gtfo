#!/usr/bin/env node
/**
 * build-archive.js
 *
 * Reads the metadata captured by capture-profile.js, downloads each post's
 * video + thumbnail (with interactive rate limiting), and generates a
 * browsable local HTML archive. Safe to re-run — already-downloaded videos
 * and already-rendered pages are skipped unless --rebuild is passed.
 *
 * Input:
 *   archive/<user>/profile.json
 *   archive/<user>/_posts/<postId>.json
 *
 * Output:
 *   archive/<user>/index.html                  profile grid
 *   archive/<user>/style.css
 *   archive/<user>/assets/avatar.jpg
 *   archive/<user>/posts/<postId>/video.mp4
 *   archive/<user>/posts/<postId>/thumbnail.jpg
 *   archive/<user>/posts/<postId>/index.html
 *   archive/<user>/logs/build.log
 *
 * Usage:
 *   node build-archive.js --username <your-sora-username> [--rebuild]
 *
 * Controls during download:
 *   ↑ / +   Faster (decrease delay between downloads)
 *   ↓ / -   Slower (increase delay)
 *   space   Pause / Resume
 *   q       Quit gracefully
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
const ROOT     = argVal('--out', path.join(__dirname, 'archive'));
const REBUILD  = args.includes('--rebuild');  // rewrite HTML even if exists

if (!USERNAME) {
  console.error('Missing --username. Usage: node build-archive.js --username <your-sora-username> [--rebuild]');
  process.exit(1);
}

const OUT_DIR        = path.join(ROOT, USERNAME);
const POSTS_META_DIR = path.join(OUT_DIR, '_posts');
const POSTS_DIR      = path.join(OUT_DIR, 'posts');
const ASSETS_DIR     = path.join(OUT_DIR, 'assets');
const AVATARS_DIR    = path.join(ASSETS_DIR, 'avatars');
const LOGS_DIR       = path.join(OUT_DIR, 'logs');
const LOG_FILE       = path.join(LOGS_DIR, 'build.log');
const PROFILE_FILE   = path.join(OUT_DIR, 'profile.json');

const AVATAR_DELAY_MS = 400;  // brief delay between cast-avatar downloads

const MIN_FILE_KB = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

/* ── State ──────────────────────────────────────────────────────── */
let delaySeconds   = 2;
let paused         = false;
let stopping       = false;
let downloaded     = 0;
let skipped        = 0;
let failed         = 0;
let totalPosts     = 0;
let currentStatus  = 'starting';
const startTime    = Date.now();

/* ── Logging ────────────────────────────────────────────────────── */
function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

/* ── Download ───────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 120000 }, (res) => {
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

async function downloadWithRetries(url, dest) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFile(url, dest);
      const size = fs.statSync(dest).size;
      if (size < MIN_FILE_KB * 1024 && dest.endsWith('.mp4')) {
        fs.unlinkSync(dest);
        throw new Error(`suspicious size: ${Math.round(size / 1024)} KB`);
      }
      return { ok: true, size };
    } catch (err) {
      log(`FAIL ${path.basename(dest)} attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES && !stopping) await sleep(RETRY_DELAY);
    }
  }
  return { ok: false };
}

function bestVideoUrl(att) {
  if (!att) return null;
  return att?.download_urls?.no_watermark
      || att?.download_urls?.watermark
      || att?.downloadable_url
      || att?.url
      || att?.encodings?.source?.path
      || null;
}

function thumbUrl(att, post) {
  return att?.encodings?.thumbnail?.path
      || post?.preview_image_url
      || null;
}

/**
 * Return the cast (cameo_profiles minus the poster themselves).
 * Each entry is { user_id, username, display_name, profile_picture_url,
 * permalink, isCharacter, ownerUsername, avatarRel }.
 * avatarRel is only set later once we know whether we downloaded a local copy.
 */
function extractCast(post, posterUserId) {
  const members = post?.cameo_profiles || [];
  return members
    .filter(p => p?.user_id && p.user_id !== posterUserId)
    .map(p => ({
      user_id: p.user_id,
      username: p.username,
      display_name: p.display_name,
      profile_picture_url: p.profile_picture_url,
      permalink: p.permalink || (p.username ? `https://sora.chatgpt.com/profile/${p.username}` : null),
      isCharacter: typeof p.user_id === 'string' && p.user_id.startsWith('ch_'),
      ownerUsername: p.owner_profile?.username ? p.owner_profile.username.replace(/^@/, '') : null,
    }));
}

/* ── HTML helpers ───────────────────────────────────────────────── */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNum(n) {
  if (typeof n !== 'number') return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/* ── HTML templates ─────────────────────────────────────────────── */
const CSS = `:root {
  --bg: #0b0b0c;
  --fg: #f5f5f7;
  --muted: #8e8e93;
  --accent: #ff5f5f;
  --card: #17171a;
  --border: #2a2a2e;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
a { color: inherit; text-decoration: none; }

.profile-header {
  display: flex; gap: 24px; align-items: center;
  padding: 40px 24px; max-width: 1200px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
}
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; background: #333; }
.about h1 { margin: 0 0 4px 0; font-size: 28px; }
.about .name { color: var(--muted); margin-bottom: 8px; }
.about .bio { margin: 8px 0; max-width: 600px; white-space: pre-wrap; }
.about .counts { display: flex; gap: 20px; color: var(--muted); font-size: 14px; margin-top: 8px; flex-wrap: wrap; }
.about .counts b { color: var(--fg); }
.about .archived { color: var(--muted); font-size: 12px; margin-top: 8px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  padding: 24px;
  max-width: 1200px; margin: 0 auto;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  transition: transform .12s;
}
.card:hover { transform: translateY(-2px); border-color: #444; }
.thumb {
  position: relative;
  aspect-ratio: 9 / 16;
  background: #000;
  overflow: hidden;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb .dur {
  position: absolute; bottom: 8px; right: 8px;
  background: rgba(0,0,0,.7); color: #fff; font-size: 11px;
  padding: 2px 6px; border-radius: 4px;
}
.card .meta { padding: 10px 12px 12px; }
.card .caption {
  font-size: 13px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 36px;
}
.card .stats { display: flex; gap: 12px; color: var(--muted); font-size: 12px; margin-top: 8px; }

/* Post page */
.post-page nav { padding: 16px 24px; border-bottom: 1px solid var(--border); }
.post-page article { max-width: 720px; margin: 0 auto; padding: 24px; }
.video-wrap { background: #000; border-radius: 12px; overflow: hidden; }
.video-wrap video { width: 100%; display: block; max-height: 80vh; background: #000; }
.no-video { padding: 40px; text-align: center; color: var(--muted); background: #000; border-radius: 12px; }
.post-meta { padding: 16px 0; border-bottom: 1px solid var(--border); }
.post-meta .caption { font-size: 18px; margin: 0 0 12px 0; font-weight: 500; white-space: pre-wrap; }
.stats.big { display: flex; gap: 16px; color: var(--muted); font-size: 14px; flex-wrap: wrap; }
.posted { color: var(--muted); font-size: 12px; margin-top: 8px; }

.cast-section { padding: 16px 0; border-bottom: 1px solid var(--border); }
.cast-section h2 { font-size: 14px; margin: 0 0 10px 0; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
.cast-members { display: flex; gap: 16px; flex-wrap: wrap; }
.cast-member { display: flex; align-items: center; gap: 8px; }
.cast-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #333; flex-shrink: 0; }
.cast-name { display: flex; flex-direction: column; line-height: 1.2; }
.cast-name .handle { font-size: 13px; }
.cast-name .disp { color: var(--muted); font-size: 11px; }
.cast-name .character { color: var(--muted); font-size: 10px; font-style: italic; }
.card .cast-teaser { color: var(--muted); font-size: 11px; margin-top: 6px; display: flex; gap: 4px; align-items: center; overflow: hidden; }
.card .cast-teaser .avatars { display: inline-flex; }
.card .cast-teaser .avatars img { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--card); margin-left: -4px; object-fit: cover; background: #333; }
.card .cast-teaser .avatars img:first-child { margin-left: 0; }

.comments-section { padding: 16px 0; }
.comments-section h2 { font-size: 16px; margin: 0 0 12px 0; }
.comments, .replies { list-style: none; padding: 0; margin: 0; }
.replies { padding-left: 24px; border-left: 2px solid var(--border); margin-top: 8px; }
.comment { padding: 12px 0; border-bottom: 1px solid var(--border); }
.comment-head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; flex-wrap: wrap; }
.comment-head .disp { color: var(--muted); }
.comment-head .when { color: var(--muted); font-size: 12px; margin-left: auto; }
.comment-head .clikes { color: var(--muted); font-size: 12px; }
.comment-body { margin-top: 4px; white-space: pre-wrap; }
.no-comments { color: var(--muted); }
`;

function profilePageHtml(profile, processed) {
  const title = `@${profile.username} · Sora archive`;
  const cards = processed.map(({ post, thumbRel, cast }) => {
    const att = post.attachments?.[0];
    const duration = att?.duration_s ? `${att.duration_s.toFixed(1)}s` : '';
    const castTeaser = (cast && cast.length)
      ? `<div class="cast-teaser" title="${escapeHtml(cast.map(c => '@' + c.username).join(', '))}">
           <span class="avatars">${cast.slice(0, 3).map(c =>
             `<img loading="lazy" src="${escapeHtml(c.avatarRel || c.profile_picture_url || '')}" alt="" onerror="this.style.display='none'">`
           ).join('')}</span>
           <span>cast ${cast.length}</span>
         </div>`
      : '';
    return `
      <a class="card" href="posts/${encodeURIComponent(post.id)}/index.html">
        <div class="thumb">
          ${thumbRel ? `<img loading="lazy" src="${escapeHtml(thumbRel)}" alt="">` : ''}
          ${duration ? `<span class="dur">${escapeHtml(duration)}</span>` : ''}
        </div>
        <div class="meta">
          <div class="caption">${escapeHtml((post.text || '').slice(0, 140))}</div>
          <div class="stats">
            <span title="Views">▶ ${formatNum(post.view_count || 0)}</span>
            <span title="Likes">♥ ${formatNum(post.like_count || 0)}</span>
            <span title="Replies">💬 ${formatNum(post.reply_count || 0)}</span>
          </div>
          ${castTeaser}
        </div>
      </a>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="profile-header">
  <img class="avatar" src="assets/avatar.jpg" alt="avatar" onerror="this.style.display='none'">
  <div class="about">
    <h1>@${escapeHtml(profile.username)}</h1>
    ${profile.display_name ? `<div class="name">${escapeHtml(profile.display_name)}</div>` : ''}
    ${profile.description ? `<p class="bio">${escapeHtml(profile.description)}</p>` : ''}
    <div class="counts">
      <span><b>${formatNum(profile.post_count || processed.length)}</b> posts</span>
      <span><b>${formatNum(profile.follower_count || 0)}</b> followers</span>
      <span><b>${formatNum(profile.following_count || 0)}</b> following</span>
      <span><b>${formatNum(profile.likes_received_count || 0)}</b> likes received</span>
    </div>
    <div class="archived">Archived ${escapeHtml(new Date().toLocaleString())} · ${processed.length} posts</div>
  </div>
</header>
<main class="grid">
${cards}
</main>
</body>
</html>`;
}

function postPageHtml(post, profile, commentsObj, videoRel, thumbRel, cast) {
  const caption = post.text || '';
  const posted = formatDate(post.posted_at);
  const comments = commentsObj?.items || [];
  const isPending = !!commentsObj?._pending;
  const lastError = commentsObj?._lastError;
  const castHtml = (cast && cast.length)
    ? `<section class="cast-section">
         <h2>Cast (${cast.length})</h2>
         <div class="cast-members">
           ${cast.map(c => `
             <a class="cast-member" href="${escapeHtml(c.permalink || '#')}" target="_blank" rel="noopener">
               <img class="cast-avatar" src="${escapeHtml(c.avatarRel || c.profile_picture_url || '')}" alt="" onerror="this.style.display='none'">
               <span class="cast-name">
                 <span class="handle">@${escapeHtml(c.username)}</span>
                 ${c.display_name ? `<span class="disp">${escapeHtml(c.display_name)}</span>` : ''}
                 ${c.isCharacter ? `<span class="character">character${c.ownerUsername ? ' of @' + escapeHtml(c.ownerUsername) : ''}</span>` : ''}
               </span>
             </a>`).join('')}
         </div>
       </section>`
    : '';
  const commentNodes = (items, depth = 0) => items.map(it => {
    const c = it.post, p = it.profile;
    const children = it.children?.items || [];
    return `
      <li class="comment" style="--depth:${depth}">
        <div class="comment-head">
          <strong>@${escapeHtml(p?.username || 'unknown')}</strong>
          ${p?.display_name ? `<span class="disp">${escapeHtml(p.display_name)}</span>` : ''}
          <span class="when">${escapeHtml(formatDate(c.posted_at))}</span>
          ${c.like_count ? `<span class="clikes">♥ ${formatNum(c.like_count)}</span>` : ''}
        </div>
        <div class="comment-body">${escapeHtml(c.text || '')}</div>
        ${children.length ? `<ul class="replies">${commentNodes(children, depth + 1)}</ul>` : ''}
      </li>`;
  }).join('\n');

  const expected = post.reply_count || 0;
  let commentsHtml;
  if (comments.length) {
    commentsHtml = `<ul class="comments">${commentNodes(comments)}</ul>`;
  } else if (isPending) {
    commentsHtml = `<p class="no-comments">Comments not fetched yet${expected ? ` (${expected} pending)` : ''}${lastError ? ` — last error: ${escapeHtml(lastError)}` : ''}. Re-run <code>node capture-profile.js --comments-only</code> to finish this.</p>`;
  } else if (expected > 0) {
    commentsHtml = `<p class="no-comments">No comments captured (post reports ${expected} replies — may have been deleted since capture).</p>`;
  } else {
    commentsHtml = `<p class="no-comments">No comments.</p>`;
  }

  const videoBlock = videoRel
    ? `<div class="video-wrap">
         <video controls ${thumbRel ? `poster="${escapeHtml(thumbRel)}"` : ''} playsinline>
           <source src="${escapeHtml(videoRel)}" type="video/mp4">
         </video>
       </div>`
    : `<div class="no-video">Video unavailable (not downloaded).</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(caption.slice(0, 60) || post.id)} · @${escapeHtml(profile.username)}</title>
<link rel="stylesheet" href="../../style.css">
</head>
<body class="post-page">
<nav><a href="../../index.html">← @${escapeHtml(profile.username)}</a></nav>
<article>
  ${videoBlock}
  <div class="post-meta">
    <h1 class="caption">${escapeHtml(caption)}</h1>
    <div class="stats big">
      <span>▶ ${formatNum(post.view_count || 0)} views</span>
      <span>♥ ${formatNum(post.like_count || 0)} likes</span>
      <span>💬 ${formatNum(post.reply_count || 0)} replies</span>
      ${post.remix_count ? `<span>🎬 ${formatNum(post.remix_count)} remixes</span>` : ''}
    </div>
    <div class="posted">Posted ${escapeHtml(posted)}</div>
  </div>
  ${castHtml}
  <section class="comments-section">
    <h2>Comments (${isPending && expected ? `${comments.length}/${expected}` : comments.length})</h2>
    ${commentsHtml}
  </section>
</article>
</body>
</html>`;
}

/* ── Progress UI ────────────────────────────────────────────────── */
function renderUI() {
  const processed = downloaded + skipped + failed;
  const pct = totalPosts > 0 ? Math.round((processed / totalPosts) * 100) : 0;
  const rate = Math.round(60 / Math.max(1, delaySeconds));
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const elapsedStr = formatDuration(elapsed);
  const remaining = downloaded > 0
    ? Math.round(((totalPosts - processed) * elapsed) / downloaded)
    : 0;
  const etaStr = remaining > 0 ? formatDuration(remaining) : '--:--';

  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  const pauseIndicator = paused ? ' ⏸  PAUSED' : '';

  const lines = [
    '',
    `  Sora Archive Builder — @${USERNAME}${pauseIndicator}`,
    `  ${bar} ${pct}%  (${processed}/${totalPosts})`,
    '',
    `  Downloaded: ${downloaded}    Skipped: ${skipped}    Failed: ${failed}`,
    `  Rate: ${rate}/min (${delaySeconds}s delay)    Elapsed: ${elapsedStr}    ETA: ${etaStr}`,
    `  Current: ${currentStatus}`,
    '',
    `  Controls:`,
    `    ↑ / +   Faster (decrease delay by 1s)`,
    `    ↓ / -   Slower (increase delay by 1s)`,
    `    space    ${paused ? 'Resume' : 'Pause'}`,
    `    q        Quit gracefully`,
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
        delaySeconds = Math.max(1, delaySeconds - 1); renderUI(); break;
      case '\u001B[B': case '-': case '_':
        delaySeconds = delaySeconds + 1; renderUI(); break;
      case ' ':
        paused = !paused; log(paused ? 'Paused' : 'Resumed'); renderUI(); break;
      case 'q': case 'Q':
        stopping = true; paused = false; break;
    }
  });
}

async function waitWhilePaused() { while (paused && !stopping) await sleep(200); }
async function rateDelay() {
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
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (!fs.existsSync(PROFILE_FILE)) {
    console.error(`Profile not found: ${PROFILE_FILE}`);
    console.error(`Run capture-profile.js --username ${USERNAME} first.`);
    process.exit(1);
  }

  const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));

  // Avatar (skip if already present)
  const avatarDest = path.join(ASSETS_DIR, 'avatar.jpg');
  if (profile.profile_picture_url && (!fs.existsSync(avatarDest) || REBUILD)) {
    try { await downloadWithRetries(profile.profile_picture_url, avatarDest); } catch {}
  }

  // Load all captured posts, sorted newest → oldest by posted_at
  const metaFiles = fs.existsSync(POSTS_META_DIR)
    ? fs.readdirSync(POSTS_META_DIR).filter(f => f.endsWith('.json'))
    : [];
  const entries = metaFiles.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(POSTS_META_DIR, f), 'utf-8'));
    return data;
  });
  entries.sort((a, b) => (b.post?.posted_at || 0) - (a.post?.posted_at || 0));
  totalPosts = entries.length;

  if (totalPosts === 0) {
    console.error(`No captured posts found in ${POSTS_META_DIR}.`);
    console.error(`Run capture-profile.js --username ${USERNAME} first.`);
    process.exit(1);
  }

  log(`--- Session started. Posts: ${totalPosts} rebuild=${REBUILD} ---`);
  setupKeyboard();

  // ── Avatar pre-pass: download unique cast-member avatars ──────
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const uniqueCast = new Map();  // user_id -> { url, username }
  for (const entry of entries) {
    for (const c of extractCast(entry.post, profile.user_id)) {
      if (!uniqueCast.has(c.user_id) && c.profile_picture_url) {
        uniqueCast.set(c.user_id, { url: c.profile_picture_url, username: c.username });
      }
    }
  }
  const avatarMap = new Set();  // user_ids with local avatar on disk
  {
    const casts = Array.from(uniqueCast.entries());
    let i = 0;
    for (const [uid, info] of casts) {
      if (stopping) break;
      await waitWhilePaused();
      if (stopping) break;
      i++;
      const dest = path.join(AVATARS_DIR, `${uid}.jpg`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        avatarMap.add(uid);
        continue;
      }
      currentStatus = `avatar ${i}/${casts.length}: @${info.username}`;
      renderUI();
      try {
        await downloadWithRetries(info.url, dest);
        avatarMap.add(uid);
        log(`OK avatar ${uid} (@${info.username})`);
      } catch (e) {
        log(`FAIL avatar ${uid} (@${info.username}): ${e.message}`);
      }
      if (!stopping) await sleep(AVATAR_DELAY_MS);
    }
  }

  function attachAvatars(cast, basePath) {
    return cast.map(c => ({
      ...c,
      avatarRel: avatarMap.has(c.user_id)
        ? `${basePath}assets/avatars/${c.user_id}.jpg`
        : c.profile_picture_url,
    }));
  }

  renderUI();

  const processed = [];

  for (const entry of entries) {
    if (stopping) break;
    await waitWhilePaused();
    if (stopping) break;

    const { post, profile: postProfile, comments } = entry;
    const postId = post.id;
    const postDir = path.join(POSTS_DIR, postId);
    fs.mkdirSync(postDir, { recursive: true });

    const videoDest = path.join(postDir, 'video.mp4');
    const thumbDest = path.join(postDir, 'thumbnail.jpg');
    const htmlDest  = path.join(postDir, 'index.html');

    const att = post.attachments?.[0];

    const hasVideo = fs.existsSync(videoDest) && fs.statSync(videoDest).size > MIN_FILE_KB * 1024;
    const hasThumb = fs.existsSync(thumbDest);

    let didDownload = false;

    if (!hasVideo) {
      const url = bestVideoUrl(att);
      if (url) {
        currentStatus = `downloading video ${postId}`;
        renderUI();
        const res = await downloadWithRetries(url, videoDest);
        if (res.ok) {
          log(`OK video ${postId} (${Math.round(res.size / 1024)} KB)`);
          didDownload = true;
        } else {
          log(`FAILED video ${postId}`);
          failed++;
          currentStatus = `FAILED video ${postId}`;
          renderUI();
          continue;
        }
      }
    }

    if (!hasThumb) {
      const turl = thumbUrl(att, post);
      if (turl) {
        try { await downloadWithRetries(turl, thumbDest); didDownload = true; } catch {}
      }
    }

    const videoRel = fs.existsSync(videoDest) ? 'video.mp4' : '';
    const thumbRel = fs.existsSync(thumbDest) ? 'thumbnail.jpg' : '';

    const rawCast = extractCast(post, profile.user_id);
    const castForPost = attachAvatars(rawCast, '../../');
    const castForGrid = attachAvatars(rawCast, '');

    // Regenerate HTML if: forced rebuild, missing, or the metadata JSON is
    // newer than the HTML (common case — you just ran capture-profile.js
    // --comments-only but forgot --rebuild).
    const metaPath = path.join(POSTS_META_DIR, `${postId}.json`);
    const metaMtime = fs.statSync(metaPath).mtimeMs;
    const htmlMtime = fs.existsSync(htmlDest) ? fs.statSync(htmlDest).mtimeMs : 0;
    if (REBUILD || !fs.existsSync(htmlDest) || metaMtime > htmlMtime) {
      fs.writeFileSync(
        htmlDest,
        postPageHtml(post, profile, comments, videoRel, thumbRel, castForPost)
      );
    }

    processed.push({
      post,
      thumbRel: thumbRel ? `posts/${postId}/thumbnail.jpg` : '',
      cast: castForGrid,
    });

    if (didDownload) {
      downloaded++;
      currentStatus = `${postId} OK`;
    } else {
      skipped++;
      currentStatus = `${postId} (cached)`;
    }
    renderUI();

    if (didDownload && !stopping) await rateDelay();
  }

  // Profile index + CSS (always refresh)
  fs.writeFileSync(path.join(OUT_DIR, 'style.css'), CSS);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), profilePageHtml(profile, processed));

  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const pendingComments = entries.filter(e => e.comments?._pending).length;

  const finalMsg = stopping
    ? `Stopped. Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`
    : `Complete! Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`;
  log(finalMsg);
  console.clear();
  console.log(`\n  ${finalMsg}`);
  console.log(`  Archive: ${path.join(OUT_DIR, 'index.html')}`);
  console.log(`  Log: ${LOG_FILE}`);
  if (pendingComments > 0) {
    console.log(`\n  ⚠  ${pendingComments} post(s) still have pending comments.`);
    console.log(`     Run: node capture-profile.js --comments-only --username ${USERNAME}`);
    console.log(`     Then rerun: node build-archive.js --rebuild --username ${USERNAME}`);
  }
  console.log('');

  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
