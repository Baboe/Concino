// Concino Slice 0:
// Vinted search URL -> fetch HTML -> extract item IDs/URLs -> dedupe via seen.json -> print NEW item URLs

const fs = require("fs");
const path = require("path");

const SEEN_PATH = path.join(__dirname, "seen.json");

function toItemId(value) {
  if (value == null) return null;
  const s = String(value);

  // If it’s a URL or contains /items/<digits>, extract that
  const m = s.match(/\/items\/(\d+)/);
  if (m) return m[1];

  // If it’s already just digits, keep it
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

    const ids = arr
      .map(toItemId)
      .filter((x) => x !== null);

    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  // Always save IDs only
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
  // We keep it intentionally simple:
  // - Look for "/items/<digits>" anywhere in HTML
  // - Build canonical URLs: `${base}/items/<id>`
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
  // Add a basic UA. Sometimes helps vs generic bot blocks.
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

function looksBlocked(status) {
  // Only treat as blocked for strong signals.
  // (Vinted often serves normal HTML that does NOT include explicit "captcha" text.)
  return status === 401 || status === 403 || status === 429;
}

async function main() {
  const urlArg = process.argv[2];
  if (!urlArg) {
    console.log('Usage:\n  node index.js "<VINTED_SEARCH_URL>"\n');
    process.exit(1);
  }

  let searchUrl;
  try {
    searchUrl = new URL(urlArg).toString();
  } catch {
    console.error("Invalid URL:", urlArg);
    process.exit(1);
  }

  const base = normalizeBase(searchUrl);
  const seen = loadSeen();

  console.log("Concino Slice 0");
  console.log("Search URL:", searchUrl);
  console.log("Seen file :", SEEN_PATH);
  console.log("Seen count:", seen.size);
  console.log("Fetching...");

  const { status, contentType, text } = await fetchHtml(searchUrl);

  console.log("HTTP status :", status);
  console.log("Content-Type:", contentType.split(";")[0] || "(unknown)");

  const { urls } = extractItemIdsAndUrls(text, base);

  const blocked = looksBlocked(status) || urls.length === 0;

  if (blocked) {
    console.log("\n⚠️  Likely blocked (or HTML doesn’t contain item IDs).");
    console.log("If this persists, we’ll add a Playwright fallback.\n");
    const snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
    console.log("HTML snippet (first ~400 chars):");
    console.log(snippet);
    console.log("\nDebug:");
    console.log("Status:", status);
    console.log("Extracted item URLs:", urls.length);
    process.exit(2);
  }

  console.log("Found item URLs:", urls.length);

  const newOnes = [];
  for (const u of urls) {
    const id = u.split("/items/")[1];
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
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});