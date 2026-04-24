# Get Those Files Out - Sora exporter

*Based on work in the [sora-creator-tools](https://github.com/fancyson-ai/sora-creator-tools/) extension by the amazing [thecosmicskye](https://github.com/thecosmicskye), [cameoed](https://github.com/cameoed), [dblunk88](https://github.com/dblunk88), [fancyson-ai](https://github.com/fancyson-ai), [chrisbelson](https://github.com/chrisbelson), [lgcarrier](https://github.com/lgcarrier), [travisfischer](https://github.com/travisfischer), and [possum-kingdom](https://github.com/possum-kingdom) 🙌*

---

Export your content from [Sora](https://sora.chatgpt.com) before the service sunsets with configurable rate limiting, pause/resume, and deduplication handling.

![Demo](./demo.jpg)

Two flows:

**Drafts** (unposted generations)

1. **`capture-drafts.js`** -- Opens Chrome via Playwright, scrolls through your drafts page, and intercepts API responses to collect video download URLs.
2. **`download-drafts.js`** -- Reads the collected URLs and downloads each video with retry logic, rate limiting, and an interactive TUI.

**Profile** (posted videos, with descriptions, engagement, comments, and cast-ins — rendered as a browsable local HTML archive)

1. **`capture-profile.js`** -- Opens Chrome via Playwright, scrolls your profile page to collect post metadata from intercepted API responses (including `cameo_profiles`, the structured cast list), then fetches each post's comment tree via API with Retry-After-aware exponential backoff.
2. **`capture-cast-ins.js`** -- Same flow, but clicks the "Cast in" tab first and intercepts the `cut=appearances` feed — captures posts authored by other users where you were cast. Separate metadata dir (`_cast_ins/`) so the two sets don't collide.
3. **`build-archive.js`** -- Reads both captured metadata sets, downloads each video + thumbnail + cast-member avatars, and generates a browsable local HTML archive with a Posts / Cast-in tab switcher, per-tab search, and per-tab sort.
4. **`backfill-cast.js`** -- Refreshes the `post` object (including `cameo_profiles`) for already-captured posts. Use this if an older capture predates cast support, a cast member renamed, or you want to verify cast for a specific post.

## Prerequisites

- Node.js 18+
- Google Chrome installed

## Setup

```bash
npm install
```

This installs Playwright (which drives Chrome). No separate `npx playwright install` is needed since the scripts use your existing Chrome installation (`channel: 'chrome'`).

## Usage — drafts

### Step 1: Capture draft URLs

```bash
node capture-drafts.js
```

1. **Quit Chrome completely** before running (Playwright needs to launch its own instance).
2. A Chrome window opens to `sora.chatgpt.com/drafts` -- log in.
3. Press **Enter** in the terminal once you can see your drafts.
4. The script auto-scrolls, capturing video URLs from API responses.
5. When no new URLs appear for 5 minutes, it pauses and asks if you want to continue.
6. URLs are saved to `logs/drafts.txt` (one per line, format: `id|url`).

### Step 2: Download videos

Run this in a separate terminal (can run while capture is still going):

```bash
node download-drafts.js
```

Videos are saved to `exports/drafts/` as `sora-draft-{id}.mp4`.

**Interactive controls during download:**

| Key | Action |
|-----|--------|
| `Up` / `+` | Faster (decrease delay) |
| `Down` / `-` | Slower (increase delay) |
| `Space` | Pause / Resume |
| `q` | Quit gracefully |

### Custom paths

Both scripts accept environment variables to override default paths:

```bash
DEST_DIR=/path/to/videos LOGS_DIR=/path/to/logs node capture-drafts.js
```

The download script also accepts a URL file as a positional argument:

```bash
node download-drafts.js /path/to/urls.txt
```

## Usage — profile archive

### Step 1: Capture profile metadata

```bash
node capture-profile.js --username <your-sora-username> [--refresh] [--comments-only]
```

1. **Quit Chrome completely** before running.
2. A Chrome window opens to `sora.chatgpt.com/profile/<username>` -- log in there.
3. The script auto-detects your session once you're logged in (or press Enter to force-proceed in a TTY).
4. **Phase 1 — scroll:** scrolls the profile page at 300px every 5s and saves post metadata from intercepted `/profile_feed` responses to `archive/<username>/_posts/<postId>.json`. Rides the app's natural request rate so you shouldn't see 429s here. When no new posts appear for 5 minutes, it asks whether to keep scrolling.
5. **Phase 2 — comments:** once discovery ends, it fetches each post's comment tree via API at 3s intervals with exponential backoff (10s → 30s → 90s → 300s, Retry-After honored) and auto-pauses after 5 consecutive 429/5xx failures so you can sort it out before rerunning.
6. Reruns are incremental — posts with `comments._pending: true` are retried, complete posts are skipped. Pass `--refresh` to ignore existing files and refetch everything. Hit `q` any time and rerun later to resume.
7. If you bailed out of an earlier run after Phase 1 discovered everything but Phase 2 didn't finish, pass `--comments-only` to skip the scroll and jump straight to fetching the missing comment trees — no need to wait another 5 minutes for the scroll phase to stall.

**Interactive controls during capture:**

| Key | Action |
|-----|--------|
| `Space` | Pause / Resume |
| `q` | Quit gracefully |

### Step 2: Build the HTML archive

Run in another terminal (can start while capture is still going — downloads hit Azure CDN, not Sora's API):

```bash
node build-archive.js --username <your-sora-username> [--rebuild]
```

This downloads each post's video + thumbnail with an interactive TUI (same controls as `download-drafts.js`) and writes the browsable HTML archive.

**Interactive controls during download:**

| Key | Action |
|-----|--------|
| `Up` / `+` | Faster (decrease delay by 1s) |
| `Down` / `-` | Slower (increase delay by 1s) |
| `Space` | Pause / Resume |
| `q` | Quit gracefully |

Reruns are incremental — videos that already exist (and are larger than 50 KB) are skipped. Pass `--rebuild` to force-regenerate the HTML from captured metadata without re-downloading videos. The profile `index.html` and `style.css` are rewritten on every run.

Before the video loop, `build-archive.js` does a fast pre-pass that deduplicates cast members across all posts and downloads each unique avatar once to `assets/avatars/<user_id>.jpg`. If an avatar fails to download, the HTML falls back to the original signed URL (which will stop working after Sora sunsets).

Open the result with:

```bash
open archive/<your-sora-username>/index.html
```

### Typical full-archive flow

```bash
# Replace <user> with your Sora username (e.g. the handle in sora.chatgpt.com/profile/<user>).

# 1. Capture your own posts (scroll + comments). Safe to q and resume anytime.
node capture-profile.js --username <user>

# 2. Capture cast-ins — posts authored by others where you were cast.
node capture-cast-ins.js --username <user>

# 3. Download videos + avatars + render HTML. Start this in a second terminal
#    alongside steps 1 or 2 if you want to overlap work — build-archive only
#    hits the Azure CDN, not Sora's API.
node build-archive.js --username <user>

# 4. If you bailed out of step 1 or 2 before the comment-fetch phase finished:
node capture-profile.js --username <user> --comments-only
node capture-cast-ins.js --username <user> --comments-only

# 5. Rebuild the HTML to pick up freshly-fetched comments (no re-downloads).
#    build-archive auto-rebuilds any page whose _posts/*.json or
#    _cast_ins/*.json is newer than its index.html, so --rebuild is only
#    needed for layout tweaks.
node build-archive.js --username <user> --rebuild
```

### Refreshing cast-ins

`cameo_profiles` (the structured cast list) is captured automatically by `capture-profile.js`. If you have old `_posts/*.json` files that predate cast support, or want to pick up renamed handles and updated avatars:

```bash
# Only refresh posts where the cameo_profiles field is missing (fast)
node backfill-cast.js --username <user> --missing

# Refresh every captured post (slow but thorough)
node backfill-cast.js --username <user>

# Refresh a specific post (or a comma-separated list)
node backfill-cast.js --username <user> --ids s_abc123,s_def456

# Then rebuild the HTML
node build-archive.js --username <user> --rebuild
```

Same backoff + auto-pause behavior as `capture-profile.js` Phase 2. Comments in each post file are preserved.

## File structure

```
logs/
  drafts.txt       # Captured draft video IDs and URLs (from capture-drafts.js)
  download.log     # Draft download session log
exports/
  drafts/          # Downloaded draft .mp4 files

archive/
  <username>/
    profile.json                        # profile metadata
    index.html                          # Posts / Cast-in tab switcher — open this
    style.css
    assets/
      avatar.jpg                        # profile owner's avatar
      avatars/<user_id>.jpg             # cached avatars for every unique cast member
                                        #   (shared across posts + cast-ins)
    _posts/<postId>.json                # raw per-post metadata + cameo_profiles + comments
                                        #   (comments._pending=true until Phase 2 finishes)
    _cast_ins/<postId>.json             # same shape, for posts where you were cast
    posts/<postId>/
      video.mp4
      thumbnail.jpg
      index.html                        # post page: video + cast + comments
    cast_ins/<postId>/
      video.mp4
      thumbnail.jpg
      index.html                        # includes "Posted by @<author>" attribution
    logs/
      capture.log
      capture-cast-ins.log
      build.log
      backfill-cast.log
```
