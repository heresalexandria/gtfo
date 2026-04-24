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

const OUT_DIR          = path.join(ROOT, USERNAME);
const POSTS_META_DIR   = path.join(OUT_DIR, '_posts');
const POSTS_DIR        = path.join(OUT_DIR, 'posts');
const CASTINS_META_DIR = path.join(OUT_DIR, '_cast_ins');
const CASTINS_DIR      = path.join(OUT_DIR, 'cast_ins');
const DRAFTS_DIR       = path.join(OUT_DIR, 'drafts');
const ASSETS_DIR       = path.join(OUT_DIR, 'assets');
const AVATARS_DIR      = path.join(ASSETS_DIR, 'avatars');
const LOGS_DIR         = path.join(OUT_DIR, 'logs');
const LOG_FILE         = path.join(LOGS_DIR, 'build.log');
const PROFILE_FILE     = path.join(OUT_DIR, 'profile.json');

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

// Draft cameos live on creation_config.cameo_profiles with the same shape.
function extractDraftCast(draft, posterUserId) {
  return extractCast({ cameo_profiles: draft?.creation_config?.cameo_profiles || [] }, posterUserId);
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

/**
 * Decode a Sora draft/generation ID to its creation unix-seconds timestamp.
 *
 * Two observed formats:
 *   - `gen_01k...` : `gen_` prefix + Crockford base32 ULID. The first 10
 *     base32 chars encode milliseconds since epoch.
 *   - 32-char hex  : the first 4 bytes (8 hex chars) are a unix-seconds
 *     timestamp. Older drafts use this raw form; newer ones also appear as
 *     `gen_<hex>` which we also handle.
 *
 * Returns 0 if we can't decode.
 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function idToTimestamp(id) {
  if (!id) return 0;
  const body = id.startsWith('gen_') ? id.slice(4) : id;

  // 32-char hex: first 8 hex chars = unix seconds.
  if (/^[a-f0-9]{32}$/i.test(body)) {
    const secs = parseInt(body.slice(0, 8), 16);
    return Number.isFinite(secs) && secs > 1_000_000_000 ? secs : 0;
  }

  // ULID (26-char Crockford base32). First 10 chars = milliseconds.
  if (/^[0-9a-z]{26}$/i.test(body)) {
    let ms = 0;
    const head = body.slice(0, 10).toUpperCase();
    for (const ch of head) {
      const v = ULID_ALPHABET.indexOf(ch);
      if (v < 0) return 0;
      ms = ms * 32 + v;
    }
    return Math.floor(ms / 1000);
  }

  return 0;
}

function formatDraftDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

.tabs {
  display: flex; gap: 8px;
  max-width: 1200px; margin: 0 auto; padding: 16px 24px 0;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  background: transparent; color: var(--muted);
  border: none; border-bottom: 2px solid transparent;
  padding: 10px 12px; font: inherit; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.tab-btn:hover { color: var(--fg); }
.tab-btn.active { color: var(--fg); border-bottom-color: var(--fg); }
.tab-btn.empty { color: #555; }
.tab-btn .tab-count {
  background: var(--border); color: var(--muted);
  border-radius: 10px; padding: 1px 8px; font-size: 11px;
}
.tab-btn.active .tab-count { background: #333; color: var(--fg); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

.poster-badge {
  display: inline-block; font-size: 11px; color: var(--muted);
  background: #222; padding: 2px 6px; border-radius: 4px;
  margin-bottom: 4px;
}
.poster-link { color: var(--fg); text-decoration: underline; text-decoration-color: var(--border); }

.controls {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  max-width: 1200px; margin: 0 auto; padding: 16px 24px 0;
}
.controls input[type="search"] {
  flex: 1; min-width: 200px;
  background: var(--card); color: var(--fg);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; font: inherit;
}
.controls input[type="search"]:focus { outline: none; border-color: #555; }
.controls select {
  background: var(--card); color: var(--fg);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; font: inherit; cursor: pointer;
}
.controls .count { color: var(--muted); font-size: 13px; }
.no-results {
  max-width: 1200px; margin: 40px auto; padding: 24px;
  text-align: center; color: var(--muted);
}

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

.drafts-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.draft-card .meta { padding: 10px 12px 12px; }
.draft-card .caption {
  font-size: 12.5px; line-height: 1.4; color: var(--fg);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 52px; margin-bottom: 6px;
}
.draft-card .draft-footer {
  display: flex; justify-content: space-between; align-items: baseline;
  color: var(--muted); font-size: 11px; margin-top: 4px;
}
.draft-card .draft-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
/* Hint the browser to skip rendering work for off-screen draft cards. */
.draft-card { content-visibility: auto; contain-intrinsic-size: 440px; }
.drafts-sentinel { grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--muted); font-size: 12px; }
.drafts-sentinel[hidden] { display: none; }
.draft-page .draft-prompt { white-space: pre-wrap; font-size: 15px; font-weight: 400; }
.draft-page .draft-badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.draft-page .badge {
  background: var(--bg); border: 1px solid var(--border); color: var(--muted);
  padding: 3px 10px; border-radius: 999px; font-size: 11px;
}
.draft-page .draft-details { color: var(--muted); font-size: 12px; line-height: 1.7; }
.draft-page .draft-details code { font-size: 12px; color: var(--fg); word-break: break-all; }
.draft-page .draft-details .muted { color: var(--muted); }
.draft-page .draft-source-link { display: inline-block; margin-top: 8px; color: var(--muted); font-size: 11px; text-decoration: underline; text-decoration-color: var(--border); word-break: break-all; }

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

