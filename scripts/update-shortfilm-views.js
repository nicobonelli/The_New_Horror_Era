// Pulls fresh YouTube view counts for every short film in SHORT_FILMS that
// currently shows a "views"-style number (or has none yet), and rewrites
// index.html in place. Run automatically by the "Update Short Film Views"
// GitHub Action — you shouldn't need to run this by hand, but
// `node scripts/update-shortfilm-views.js` works locally too if you set a
// YOUTUBE_API_KEY environment variable first.
//
// Get a free API key (needs a Google account, a couple minutes):
//   1. console.cloud.google.com -> create a project (any name)
//   2. APIs & Services -> Library -> search "YouTube Data API v3" -> Enable
//   3. APIs & Services -> Credentials -> Create Credentials -> API key
// Then add it as a repo secret named YOUTUBE_API_KEY:
//   Settings -> Secrets and variables -> Actions -> New repository secret
//
// The free quota is 10,000 units/day and this only costs 1 unit per 50
// videos checked (it batches them), so your whole catalog gets checked in
// a single request — nowhere near the kind of limit the OMDb rating script
// has to work around.

const fs = require('fs');

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Missing YOUTUBE_API_KEY environment variable.');
  process.exit(1);
}

const FILE = 'index.html';
const BATCH_SIZE = 50; // YouTube's videos.list allows up to 50 IDs per call

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pulls a YouTube video ID out of whatever link format you've pasted into
// the "trailer" field: youtu.be/ID, youtube.com/watch?v=ID, /shorts/ID,
// /embed/ID, or a Google "click-through" redirect link that wraps one of
// those as a ?url= or ?q= parameter (seen on a few entries copied straight
// from a Google search result).
function extractVideoId(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }

  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/url') {
    const inner = u.searchParams.get('url') || u.searchParams.get('q');
    return inner ? extractVideoId(inner) : null;
  }

  if (/(^|\.)youtu\.be$/i.test(u.hostname)) {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    return id || null;
  }

  if (/(^|\.)youtube(-nocookie)?\.com$/i.test(u.hostname)) {
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/);
    if (m) return m[1];
  }

  return null;
}

// Matches the existing style across your data ("700K Views", "1.1M views",
// "16M views", etc.) closely enough for parseViews() on the site to keep
// sorting correctly either way.
function formatViews(n) {
  const num = Number(n);
  const shrink = (val, suffix) => {
    const rounded = Math.round(val * 10) / 10;
    const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${str}${suffix} views`;
  };
  if (num >= 1e9) return shrink(num / 1e9, 'B');
  if (num >= 1e6) return shrink(num / 1e6, 'M');
  if (num >= 1e3) return shrink(num / 1e3, 'K');
  return `${num} views`;
}

async function main() {
  let html = fs.readFileSync(FILE, 'utf-8');

  const match = html.match(/const SHORT_FILMS = (\[[\s\S]*?\]);/);
  if (!match) {
    console.error('Could not find "const SHORT_FILMS = [...]" in index.html');
    process.exit(1);
  }
  const films = JSON.parse(match[1]);

  const eligible = [];
  let skipped = 0;

  for (const film of films) {
    // Only touch entries that already show a views-style number (or have
    // none yet) — this leaves anything you've set manually to something
    // else (like a short film that actually has its own IMDb rating) alone.
    const current = (film.rating || '').trim();
    const looksLikeViews = current === '' || /views?$/i.test(current);
    if (!film.name || !looksLikeViews) { skipped++; continue; }

    const videoId = extractVideoId(film.trailer);
    if (!videoId) {
      console.log(`"${film.name}": couldn't find a YouTube video link, skipping`);
      skipped++;
      continue;
    }
    eligible.push({ film, videoId, current });
  }

  console.log(`${eligible.length} short film(s) to check, ${skipped} skipped.\n`);

  const statsById = {};
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const ids = batch.map(e => e.videoId).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(ids)}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`YouTube API error: ${data.error.message}`);
      process.exit(1);
    }
    for (const item of data.items || []) {
      statsById[item.id] = item.statistics && item.statistics.viewCount;
    }
    if (i + BATCH_SIZE < eligible.length) await sleep(200);
  }

  let updated = 0;
  for (const { film, videoId, current } of eligible) {
    const viewCount = statsById[videoId];
    if (viewCount === undefined) {
      console.log(`"${film.name}": video not found (deleted/private, or a bad link) — left as-is`);
      continue;
    }
    const newValue = formatViews(viewCount);
    if (newValue !== current) {
      console.log(`"${film.name}": "${current || '—'}" -> "${newValue}"`);
      film.rating = newValue;
      updated++;
    }
  }

  console.log(`\nChecked ${eligible.length} short film(s), updated ${updated}.`);

  if (updated > 0) {
    html = html.replace(/const SHORT_FILMS = \[[\s\S]*?\];/, `const SHORT_FILMS = ${JSON.stringify(films)};`);
    fs.writeFileSync(FILE, html, 'utf-8');
    console.log('index.html updated.');
  } else {
    console.log('No view changes — nothing to commit.');
  }
}

main();
