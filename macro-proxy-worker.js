/*
 * macro-proxy-worker.js  —  Cloudflare Worker
 * ------------------------------------------------------------
 * Returns the three "manual" macro gauges as CORS-enabled JSON so the
 * Decline-Risk Dashboard can auto-pull them:
 *
 *   GET https://<your-worker>.workers.dev/macro
 *   -> {"cape":39.8,"buffett":218,"concentration":35.4,"asof":"...","sources":{...}}
 *
 * WHY THIS EXISTS
 *   CAPE, the Buffett indicator and S&P top-10 concentration have no free,
 *   CORS-enabled JSON API. A browser page therefore can't fetch them directly
 *   (CORS blocks it, and the raw sources are HTML, not JSON). This tiny proxy
 *   runs server-side (no CORS limits), scrapes/derives the numbers, and re-serves
 *   them as clean JSON with an Access-Control-Allow-Origin header.
 *
 * HONEST CAVEATS
 *   - These are SCRAPES. If a source changes its HTML, that field returns null
 *     until the regex is updated. Each source is wrapped in its own try/catch,
 *     so a failure in one never breaks the others.
 *   - Concentration (slickcharts) is the least reliable — the site sits behind
 *     a CDN that sometimes blocks bots; if it returns null, enter it manually.
 *   - Buffett is most reliable if you set a free FRED API key (see DEPLOY).
 *
 * DEPLOY (free)
 *   1. Create a Worker at dash.cloudflare.com  (Workers & Pages -> Create -> Worker)
 *      or:  npm i -g wrangler && wrangler init macro-proxy && wrangler deploy
 *   2. Paste this file as the Worker code.
 *   3. (Recommended) Add a free FRED key as a Worker variable named FRED_KEY
 *      (get one at fred.stlouisfed.org). Without it, Buffett falls back to a
 *      brittle scrape.
 *   4. Copy the Worker URL + "/macro" into the dashboard SETUP panel's
 *      "Macro endpoint" field and hit "Pull macro".
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=3600", // these move slowly; cache 1h
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const out = { cape: null, buffett: null, concentration: null, asof: new Date().toISOString(), sources: {}, notes: [] };

    // ---- CAPE  (Shiller PE) from multpl.com ----
    try {
      const html = await (await fetch("https://www.multpl.com/shiller-pe", { headers: ua() })).text();
      // page shows e.g. "Current Shiller PE Ratio: 39.81"
      const m = html.match(/Shiller\s*PE\s*Ratio[^0-9]{0,40}([0-9]{2}(?:\.[0-9]+)?)/i);
      if (m) { out.cape = parseFloat(m[1]); out.sources.cape = "multpl.com/shiller-pe"; }
    } catch (e) { out.notes.push("cape: " + e.message); }

    // ---- Buffett indicator ----
    // Preferred: derive from FRED (Wilshire 5000 full-cap index ÷ GDP × 100).
    if (env && env.FRED_KEY) {
      try {
        const will = await fredLatest("WILL5000INDFC", env.FRED_KEY); // ~ total mkt cap, $B
        const gdp  = await fredLatest("GDP", env.FRED_KEY);            // nominal GDP, $B
        if (will && gdp) {
          out.buffett = Math.round((will / gdp) * 100 * 10) / 10;
          out.sources.buffett = "FRED WILL5000INDFC / GDP (approx)";
        }
      } catch (e) { out.notes.push("buffett(fred): " + e.message); }
    }
    // Fallback: scrape currentmarketvaluation.com headline ratio.
    if (out.buffett == null) {
      try {
        const html = await (await fetch("https://www.currentmarketvaluation.com/models/buffett-indicator.php", { headers: ua() })).text();
        const m = html.match(/(\d{2,3}(?:\.\d+)?)\s*%/);
        if (m) { out.buffett = parseFloat(m[1]); out.sources.buffett = "currentmarketvaluation.com (scrape)"; }
      } catch (e) { out.notes.push("buffett(scrape): " + e.message); }
    }

    // ---- Top-10 S&P concentration from slickcharts ----
    try {
      const html = await (await fetch("https://www.slickcharts.com/sp500", { headers: ua() })).text();
      // weights appear as "X.XX%" in row order; sum the first 10 plausible weights (0.5–12%)
      const pcts = [...html.matchAll(/>(\d{1,2}\.\d{2})%</g)].map(x => parseFloat(x[1])).filter(v => v > 0.3 && v < 15);
      if (pcts.length >= 10) {
        out.concentration = Math.round(pcts.slice(0, 10).reduce((a, b) => a + b, 0) * 10) / 10;
        out.sources.concentration = "slickcharts.com/sp500 (top-10 sum)";
      } else { out.notes.push("concentration: could not parse weights"); }
    } catch (e) { out.notes.push("concentration: " + e.message); }

    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  },
};

function ua() { return { "User-Agent": "Mozilla/5.0 (macro-proxy)" }; }

async function fredLatest(series, key) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
  const j = await (await fetch(url)).json();
  const v = j && j.observations && j.observations[0] && j.observations[0].value;
  return v && v !== "." ? parseFloat(v) : null;
}