function profilePageHtml(profile, postsProcessed, castinsProcessed, draftsProcessed) {
  const title = `@${profile.username} · Sora archive`;

  // For drafts we emit a compact JSON record instead of a big HTML string.
  // The client-side virtualized renderer (in the inline <script> below) turns
  // ~120 records at a time into DOM nodes — the full 13k+ index never lives in
  // the DOM at once. Keeps memory and layout work bounded.
  //
  // Schema (short keys to minimize inline JSON size):
  //   i: id, t: created_at unix seconds, p: prompt (capped),
  //   d: duration seconds, h: 1 if local thumbnail exists,
  //   c: [{u: username, n: display_name, a: local-avatar-path-or-empty}]
  const PROMPT_CAP = 1200;  // cap per-card prompt in the search index
  function compactDraft({ id, timestamp, draft, cast, hasThumb }) {
    const prompt = draft?.prompt || draft?.creation_config?.prompt || '';
    const out = { i: id, t: timestamp || 0 };
    if (prompt) out.p = prompt.length > PROMPT_CAP ? prompt.slice(0, PROMPT_CAP) : prompt;
    if (draft?.duration_s) out.d = Math.round(draft.duration_s * 10) / 10;
    if (hasThumb) out.h = 1;
    if (cast && cast.length) {
      out.c = cast.map(c => {
        const entry = { u: c.username || '' };
        if (c.display_name) entry.n = c.display_name;
        if (c.avatarRel) entry.a = c.avatarRel;
        else if (c.profile_picture_url) entry.a = c.profile_picture_url;
        return entry;
      });
    }
    return out;
  }

  function renderCard({ post, thumbRel, cast, postAuthor }, kind) {
    const att = post.attachments?.[0];
    const duration = att?.duration_s ? `${att.duration_s.toFixed(1)}s` : '';
    const castList = cast || [];
    const isCastIn = kind === 'castins';
    const author = postAuthor || profile;

    const castTeaser = castList.length
      ? `<div class="cast-teaser" title="${escapeHtml(castList.map(c => '@' + c.username).join(', '))}">
           <span class="avatars">${castList.slice(0, 3).map(c =>
             `<img loading="lazy" src="${escapeHtml(c.avatarRel || c.profile_picture_url || '')}" alt="" onerror="this.style.display='none'">`
           ).join('')}</span>
           <span>cast ${castList.length}</span>
         </div>`
      : '';

    // On cast-in cards, call out the poster instead of a cast teaser.
    const posterBadge = isCastIn
      ? `<div class="poster-badge" title="Posted by @${escapeHtml(author.username)}">by @${escapeHtml(author.username)}</div>`
      : '';

    // Haystack: caption + author handle + cast handles/names.
    const searchBits = [
      post.text || '',
      isCastIn ? '@' + (author.username || '') : '',
      isCastIn ? (author.display_name || '') : '',
      ...castList.map(c => '@' + (c.username || '')),
      ...castList.map(c => c.display_name || ''),
    ].filter(Boolean).join(' ').toLowerCase();

    const dir = isCastIn ? 'cast_ins' : 'posts';
    return `
      <a class="card"
         href="${dir}/${encodeURIComponent(post.id)}/index.html"
         data-search="${escapeHtml(searchBits)}"
         data-posted="${post.posted_at || 0}"
         data-likes="${post.like_count || 0}"
         data-comments="${post.reply_count || 0}"
         data-views="${post.view_count || 0}">
        <div class="thumb">
          ${thumbRel ? `<img loading="lazy" src="${escapeHtml(thumbRel)}" alt="">` : ''}
          ${duration ? `<span class="dur">${escapeHtml(duration)}</span>` : ''}
        </div>
        <div class="meta">
          ${posterBadge}
          <div class="caption">${escapeHtml((post.text || '').slice(0, 140))}</div>
          <div class="stats">
            <span title="Views">▶ ${formatNum(post.view_count || 0)}</span>
            <span title="Likes">♥ ${formatNum(post.like_count || 0)}</span>
            <span title="Replies">💬 ${formatNum(post.reply_count || 0)}</span>
          </div>
          ${castTeaser}
        </div>
      </a>`;
  }

  const postsCards   = postsProcessed.map(p => renderCard(p, 'posts')).join('\n');
  const castinsCards = castinsProcessed.map(p => renderCard(p, 'castins')).join('\n');
  // Drafts: no per-card HTML at build time. Just a compact JSON index that
  // the inline script below renders into DOM 120 cards at a time.
  const draftsIndexJson = JSON.stringify(draftsProcessed.map(compactDraft));

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
    <div class="archived">Archived ${escapeHtml(new Date().toLocaleString())} · ${postsProcessed.length} posts · ${castinsProcessed.length} cast-ins · ${draftsProcessed.length} drafts</div>
  </div>
</header>
<nav class="tabs">
  <button class="tab-btn active" data-tab="posts" type="button">Posts <span class="tab-count">${postsProcessed.length}</span></button>
  <button class="tab-btn${castinsProcessed.length ? '' : ' empty'}" data-tab="castins" type="button">Cast in <span class="tab-count">${castinsProcessed.length}</span></button>
  <button class="tab-btn${draftsProcessed.length ? '' : ' empty'}" data-tab="drafts" type="button">Drafts <span class="tab-count">${draftsProcessed.length}</span></button>
</nav>
<div class="controls">
  <input type="search" id="q" placeholder="Search description or @cast...">
  <select id="sort">
    <option value="newest">Newest first</option>
    <option value="oldest">Oldest first</option>
    <option value="likes">Most liked</option>
    <option value="comments">Most commented</option>
    <option value="views">Most viewed</option>
  </select>
  <span class="count" id="count"></span>
</div>
<main class="tab-panel active" data-tab="posts">
  <div class="grid">
${postsCards}
  </div>
</main>
<main class="tab-panel" data-tab="castins" hidden>
  ${castinsProcessed.length
    ? `<div class="grid">${castinsCards}</div>`
    : `<div class="no-results">No cast-ins captured yet. Run <code>node capture-cast-ins.js --username ${escapeHtml(profile.username)}</code>.</div>`}
</main>
<main class="tab-panel" data-tab="drafts" hidden>
  ${draftsProcessed.length
    ? `<div class="grid drafts-grid" id="drafts-grid"></div>
       <div class="drafts-sentinel" id="drafts-sentinel">Loading more drafts…</div>
       <script type="application/json" id="drafts-index">${draftsIndexJson.replace(/</g, '\\u003c')}</script>`
    : `<div class="no-results">No drafts captured yet. Run <code>node capture-drafts.js --username ${escapeHtml(profile.username)}</code> then <code>node download-drafts.js --username ${escapeHtml(profile.username)}</code> then <code>node thumbnail-drafts.js --username ${escapeHtml(profile.username)}</code>.</div>`}
</main>
<div class="no-results" id="no-results" hidden>No items match your search.</div>
<script>
(() => {
  const q = document.getElementById('q');
  const sort = document.getElementById('sort');
  const count = document.getElementById('count');
  const noResults = document.getElementById('no-results');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels  = Array.from(document.querySelectorAll('.tab-panel'));

  function activeTab() {
    return tabButtons.find(b => b.classList.contains('active'))?.dataset.tab || 'posts';
  }
  function activePanel() {
    return tabPanels.find(p => p.dataset.tab === activeTab());
  }

  // ── Drafts: virtualized renderer ──────────────────────────────
  // Posts/cast-ins stay DOM-based (they're small, 2K cards). Drafts use an
  // in-memory JSON index + batched incremental render to keep the DOM under
  // ~500 nodes even with 10K+ drafts.
  const DRAFTS_BATCH = 120;
  const DRAFTS = (() => {
    const tag = document.getElementById('drafts-index');
    if (!tag) return [];
    let arr = [];
    try { arr = JSON.parse(tag.textContent); } catch { return []; }
    // Pre-lowercase + pre-join the search haystack per draft so keystroke
    // latency isn't O(N × prompt-length × toLowerCase).
    for (const d of arr) {
      let s = (d.i || '').toLowerCase();
      if (d.p) s += ' ' + d.p.toLowerCase();
      if (d.c) for (const c of d.c) {
        if (c.u) s += ' @' + c.u.toLowerCase();
        if (c.n) s += ' ' + c.n.toLowerCase();
      }
      if (d.t) s += ' ' + new Date(d.t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).toLowerCase();
      d._s = s;
    }
    return arr;
  })();
  let draftsFiltered = DRAFTS;   // current filter result
  let draftsRendered = 0;        // how many of draftsFiltered are in the DOM
  const draftsGrid = document.getElementById('drafts-grid');
  const draftsSentinel = document.getElementById('drafts-sentinel');

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDraftDate(t) {
    if (!t) return '';
    return new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function shortId(id) {
    return (id.startsWith('gen_') ? id.slice(4) : id).slice(0, 8);
  }
  function draftCardHtml(d) {
    const prompt = d.p || '';
    const displayPrompt = prompt ? (prompt.length > 180 ? prompt.slice(0, 180) : prompt) : '(no prompt captured)';
    const dur = d.d ? d.d.toFixed(1) + 's' : '';
    const cast = d.c || [];
    const castTeaser = cast.length
      ? '<div class="cast-teaser" title="' + esc(cast.map(c => '@' + c.u).join(', ')) + '">'
        + '<span class="avatars">'
        + cast.slice(0, 3).map(c => '<img loading="lazy" src="' + esc(c.a || '') + '" alt="" onerror="this.style.display=\\'none\\'">').join('')
        + '</span><span>cast ' + cast.length + '</span></div>'
      : '';
    return '<a class="card draft-card" href="drafts/' + encodeURIComponent(d.i) + '/index.html">'
      +   '<div class="thumb">'
      +     (d.h ? '<img loading="lazy" src="drafts/' + encodeURIComponent(d.i) + '/thumbnail.jpg" alt="" onerror="this.style.display=\\'none\\'">' : '')
      +     (dur ? '<span class="dur">' + esc(dur) + '</span>' : '')
      +   '</div>'
      +   '<div class="meta">'
      +     '<div class="caption">' + esc(displayPrompt) + '</div>'
      +     '<div class="draft-footer"><span class="draft-date">' + esc(fmtDraftDate(d.t) || '—') + '</span><span class="draft-id" title="' + esc(d.i) + '">#' + esc(shortId(d.i)) + '</span></div>'
      +     castTeaser
      +   '</div>'
      + '</a>';
  }

  function renderNextDraftsBatch() {
    if (!draftsGrid) return;
    const end = Math.min(draftsRendered + DRAFTS_BATCH, draftsFiltered.length);
    if (end === draftsRendered) { if (draftsSentinel) draftsSentinel.hidden = true; return; }
    const chunks = [];
    for (let i = draftsRendered; i < end; i++) chunks.push(draftCardHtml(draftsFiltered[i]));
    draftsGrid.insertAdjacentHTML('beforeend', chunks.join(''));
    draftsRendered = end;
    if (draftsSentinel) {
      if (draftsRendered >= draftsFiltered.length) {
        draftsSentinel.hidden = true;
        draftsSentinel.textContent = '';
      } else {
        draftsSentinel.hidden = false;
        draftsSentinel.textContent = 'Loading more drafts…';
      }
    }
  }

  function resetDraftsRender() {
    if (!draftsGrid) return;
    draftsGrid.innerHTML = '';
    draftsRendered = 0;
    if (draftsSentinel) draftsSentinel.hidden = false;
    if (activeTab() === 'drafts') fillDraftsViewport();
  }

  // Render one batch per animation frame while the sentinel is still near
  // the viewport. Rendering synchronously in a tight loop (120 cards × many
  // batches) blocks the main thread for seconds — spreading one batch per
  // rAF keeps per-frame work under ~20ms even when a search drops 10k cards
  // and the user is scrolled to the bottom.
  function fillDraftsViewport() {
    if (!draftsSentinel || activeTab() !== 'drafts') return;
    if (draftsRendered >= draftsFiltered.length) return;
    const rect = draftsSentinel.getBoundingClientRect();
    // Lookahead: render if sentinel is anywhere within the viewport + 1500px
    // of buffer below it. Otherwise do nothing — next scroll will re-check.
    if (rect.top > window.innerHeight + 1500) return;
    renderNextDraftsBatch();
    // Still below threshold? Queue another frame.
    if (draftsRendered < draftsFiltered.length) {
      const r2 = draftsSentinel.getBoundingClientRect();
      if (r2.top <= window.innerHeight + 1500) requestAnimationFrame(fillDraftsViewport);
    }
  }

  function applyDrafts() {
    const query = q.value.trim().toLowerCase();
    const mode = sort.value;
    const total = DRAFTS.length;
    let list = DRAFTS;
    if (query) list = list.filter(d => d._s && d._s.indexOf(query) !== -1);
    // Drafts don't have likes/comments/views — those modes fall back to newest.
    const asc = mode === 'oldest';
    list = list.slice().sort((a, b) => asc ? (a.t || 0) - (b.t || 0) : (b.t || 0) - (a.t || 0));
    draftsFiltered = list;
    resetDraftsRender();
    const visible = list.length;
    count.textContent = query ? visible + ' of ' + total + ' drafts' : total + ' drafts';
    noResults.hidden = visible > 0 || total === 0;
  }

  // Keep the drafts grid topped up via two independent triggers:
  //  (a) IntersectionObserver on the sentinel (primary; fires on scroll, on
  //      visibility change, and after layout changes)
  //  (b) scroll + resize listeners (secondary; covers environments where
  //      the IO doesn't fire on a tab that started hidden)
  // Both call fillDraftsViewport, which is idempotent and cheap when there's
  // nothing to do.
  let fillPending = false;
  function scheduleFill() {
    if (fillPending) return;
    fillPending = true;
    requestAnimationFrame(() => { fillPending = false; fillDraftsViewport(); });
  }
  if (draftsSentinel && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) scheduleFill();
    }, { rootMargin: '1500px 0px' }).observe(draftsSentinel);
  }
  window.addEventListener('scroll', scheduleFill, { passive: true });
  window.addEventListener('resize', scheduleFill, { passive: true });
  // Clicking the sentinel also loads more — fallback for any env where scroll
  // events don't propagate (and convenient "Load more" for users who prefer it).
  if (draftsSentinel) {
    draftsSentinel.style.cursor = 'pointer';
    draftsSentinel.addEventListener('click', () => fillDraftsViewport());
  }
  // Test hook — lets automation verify the render pipeline without relying
  // on scroll events that CDP doesn't always dispatch.
  window.__drafts = { fill: fillDraftsViewport };

  // ── Posts / cast-ins: DOM-based filter+sort (small enough) ────
  function applyDomTab() {
    const panel = activePanel();
    if (!panel) return;
    const grid = panel.querySelector('.grid');
    if (!grid) { count.textContent = '0 items'; noResults.hidden = true; return; }
    const cards = Array.from(grid.querySelectorAll('.card'));
    const total = cards.length;
    const query = q.value.trim().toLowerCase();
    const mode = sort.value;
    let visible = 0;
    for (const c of cards) {
      const match = !query || (c.dataset.search && c.dataset.search.includes(query));
      c.style.display = match ? '' : 'none';
      if (match) visible++;
    }
    const sortKeys = { likes: 'likes', comments: 'comments', views: 'views' };
    const sortable = cards.slice().sort((a, b) => {
      if (mode === 'oldest') return (+a.dataset.posted) - (+b.dataset.posted);
      if (mode === 'newest') return (+b.dataset.posted) - (+a.dataset.posted);
      const k = sortKeys[mode];
      return (+b.dataset[k]) - (+a.dataset[k]);
    });
    for (const c of sortable) grid.appendChild(c);
    const labelByTab = { posts: 'posts', castins: 'cast-ins' };
    const label = labelByTab[activeTab()] || 'items';
    count.textContent = query ? visible + ' of ' + total : total + ' ' + label;
    noResults.hidden = visible > 0 || total === 0;
  }

  function apply() {
    if (activeTab() === 'drafts') applyDrafts();
    else applyDomTab();
  }

  function setTab(name) {
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPanels.forEach(p => {
      const match = p.dataset.tab === name;
      p.classList.toggle('active', match);
      p.hidden = !match;
    });
    apply();
    // After the drafts panel becomes visible, layout recomputes. Top up so
    // the sentinel isn't already in view without more cards loaded.
    if (name === 'drafts') requestAnimationFrame(fillDraftsViewport);
    syncHash();
  }

  // Debounced apply for the search input. Sort + tab-switch stay immediate.
  // Drafts filter iterates 13k records; typing fast would otherwise re-run on
  // every keystroke. Posts/cast-ins are small enough that this is invisible.
  let searchTimer = null;
  function scheduleApply() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; apply(); }, 120);
  }
  tabButtons.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  q.addEventListener('input', scheduleApply);
  sort.addEventListener('change', apply);

  // Restore state from URL hash (e.g. #tab=drafts&q=2025&sort=oldest)
  const validTabs = ['posts', 'castins', 'drafts'];
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('tab') && validTabs.includes(params.get('tab'))) {
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === params.get('tab')));
    tabPanels.forEach(p => {
      const match = p.dataset.tab === params.get('tab');
      p.classList.toggle('active', match);
      p.hidden = !match;
    });
  }
  if (params.has('q')) q.value = params.get('q');
  if (params.has('sort')) sort.value = params.get('sort');
  apply();

  function syncHash() {
    const p = new URLSearchParams();
    if (activeTab() !== 'posts') p.set('tab', activeTab());
    if (q.value) p.set('q', q.value);
    if (sort.value && sort.value !== 'newest') p.set('sort', sort.value);
    history.replaceState(null, '', p.toString() ? '#' + p.toString() : location.pathname);
  }
  q.addEventListener('input', syncHash);
  sort.addEventListener('change', syncHash);
})();
</script>
</body>
</html>`;
}

function draftPageHtml(id, timestamp, draft, ownerProfile, cast, hasVideo, hasThumb) {
  const prompt     = draft?.prompt || draft?.creation_config?.prompt || '';
  const duration   = draft?.duration_s;
  const orientation = draft?.creation_config?.orientation;
  const n_frames   = draft?.creation_config?.n_frames;
  const style      = draft?.creation_config?.style;
  const w          = draft?.width;
  const h          = draft?.height;
  const generationType = draft?.generation_type;
  const hasChildren = draft?.has_children;
  const storyboardId = draft?.creation_config?.storyboard_id || draft?.storyboard_id;
  const remixTarget  = draft?.creation_config?.remix_target_post;
  const taskId       = draft?.task_id;

  const badges = [
    duration ? `${duration.toFixed(1)}s` : null,
    (w && h) ? `${w}×${h}` : null,
    orientation || null,
    n_frames ? `${n_frames} frames` : null,
    style || null,
    generationType && generationType !== 'video_gen' ? generationType : null,
    hasChildren ? 'has children' : null,
    storyboardId ? 'storyboard' : null,
    remixTarget ? 'remix' : null,
  ].filter(Boolean);

  const dateStr = formatDraftDate(timestamp);
  const fullDate = timestamp ? new Date(timestamp * 1000).toISOString() : '';

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

  const videoBlock = hasVideo
    ? `<div class="video-wrap">
         <video controls ${hasThumb ? `poster="thumbnail.jpg"` : ''} playsinline>
           <source src="video.mp4" type="video/mp4">
         </video>
       </div>`
    : `<div class="no-video">Video not downloaded locally.${taskId ? ` Task: ${escapeHtml(taskId)}` : ''}</div>`;

  const promptBlock = prompt
    ? `<h1 class="caption draft-prompt">${escapeHtml(prompt)}</h1>`
    : `<h1 class="caption"><em>(no prompt captured — run <code>backfill-prompts.js</code>)</em></h1>`;

  const sourcePath = draft?.encodings?.source?.path;
  const rawLink = sourcePath
    ? `<a class="draft-source-link" href="${escapeHtml(sourcePath)}" target="_blank" rel="noopener">original signed source ↗</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(prompt.slice(0, 60) || 'Draft ' + id.slice(0, 16))} · @${escapeHtml(ownerProfile.username)}</title>
