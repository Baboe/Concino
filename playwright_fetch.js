// playwright_fetch.js
// Minimal Playwright HTML fetcher with resource blocking + single shared browser.

const { chromium } = require("playwright");

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function fetchHtmlWithPlaywright(url, { timeoutMs = 20000 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "nl-NL",
  });

  const page = await context.newPage();

  // Reduce load: block images/fonts/media
  await page.route("**/*", (route) => {
    const rt = route.request().resourceType();
    if (rt === "image" || rt === "media" || rt === "font") {
      return route.abort();
    }
    return route.continue();
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const html = await page.content();
    return { status: 200, text: html, contentType: "text/html", via: "playwright" };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// Optional: call this on process exit if you want tidy shutdown
async function closePlaywright() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = { fetchHtmlWithPlaywright, closePlaywright };