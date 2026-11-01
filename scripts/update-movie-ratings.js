// Pulls fresh IMDb ratings from the free OMDb API (omdbapi.com) for every
// movie in MOVIES that currently uses an IMDb-style rating (or has none
// yet), and rewrites index.html in place. Run automatically by the
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
 
async function lookupOmdb(title, year) {
  const params = new URLSearchParams({ t: title, apikey: API_KEY });
  if (year) params.set('y', year);
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await res.json();
  if (data.Response === 'False') return null;
  if (!data.imdbRating || data.imdbRating === 'N/A') return null;
  return data.imdbRating;
}
 
// OMDb's title+year match is strict — if the year on file for a movie
// (festival year vs. wide-release year, a typo, etc.) doesn't exactly match
// what OMDb has stored, the lookup fails as "not found" even though the
// movie is really on there. So if a year was given and the lookup fails,
// retry once with just the title before giving up.
async function fetchImdbRating(title, year) {
  const withYear = await lookupOmdb(title, year);
  if (withYear) return withYear;
  if (year) {
    await sleep(DELAY_MS);
    return await lookupOmdb(title, null);
  }
  return null;
}
 
async function main() {
  let html = fs.readFileSync(FILE, 'utf-8');
 
  const match = html.match(/const MOVIES = (\[[\s\S]*?\]);/);
  if (!match) {
    console.error('Could not find "const MOVIES = [...]" in index.html');
    process.exit(1);
  }
  const movies = JSON.parse(match[1]);
 
  let checked = 0, updated = 0, skipped = 0;
 
  for (const movie of movies) {
    // Only touch titles that already use (or lack) an IMDb-style rating —
    // this leaves anything you've set manually to something else alone.
    const current = (movie.rating || '').trim();
    const looksLikeImdb = current === '' || /imdb/i.test(current);
    if (!movie.name || !looksLikeImdb) { skipped++; continue; }
 
    checked++;
    try {
      const rating = await fetchImdbRating(movie.name, movie.year);
      if (rating) {
        const newValue = `${rating} IMDb`;
        if (current !== newValue) {
          console.log(`${movie.name} (${movie.year || '?'}): "${current || '—'}" -> "${newValue}"`);
          movie.rating = newValue;
          updated++;
        }
      } else {
        console.log(`${movie.name} (${movie.year || '?'}): no IMDb rating found on OMDb, left as-is`);
      }
    } catch (e) {
      console.log(`${movie.name}: lookup failed (${e.message}), left as-is`);
    }
    await sleep(DELAY_MS);
  }
 
  console.log(`\nChecked ${checked} title(s), updated ${updated}, skipped ${skipped} (non-IMDb ratings).`);
 
  if (updated > 0) {
    html = html.replace(/const MOVIES = \[[\s\S]*?\];/, `const MOVIES = ${JSON.stringify(movies)};`);
    fs.writeFileSync(FILE, html, 'utf-8');
    console.log('index.html updated.');
  } else {
    console.log('No rating changes — nothing to commit.');
  }
}
 
main();
 