<link rel="stylesheet" href="../../style.css">
</head>
<body class="post-page draft-page">
<nav><a href="../../index.html#tab=drafts">← @${escapeHtml(ownerProfile.username)} / drafts</a></nav>
<article>
  ${videoBlock}
  <div class="post-meta">
    ${promptBlock}
    ${badges.length ? `<div class="draft-badges">${badges.map(b => `<span class="badge">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
    <div class="draft-details">
      <div><span class="muted">ID:</span> <code>${escapeHtml(id)}</code></div>
      ${dateStr ? `<div><span class="muted">Created:</span> ${escapeHtml(dateStr)}${fullDate ? ` <span class="muted" title="${escapeHtml(fullDate)}">(${escapeHtml(fullDate)})</span>` : ''}</div>` : ''}
      ${rawLink}
    </div>
  </div>
  ${castHtml}
</article>
</body>
</html>`;
}

function postPageHtml(post, ownerProfile, commentsObj, videoRel, thumbRel, cast, postAuthor, kind) {
  const caption = post.text || '';
  const posted = formatDate(post.posted_at);
  const comments = commentsObj?.items || [];
  const isPending = !!commentsObj?._pending;
  const lastError = commentsObj?._lastError;
  const author = postAuthor || ownerProfile;
  const isOwnPost = author?.user_id === ownerProfile?.user_id;
  const indexHash = kind === 'castins' ? '#tab=castins' : '';
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
<title>${escapeHtml(caption.slice(0, 60) || post.id)} · @${escapeHtml(ownerProfile.username)}</title>
<link rel="stylesheet" href="../../style.css">
</head>
<body class="post-page">
<nav><a href="../../index.html${indexHash}">← @${escapeHtml(ownerProfile.username)}${kind === 'castins' ? ' / cast in' : ''}</a></nav>
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
    <div class="posted">
      Posted ${escapeHtml(posted)}${isOwnPost ? '' : ` by <a class="poster-link" href="${escapeHtml(author?.permalink || '#')}" target="_blank" rel="noopener">@${escapeHtml(author?.username || 'unknown')}</a>`}
    </div>
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

  // Load both captured data sets, sorted newest → oldest.
  function loadEntries(metaDir) {
    if (!fs.existsSync(metaDir)) return [];
    return fs.readdirSync(metaDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8')))
      .sort((a, b) => (b.post?.posted_at || 0) - (a.post?.posted_at || 0));
  }
  const postsEntries   = loadEntries(POSTS_META_DIR);
  const castinsEntries = loadEntries(CASTINS_META_DIR);
  totalPosts = postsEntries.length + castinsEntries.length;

  // Load drafts early so the avatar pre-pass below can include their cameos.
  // Include any draft folder that has a video OR draft.json — both are valid
  // "we know something about this draft" states.
  function loadDraftEntries(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const id of fs.readdirSync(dir)) {
      const idDir     = path.join(dir, id);
      if (!fs.statSync(idDir).isDirectory()) continue;
      const videoPath = path.join(idDir, 'video.mp4');
      const thumbPath = path.join(idDir, 'thumbnail.jpg');
      const jsonPath  = path.join(idDir, 'draft.json');
      const hasVideo = fs.existsSync(videoPath) && fs.statSync(videoPath).size > MIN_FILE_KB * 1024;
      const hasThumb = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
      const hasJson  = fs.existsSync(jsonPath);
      if (!hasVideo && !hasJson) continue;
      let draft = null;
      if (hasJson) {
        try { draft = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
        catch (e) { log(`bad draft.json for ${id}: ${e.message}`); }
      }
      // Prefer API's created_at (precise seconds) over ID-decoded timestamp.
      const timestamp = draft?.created_at
        ? Math.floor(draft.created_at)
        : idToTimestamp(id);
      out.push({ id, draft, timestamp, hasVideo, hasThumb });
    }
    return out;
  }
  const draftsEntries = loadDraftEntries(DRAFTS_DIR);
  const hasDrafts = draftsEntries.length > 0;
  if (totalPosts === 0 && !hasDrafts) {
    console.error(`No captured data found in ${POSTS_META_DIR}, ${CASTINS_META_DIR}, or ${DRAFTS_DIR}.`);
    console.error(`Run capture-profile.js --username ${USERNAME} first (and/or capture-cast-ins.js / capture-drafts.js).`);
    process.exit(1);
  }

  log(`--- Session started. Posts: ${postsEntries.length}  Cast-ins: ${castinsEntries.length}  Drafts: ${draftsEntries.length}  rebuild=${REBUILD} ---`);
  setupKeyboard();

  // ── Avatar pre-pass: download unique cast-member avatars ──────
  // Include cast members from BOTH posts and cast-ins, plus the poster
  // profiles of cast-ins (so their attribution badge can show a local avatar
  // too — useful when Sora sunsets and the signed URLs expire).
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const uniqueCast = new Map();  // user_id -> { url, username }
  function noteAvatar(uid, url, username) {
    if (uid && url && !uniqueCast.has(uid)) uniqueCast.set(uid, { url, username });
  }
  for (const entry of [...postsEntries, ...castinsEntries]) {
    for (const c of extractCast(entry.post, profile.user_id)) {
      noteAvatar(c.user_id, c.profile_picture_url, c.username);
    }
  }
  for (const entry of castinsEntries) {
    const p = entry.profile;
    if (p) noteAvatar(p.user_id, p.profile_picture_url, p.username);
  }
  for (const entry of draftsEntries) {
    if (!entry.draft) continue;
    for (const c of extractDraftCast(entry.draft, profile.user_id)) {
      noteAvatar(c.user_id, c.profile_picture_url, c.username);
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

  // Process either the posts set or the cast-ins set; returns an array of
  // {post, thumbRel, cast, postAuthor} suitable for the profile grid.
  async function processEntries({ entries, kind, metaDir, outDir }) {
    const processed = [];
    for (const entry of entries) {
      if (stopping) return processed;
      await waitWhilePaused();
      if (stopping) return processed;

      const { post, profile: postAuthor, comments } = entry;
      const postId = post.id;
      const postDir = path.join(outDir, postId);
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
          currentStatus = `downloading video ${postId} (${kind})`;
          renderUI();
          const res = await downloadWithRetries(url, videoDest);
          if (res.ok) {
            log(`OK video ${kind} ${postId} (${Math.round(res.size / 1024)} KB)`);
            didDownload = true;
          } else {
            log(`FAILED video ${kind} ${postId}`);
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

      // Regenerate HTML if forced, missing, or the metadata JSON is newer.
      const metaPath = path.join(metaDir, `${postId}.json`);
      const metaMtime = fs.statSync(metaPath).mtimeMs;
      const htmlMtime = fs.existsSync(htmlDest) ? fs.statSync(htmlDest).mtimeMs : 0;
      if (REBUILD || !fs.existsSync(htmlDest) || metaMtime > htmlMtime) {
        fs.writeFileSync(
          htmlDest,
          postPageHtml(post, profile, comments, videoRel, thumbRel, castForPost, postAuthor, kind)
        );
      }

      const dir = kind === 'castins' ? 'cast_ins' : 'posts';
      processed.push({
        post,
        thumbRel: thumbRel ? `${dir}/${postId}/thumbnail.jpg` : '',
        cast: castForGrid,
        postAuthor,
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
    return processed;
  }

  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.mkdirSync(CASTINS_DIR, { recursive: true });

  const postsProcessed   = await processEntries({ entries: postsEntries,   kind: 'posts',   metaDir: POSTS_META_DIR,   outDir: POSTS_DIR });
  const castinsProcessed = stopping ? [] : await processEntries({ entries: castinsEntries, kind: 'castins', metaDir: CASTINS_META_DIR, outDir: CASTINS_DIR });

  // Drafts: videos/thumbnails come from the dedicated scripts, metadata from
  // backfill-prompts.js. Here we regenerate each draft's index.html and build
  // the grid entries. No network work.
  const draftsProcessed = [];
  if (!stopping && draftsEntries.length > 0) {
    currentStatus = 'building draft pages...';
    renderUI();
    for (const entry of draftsEntries) {
      const { id, draft, timestamp, hasVideo, hasThumb } = entry;
      const rawCast = draft ? extractDraftCast(draft, profile.user_id) : [];
      const castForPage = attachAvatars(rawCast, '../../');
      const castForGrid = attachAvatars(rawCast, '');

      const htmlDest = path.join(DRAFTS_DIR, id, 'index.html');
      const jsonPath = path.join(DRAFTS_DIR, id, 'draft.json');
      // Rebuild HTML if forced, missing, or the draft.json is newer than it.
      const jsonMtime = fs.existsSync(jsonPath) ? fs.statSync(jsonPath).mtimeMs : 0;
      const htmlMtime = fs.existsSync(htmlDest) ? fs.statSync(htmlDest).mtimeMs : 0;
      if (REBUILD || !fs.existsSync(htmlDest) || jsonMtime > htmlMtime) {
        fs.writeFileSync(
          htmlDest,
          draftPageHtml(id, timestamp, draft, profile, castForPage, hasVideo, hasThumb)
        );
      }

      draftsProcessed.push({ id, timestamp, draft, cast: castForGrid, hasThumb });
    }
    // Newest first.
    draftsProcessed.sort((a, b) => b.timestamp - a.timestamp);
    log(`Drafts: ${draftsProcessed.length} indexed (${draftsProcessed.filter(d => d.draft).length} with metadata)`);
  }

  // Profile index + CSS (always refresh)
  fs.writeFileSync(path.join(OUT_DIR, 'style.css'), CSS);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), profilePageHtml(profile, postsProcessed, castinsProcessed, draftsProcessed));

  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const pendingPosts   = postsEntries.filter(e => e.comments?._pending).length;
  const pendingCastins = castinsEntries.filter(e => e.comments?._pending).length;

  const finalMsg = stopping
    ? `Stopped. Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`
    : `Complete! Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`;
  log(finalMsg);
  console.clear();
  console.log(`\n  ${finalMsg}`);
  console.log(`  Archive: ${path.join(OUT_DIR, 'index.html')}`);
  console.log(`  Log: ${LOG_FILE}`);
  if (pendingPosts > 0) {
    console.log(`\n  ⚠  ${pendingPosts} post(s) still have pending comments.`);
    console.log(`     Run: node capture-profile.js --comments-only --username ${USERNAME}`);
  }
  if (pendingCastins > 0) {
    console.log(`\n  ⚠  ${pendingCastins} cast-in(s) still have pending comments.`);
    console.log(`     Run: node capture-cast-ins.js --comments-only --username ${USERNAME}`);
  }
  if (pendingPosts > 0 || pendingCastins > 0) {
    console.log(`     Then rerun: node build-archive.js --username ${USERNAME} (auto-rebuilds stale pages)`);
  }
  console.log('');

  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
