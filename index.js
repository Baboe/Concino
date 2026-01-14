// Concino Slice 0.4:
// Vinted search URL -> fetch HTML -> extract item IDs/URLs -> dedupe via seen.json -> print NEW item URLs
// Adds: retry on transient failures + --watch N polling + --urls file support + gold detector (€25)

const fs = require("fs");
const path = require("path");

const SEEN_PATH = path.join(__dirname, "seen.json");

function toItemId(value) {
  if (value == null) return null;
  const s = String(value);

  const m = s.match(/\/items\/(\d+)/);
  if (m) return m[1];

  if (/^\d+$/.test(s)) return s;

  return null;
}

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, "utf8");
    const data = JSON.parse(raw);

    let arr = [];
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.seen)) arr = data.seen;

    const ids = arr.map(toItemId).filter((x) => x !== null);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  const arr = Array.from(seenSet).filter((x) => /^\d+$/.test(String(x)));
  fs.writeFileSync(
    SEEN_PATH,
    JSON.stringify({ seen: arr, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function normalizeBase(urlStr) {
  const u = new URL(urlStr);
  return `${u.protocol}//${u.host}`;
}

function extractItemIdsAndUrls(html, base) {
  const re = /\/items\/(\d+)/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
  }
  const urls = Array.from(ids).map((id) => `${base}/items/${id}`);
  return { ids, urls };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "follow",
  });

  const status = res.status;
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  return { status, contentType, text };
}

function isHardBlockedStatus(status) {
  return status === 401 || status === 403 || status === 429;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function goldKeywordScore(text) {
  const t = normalizeText(text);

  // Strong gold signals
  const positive = [
    "14k", "18k", "9k", "10k",
    "585", "750", "375",
    "k14", "k18",
    "gold", "goud", "or", "oro",
    "witgoud", "geelgoud", "roségoud", "rose goud",
    "massief", "solid gold",
    "hallmark", "keurmerk", "poinçon", "punze"
  ];

  // Strong "not solid gold" signals
  const negative = [
    "gold plated", "plated", "verguld", "vermeil",
    "doublé", "double",
    "stainless", "acier", "inox", "rvs",
    "bijouterie", "costume", "fantasie", "fashion jewelry"
  ];

  let pos = 0;
  for (const k of positive) if (t.includes(k)) pos++;

  let neg = 0;
  for (const k of negative) if (t.includes(k)) neg++;

  return { pos, neg };
}

// Best-effort: try to parse a EUR price from the item page HTML.
// Fail-safe: return null if unsure.
function extractEurPriceFromHtml(html) {
  const s = String(html || "");

  // Common JSON-ish patterns
  const patterns = [
    /"price"\s*:\s*"(\d+(?:[.,]\d+)?)"/i,
    /"price"\s*:\s*(\d+(?:[.,]\d+)?)/i,
    /"amount"\s*:\s*"(\d+(?:[.,]\d+)?)"/i,
    /"amount"\s*:\s*(\d+(?:[.,]\d+)?)/i,
    /"item_price"\s*:\s*"(\d+(?:[.,]\d+)?)"/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;

    const raw = m[1].replace(",", ".");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    // Optional currency sanity check (many pages include EUR)
    if (s.toUpperCase().includes("EUR") || s.includes("€") || s.includes('"currency":"EUR"')) {
      return n;
    }

    // If no currency info, still accept but only if it looks plausible for Vinted
    if (n >= 0 && n <= 10000) return n;
  }

  return null;
}

async function fetchItemPageHtml(itemUrl) {
  const { status, text } = await fetchHtml(itemUrl);
  return { status, text };
}

function isInterestingGoldDealFromHtml(html, maxPrice) {
  const { pos, neg } = goldKeywordScore(html);

  // Need at least one strong gold indicator and no clear negatives
  if (!(pos >= 1 && neg === 0)) return false;

  const price = extractEurPriceFromHtml(html);
  if (price === null) return false; // fail-safe: if we can't read price, don't alert

  return price <= maxPrice;
}

// One run of the pipeline. Returns { ok: boolean, newUrlsCount: number }
async function runOnce(searchUrl, seen, opts = {}) {
  const quiet = !!opts.quiet;
  const suppressNew = !!opts.suppressNew;
  const base = normalizeBase(searchUrl);

  if (!quiet) {
    console.log("Concino Slice 0");
    console.log("Search URL:", searchUrl);
    console.log("Seen file :", SEEN_PATH);
    console.log("Seen count:", seen.size);
    console.log("Fetching...");
  }

  // Minimal retry: handles transient 500s or empty HTML results
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status, contentType, text } = await fetchHtml(searchUrl);

    if (!quiet) {
      console.log("HTTP status :", status);
      console.log("Content-Type:", (contentType.split(";")[0] || "(unknown)"));
    }

    // Hard block? Don’t hammer.
    if (isHardBlockedStatus(status)) {
      const snippet = text.slice(0, 250).replace(/\s+/g, " ").trim();
      console.log("\n⚠️  Hard blocked (401/403/429). Playwright fallback likely needed.");
      console.log("HTML snippet:", snippet);
      return { ok: false, newUrlsCount: 0 };
    }

    const { urls } = extractItemIdsAndUrls(text, base);

    // Treat 500+ or 0 extracted as transient first (retry), then fail.
    const transient = status >= 500 || urls.length === 0;

    if (transient) {
      const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
      console.log("\n⚠️  Transient failure (server error or 0 items).");
      console.log("Extracted item URLs:", urls.length);
      console.log("HTML snippet:", snippet);

      if (attempt < maxAttempts) {
        const backoffMs = 750 * attempt + Math.floor(Math.random() * 400);
        console.log(`Retrying in ${backoffMs}ms... (attempt ${attempt}/${maxAttempts})\n`);
        await sleep(backoffMs);
        continue;
      }

      console.log("Giving up for this run.\n");
      return { ok: false, newUrlsCount: 0 };
    }

    // Success path
    if (!quiet) console.log("Found item URLs:", urls.length);

    const newOnes = [];
    for (const u of urls) {
      const id = toItemId(u);
      if (!id) continue;
      if (!seen.has(id)) {
        seen.add(id);
        newOnes.push(u);
      }
    }

    saveSeen(seen);

    // Optional detector filter (Ben-style: minimal, no deps)
    if (opts.detector === "gold" && newOnes.length > 0) {
      const filtered = [];
      let debugLeft = opts.debugDetector ? 5 : 0;

      for (const u of newOnes) {
        try {
          const { status, text } = await fetchItemPageHtml(u);

          if (debugLeft > 0) {
            const { pos, neg } = goldKeywordScore(text);
            const price = extractEurPriceFromHtml(text);
            console.log(`[debug] ${u} status=${status} pos=${pos} neg=${neg} price=${price} max=${opts.maxPrice}`);
            debugLeft--;
          }

          // If item page errors/blocked, skip (no spam)
          if (status >= 400) continue;

          if (isInterestingGoldDealFromHtml(text, opts.maxPrice)) {
            filtered.push(u);
          }
        } catch {
          continue;
        }
      }

      newOnes.length = 0;
      for (const u of filtered) newOnes.push(u);
    }

    // Bootstrap mode: we seed seen.json but do not alert
    if (suppressNew) {
      return { ok: true, newUrlsCount: 0 };
    }

    if (newOnes.length === 0) {
      if (!quiet) {
        console.log("NEW:", 0);
        console.log("No new listings since last run.");
      }
    } else {
      const ts = new Date().toISOString();
      console.log(`\n[${ts}] NEW: ${newOnes.length}`);
      for (const u of newOnes) console.log(u);
    }

    if (!quiet) console.log("\nDone.");
    return { ok: true, newUrlsCount: newOnes.length };
  }

  return { ok: false, newUrlsCount: 0 };
}

function loadUrlsFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const urls = [];
  for (const line of lines) {
    try {
      urls.push(new URL(line).toString());
    } catch {
      console.error("Invalid URL in file:", line);
      process.exit(1);
    }
  }
  return urls;
}

function parseArgs(argv) {
  const urlsIdx = argv.indexOf("--urls");
  let searchUrls = [];

  if (urlsIdx !== -1) {
    const filePath = argv[urlsIdx + 1];
    if (!filePath) {
      console.error("Missing file path for --urls");
      process.exit(1);
    }
    searchUrls = loadUrlsFromFile(filePath);
  } else {
    const urlArg = argv[2];
    if (!urlArg) {
      console.log('Usage:\n  node index.js "<URL>" [--watch N] [--quiet] [--bootstrap] [--detector gold] [--max-price 25] [--debug-detector]\n  node index.js --urls urls.txt [--watch N] [--quiet] [--bootstrap] [--detector gold] [--max-price 25] [--debug-detector]\n');
      process.exit(1);
    }
    try {
      searchUrls = [new URL(urlArg).toString()];
    } catch {
      console.error("Invalid URL:", urlArg);
      process.exit(1);
    }
  }

  let watchSeconds = null;
  const watchIdx = argv.indexOf("--watch");
  if (watchIdx !== -1) {
    const n = Number(argv[watchIdx + 1]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("Invalid --watch value. Example: --watch 60");
      process.exit(1);
    }
    watchSeconds = n;
  }

  const quiet = argv.includes("--quiet");
  const bootstrap = argv.includes("--bootstrap");

  const detectorIdx = argv.indexOf("--detector");
  const detector =
    detectorIdx !== -1 ? String(argv[detectorIdx + 1] || "").toLowerCase() : null;

  const maxPriceIdx = argv.indexOf("--max-price");
  const maxPrice =
    maxPriceIdx !== -1 ? Number(argv[maxPriceIdx + 1]) : 25;

  const debugDetector = argv.includes("--debug-detector");

  return { searchUrls, watchSeconds, quiet, bootstrap, detector, maxPrice, debugDetector };
}

async function main() {
  const { searchUrls, watchSeconds, quiet, bootstrap, detector, maxPrice, debugDetector } = parseArgs(process.argv);
  const seen = loadSeen();

  if (!watchSeconds) {
    for (const url of searchUrls) {
      await runOnce(url, seen, { quiet, detector, maxPrice, debugDetector });
    }
    return;
  }

  console.log(`Watch mode ON: polling every ${watchSeconds}s (Ctrl+C to stop)\n`);

  let firstCycle = true;
  while (true) {
    for (const url of searchUrls) {
      await runOnce(url, seen, { quiet, suppressNew: bootstrap && firstCycle, detector, maxPrice, debugDetector });
    }
    firstCycle = false;
    await sleep(watchSeconds * 1000);
    if (!quiet) console.log("\n---\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});