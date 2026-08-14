// api/pinterest-feed.js  —  frontend repo (anokhi-ada-website)
//
// Serves pinterest-feed.xml with LIVE availability instead of the static
// "in stock" baked into the committed file.
//
// Why this exists:
// Every piece is one-of-a-kind. When one sells, the browser marks the card
// sold out by calling /api/inventory — but Pinterest and Google never run that
// JavaScript. They read the feed, which is a flat file generated at build time
// and says "in stock" for all 32 products forever. The result is paid traffic
// landing on a piece that sold weeks ago.
//
// This function reads the committed feed, asks the backend which items are
// sold, and flips those entries to "out of stock" before returning it.
//
// SETUP: point the Pinterest data source at
//   https://anokhi-ada.com/api/pinterest-feed
// rather than /pinterest-feed.xml. The static file stays in the repo — it is
// still the source this reads, and still works as a fallback.

const fs = require('fs');
const path = require('path');

const INVENTORY_URL = 'https://anokhi-ada-backend.vercel.app/api/inventory';

// Pinterest re-fetches roughly daily, but a CDN cache in front of this would
// otherwise serve a stale copy for far longer. Ten minutes is short enough
// that a sale is reflected quickly and long enough to absorb repeat crawls.
const CACHE_SECONDS = 600;

// If the inventory call fails we serve the feed unchanged rather than
// erroring: a feed that momentarily over-reports availability is better than
// no feed at all, which is what Pinterest sees on a non-200.
async function fetchSoldItems() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(INVENTORY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error('inventory responded ' + res.status);
    const data = await res.json();
    return Array.isArray(data.soldItems) ? data.soldItems : [];
  } finally {
    clearTimeout(timeout);
  }
}

// The titles in the feed are XML-escaped (&amp;), while /api/inventory returns
// the raw product names. Compare on the decoded form so pieces with an
// ampersand in the name — there are eleven — actually match.
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function markSoldOut(xml, soldItems) {
  if (!soldItems.length) return { xml: xml, marked: [] };

  const sold = new Set(soldItems);
  const marked = [];

  const patched = xml.replace(/<item>[\s\S]*?<\/item>/g, (item) => {
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
    if (!titleMatch) return item;
    const name = decodeEntities(titleMatch[1]).trim();
    if (!sold.has(name)) return item;
    marked.push(name);
    return item.replace(
      /<g:availability>[^<]*<\/g:availability>/,
      '<g:availability>out of stock</g:availability>'
    );
  });

  return { xml: patched, marked: marked };
}

module.exports = async (req, res) => {
  let xml;
  try {
    xml = fs.readFileSync(path.join(process.cwd(), 'pinterest-feed.xml'), 'utf8');
  } catch (err) {
    console.error('Could not read pinterest-feed.xml:', err);
    return res.status(500).send('Feed unavailable.');
  }

  let soldItems = [];
  try {
    soldItems = await fetchSoldItems();
  } catch (err) {
    // Logged, not fatal — see the note above fetchSoldItems.
    console.error('Inventory lookup failed, serving feed unmodified:', err.message);
  }

  const result = markSoldOut(xml, soldItems);

  if (soldItems.length && !result.marked.length) {
    // Every sold item should match a feed entry. If none do, the names have
    // drifted apart — likely a product renamed on the site but not in KV —
    // and the feed is now silently advertising sold pieces.
    console.error(
      'None of the ' + soldItems.length + ' sold items matched a feed entry. ' +
      'Check that product names in _products.js match the titles in pinterest-feed.xml.'
    );
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=' + CACHE_SECONDS + ', stale-while-revalidate');
  return res.status(200).send(result.xml);
};

// Exported for the tests in test-pinterest-feed.js.
module.exports.markSoldOut = markSoldOut;
module.exports.decodeEntities = decodeEntities;
