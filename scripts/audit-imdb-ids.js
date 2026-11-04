// One-time (or run-whenever-you-want) cleanup tool. An earlier version of
// update-movie-ratings.js could, for a brand-new/obscure title not yet on
// OMDb, fall back to a title-only search and accidentally latch onto a
// totally different, same-named movie from a different era (e.g. a 2026
// indie film called "Buddy" matching the famous 1997 "Buddy" instead).
// That bug is fixed in update-movie-ratings.js now, but it doesn't
// retroactively fix entries that already got a wrong rating + imdbId
// written before the fix.
//
// This script re-checks every movie that currently has a saved imdbId by
// looking that exact ID up on OMDb (id lookups are exact, no title
// ambiguity) and comparing the year OMDb has for that ID against the year
// you have on file. If they're way off, it clears that movie's imdbId and
// rating back to blank so the (now-fixed) weekly script can safely
// recheck and reattach the correct one later.
//
// Run it manually from the Actions tab ("Audit IMDb Links" -> Run
// workflow), or locally with `node scripts/audit-imdb-ids.js` if you have
// an OMDB_API_KEY environment variable set.
 
const fs = require('fs');
 
const API_KEY = process.env.OMDB_API_KEY;
if (!API_KEY) {
  console.error('Missing OMDB_API_KEY environment variable.');
  process.exit(1);
}
 
const FILE = 'index.html';
const DELAY_MS = 250;
const YEAR_TOLERANCE = 2;
 
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
 
class QuotaError extends Error {}
 
// Looks a movie up by its exact IMDb ID — no title ambiguity possible here,
// this tells us definitively what movie that ID actually belongs to.
async function lookupById(imdbId) {
  const params = new URLSearchParams({ i: imdbId, apikey: API_KEY });
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await res.json();
  if (data.Response === 'False') {
    if (data.Error && /request limit reached/i.test(data.Error)) {
      throw new QuotaError('OMDb daily request limit reached');
    }
    return null; // invalid/unknown ID
  }
  return { title: data.Title || null, year: data.Year || null };
}
 
async function main() {
  let html = fs.readFileSync(FILE, 'utf-8');
 
  const match = html.match(/const MOVIES = (\[[\s\S]*?\]);/);
  if (!match) {
    console.error('Could not find "const MOVIES = [...]" in index.html');
    process.exit(1);
  }
  const movies = JSON.parse(match[1]);
 
  const toCheck = movies.filter(m => m.imdbId && String(m.imdbId).trim());
  console.log(`Found ${toCheck.length} movie(s) with a saved IMDb link to verify.\n`);
 
  let checked = 0, cleared = 0, quotaHit = false;
 
  for (const movie of toCheck) {
    checked++;
    try {
      const info = await lookupById(movie.imdbId.trim());
      if (!info) {
        console.log(`"${movie.name}": IMDb ID ${movie.imdbId} isn't valid on OMDb anymore — clearing.`);
        delete movie.imdbId;
        movie.rating = '';
        cleared++;
      } else {
        const expected = parseInt(movie.year, 10);
        const got = parseInt(info.year, 10);
        const yearMismatch = !isNaN(expected) && !isNaN(got) && Math.abs(got - expected) > YEAR_TOLERANCE;
        if (yearMismatch) {
          console.log(`MISMATCH: "${movie.name}" (${movie.year}) was linked to "${info.title}" (${info.year}) — clearing so it can be rechecked correctly.`);
          delete movie.imdbId;
          movie.rating = '';
          cleared++;
        }
      }
    } catch (e) {
      if (e instanceof QuotaError) {
        console.log(`\nHit OMDb's free daily request limit after checking ${checked} link(s) — stopping here for today. Run this again tomorrow to continue auditing the rest.`);
        quotaHit = true;
        break;
      }
      console.log(`"${movie.name}": lookup failed (${e.message}), leaving as-is`);
    }
    await sleep(DELAY_MS);
  }
 
  console.log(`\nChecked ${checked} link(s), cleared ${cleared} mismatch(es).${quotaHit ? ' (stopped early — daily OMDb limit reached)' : ''}`);
 
  if (cleared > 0) {
    html = html.replace(/const MOVIES = \[[\s\S]*?\];/, `const MOVIES = ${JSON.stringify(movies)};`);
    fs.writeFileSync(FILE, html, 'utf-8');
    console.log('index.html updated.');
  } else {
    console.log('No mismatches found — nothing to commit.');
  }
}
 
main();
 
