# Get Those Files Out - Sora exporter

Export your draft videos from [Sora](https://sora.chatgpt.com) before the service sunsets.

![Demo](./demo.jpg)

Two scripts work together:

1. **`capture-drafts.js`** -- Opens Chrome via Playwright, scrolls through your drafts page, and intercepts API responses to collect video download URLs.
2. **`download-drafts.js`** -- Reads the collected URLs and downloads each video with retry logic, rate limiting, and an interactive TUI.

## Prerequisites

- Node.js 18+
- Google Chrome installed

## Setup

```bash
npm install
```

This installs Playwright (which drives Chrome). No separate `npx playwright install` is needed since the scripts use your existing Chrome installation (`channel: 'chrome'`).

## Usage

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

## File structure

```
logs/
  drafts.txt       # Captured video IDs and URLs
  download.log     # Download session log
exports/
  drafts/          # Downloaded .mp4 files
```
