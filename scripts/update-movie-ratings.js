// Pulls fresh IMDb ratings (and each movie's real IMDb ID, so the site can
// link straight to its IMDb page) from the free OMDb API (omdbapi.com) for
// every movie in MOVIES that currently uses an IMDb-style rating (or has
// none yet), and rewrites index.html in place. Run automatically by the
// "Update IMDb Ratings" GitHub Action — you shouldn't need to run this
// by hand, but `node scripts/update-movie-ratings.js` works locally too
// if you set an OMDB_API_KEY environment variable first.
//
// Get a free API key (instant, just an email) at:
//   https://www.omdbapi.com/apikey.aspx
// Then add it as a repo secret named OMDB_API_KEY:
//   Settings -> Secrets and variables -> Actions -> New repository secret
 
const fs = require('fs');
 
const API_KEY = process.env.OMDB_API_KEY;
if (!API_KEY) {
  console.error('Missing OMDB_API_KEY environment variable.');
  process.exit(1);
}
 
const FILE = 'index.html';
const DELAY_MS = 250; // small gap between requests, polite to the free tier
 
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
 
// Thrown when OMDb's free-tier daily cap (1,000 requests/day) is hit, so the
// caller can stop the whole run instead of silently mislabeling every
// remaining title as "not found".
class QuotaError extends Error {}
 
// Resolves to { rating, imdbId, year } (imdbId is OMDb's "tt1234567"-style
// IMDb ID — capturing it lets the site link the IMDb logo straight to the
// movie's real IMDb page instead of just a search) or null if OMDb has no
// match / no rating.
async function lookupOmdb(title, year) {
  const params = new URLSearchParams({ t: title, apikey: API_KEY });
  if (year) params.set('y', year);
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await res.json();
  if (data.Response === 'False') {
    if (data.Error && /request limit reached/i.test(data.Error)) {
      throw new QuotaError('OMDb daily request limit reached');
    }
    return null;
  }
  if (!data.imdbRating || data.imdbRating === 'N/A') return null;
  return { rating: data.imdbRating, imdbId: data.imdbID || null, year: data.Year || null };
}
 
// OMDb's title+year match is strict — if the year on file for a movie
// (festival year vs. wide-release year, a typo, etc.) doesn't exactly match
// what OMDb has stored, the lookup fails as "not found" even though the
// movie is really on there. So if a year was given and the lookup fails,
// retry once with just the title before giving up.
//
// That retry is risky for a common title (e.g. "Buddy") that a brand-new
// indie/fan movie happens to share with a much older, more famous film of
// the same name: dropping the year lets OMDb match literally any movie
// called that, not necessarily yours. So if the fallback's year is way off
// from what we expected, treat it as "not actually a match" rather than
// quietly attaching some other movie's rating and IMDb page to this one.
const YEAR_TOLERANCE = 2;
async function fetchImdbInfo(title, year) {
  const withYear = await lookupOmdb(title, year);
  if (withYear) return withYear;
  if (year) {
    await sleep(DELAY_MS);
    const fallback = await lookupOmdb(title, null);
    if (!fallback) return null;
    const expected = parseInt(year, 10);
    const got = parseInt(fallback.year, 10);
    if (!isNaN(expected) && !isNaN(got) && Math.abs(got - expected) > YEAR_TOLERANCE) {
      console.log(`  (skipping fallback match for "${title}" — OMDb matched a ${fallback.year} title, too far from the ${year} on file; likely a different movie with the same name)`);
      return null;
    }
    return fallback;
  }
  return null;
}
 
// Simple in-place shuffle (Fisher-Yates). We iterate a shuffled COPY of the
// references (the underlying movie objects are the same, so edits still land
// in the original array/order) so that if the daily quota runs out partway
// through, it's not always the same titles near the end of your list that
// get starved every single run — the "unlucky" leftovers rotate week to week.
function shuffled(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
 
async function main() {
  let html = fs.readFileSync(FILE, 'utf-8');
 
  const match = html.match(/const MOVIES = (\[[\s\S]*?\]);/);
  if (!match) {
    console.error('Could not find "const MOVIES = [...]" in index.html');
    process.exit(1);
  }
  const movies = JSON.parse(match[1]);
 
  let checked = 0, updated = 0, skipped = 0, quotaHit = false;
 
  for (const movie of shuffled(movies)) {
    // Only touch titles that already use (or lack) an IMDb-style rating —
    // this leaves anything you've set manually to something else alone.
    const current = (movie.rating || '').trim();
    const looksLikeImdb = current === '' || /imdb/i.test(current);
    if (!movie.name || !looksLikeImdb) { skipped++; continue; }
 
    checked++;
    try {
      const info = await fetchImdbInfo(movie.name, movie.year);
      if (info) {
        let changed = false;
        const newValue = `${info.rating} IMDb`;
        if (current !== newValue) {
          console.log(`${movie.name} (${movie.year || '?'}): "${current || '—'}" -> "${newValue}"`);
          movie.rating = newValue;
          changed = true;
        }
        if (info.imdbId && movie.imdbId !== info.imdbId) {
          movie.imdbId = info.imdbId;
          changed = true;
        }
        if (changed) updated++;
      } else {
        console.log(`${movie.name} (${movie.year || '?'}): no IMDb rating found on OMDb, left as-is`);
      }
    } catch (e) {
      if (e instanceof QuotaError) {
        console.log(`\nHit OMDb's free daily request limit after checking ${checked} title(s) — stopping here for today. The rest will get picked up on a future run.`);
        quotaHit = true;
        break;
      }
      console.log(`${movie.name}: lookup failed (${e.message}), left as-is`);
    }
    await sleep(DELAY_MS);
  }
 
  console.log(`\nChecked ${checked} title(s), updated ${updated}, skipped ${skipped} (non-IMDb ratings).${quotaHit ? ' (stopped early — daily OMDb limit reached)' : ''}`);
 
  if (updated > 0) {
    html = html.replace(/const MOVIES = \[[\s\S]*?\];/, `const MOVIES = ${JSON.stringify(movies)};`);
    fs.writeFileSync(FILE, html, 'utf-8');
    console.log('index.html updated.');
  } else {
    console.log('No rating changes — nothing to commit.');
  }
}
 
main();
 
