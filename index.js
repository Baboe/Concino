// Concino Slice 0.2:
// Vinted search URL -> fetch HTML -> extract item IDs/URLs -> dedupe via seen.json -> print NEW item URLs
// Adds: retry on transient failures + --watch N polling

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

// One run of the pipeline. Returns { ok: boolean, newUrlsCount: number }
async function runOnce(searchUrl, seen) {
  const base = normalizeBase(searchUrl);

  console.log("Concino Slice 0");
  console.log("Search URL:", searchUrl);
  console.log("Seen file :", SEEN_PATH);
  console.log("Seen count:", seen.size);
  console.log("Fetching...");

  // Minimal retry: handles transient 500s or empty HTML results
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status, contentType, text } = await fetchHtml(searchUrl);

    console.log("HTTP status :", status);
    console.log("Content-Type:", (contentType.split(";")[0] || "(unknown)"));

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
    console.log("Found item URLs:", urls.length);

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

    if (newOnes.length === 0) {
      console.log("NEW:", 0);
      console.log("No new listings since last run.");
    } else {
      console.log("NEW:", newOnes.length);
      for (const u of newOnes) console.log(u);
    }

    console.log("\nDone.");
    return { ok: true, newUrlsCount: newOnes.length };
  }

  return { ok: false, newUrlsCount: 0 };
}

function parseArgs(argv) {
  const urlArg = argv[2];
  if (!urlArg) {
    console.log('Usage:\n  node index.js "<VINTED_SEARCH_URL>" [--watch <seconds>]\n');
    process.exit(1);
  }

  let searchUrl;
  try {
    searchUrl = new URL(urlArg).toString();
  } catch {
    console.error("Invalid URL:", urlArg);
    process.exit(1);
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

  return { searchUrl, watchSeconds };
}

async function main() {
  const { searchUrl, watchSeconds } = parseArgs(process.argv);
  const seen = loadSeen();

  if (!watchSeconds) {
    await runOnce(searchUrl, seen);
    return;
  }

  console.log(`Watch mode ON: polling every ${watchSeconds}s (Ctrl+C to stop)\n`);

  while (true) {
    await runOnce(searchUrl, seen);
    await sleep(watchSeconds * 1000);
    console.log("\n---\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});