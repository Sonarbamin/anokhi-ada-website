#!/usr/bin/env node
/*
 * generate-product-pages.js
 *
 * Builds one real, indexable page per product into products/, plus the
 * sitemap that lists them. index.html stays the single source of truth:
 * names, descriptions, prices, sizes and photos are all read off the
 * .look-card blocks, exactly as generate-pinterest-feed.js reads them.
 *
 * Why this exists:
 * Every piece used to live only at anokhi-ada.com/#slug. Google ignores URL
 * fragments, so 47 products competed as one page and none could rank for what
 * it actually is. Google Merchant Center treats many products sharing one URL
 * as a mismatched landing page for the same reason.
 *
 * Usage:
 *   node generate-product-pages.js           write products/ and sitemap.xml
 *   node generate-product-pages.js --check   verify what's on disk is current
 *                                            (exit 1 if stale — good for CI)
 *
 * The page slug is the same slug used for the card's id and the Pinterest
 * g:id, so a product has ONE identity everywhere. Renaming a product still
 * changes all three — see the NOTE in generate-pinterest-feed.js.
 *
 * Deliberately NOT duplicated onto these pages: the cart, the checkout, and
 * anything that computes money. Those live in index.html and the backend, and
 * a second copy is exactly the drift trap the tax table taught us to avoid.
 * "Add to Bag" here is a link to the piece in the shop, where the real cart is.
 *
 * No dependencies. Runs on any Node that Vercel provides.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE = 'https://anokhi-ada.com';
const ROOT = __dirname;
const INPUT = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, 'products');
const SITEMAP = path.join(ROOT, 'sitemap.xml');

// Static pages that belong in the sitemap alongside the generated ones.
const STATIC_PAGES = [
  { loc: '/',                      changefreq: 'weekly',  priority: '1.0' },
  { loc: '/shipping-returns.html', changefreq: 'monthly', priority: '0.6' },
  { loc: '/sitemap.html',          changefreq: 'monthly', priority: '0.3' },
  { loc: '/privacy-policy.html',   changefreq: 'yearly',  priority: '0.3' },
  { loc: '/terms-of-use.html',     changefreq: 'yearly',  priority: '0.3' },
];

const SHOP_SECTIONS = ['suits', 'sarees', 'chaniya-cholis', 'lehengas',
                       'indo-western', 'gowns', 'bridal'];

const SECTION_LABEL = {
  'suits':          'Suits',
  'sarees':         'Sarees',
  'chaniya-cholis': 'Chaniya Cholis',
  'lehengas':       'Lehengas',
  'indo-western':   'Indo Western',
  'gowns':          'Gowns',
  'bridal':         'Bridal',
};

// ---------------------------------------------------------------- helpers ---

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&eacute;/g, '\u00e9')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// For text inside an HTML element or a double-quoted attribute.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// JSON.stringify handles quoting and escapes; slice off its outer quotes so
// the value can sit inside a JSON-LD block we are assembling as text.
function jsonString(str) {
  return JSON.stringify(String(str));
}

function fail(message) {
  console.error('generate-product-pages: ' + message);
  process.exit(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------- extraction ---

function extractProducts(html) {
  const start = html.indexOf('id="' + SHOP_SECTIONS[0] + '"');
  const end = html.indexOf('id="sale"');
  if (start === -1 || end === -1 || end <= start) {
    fail('could not locate the shop sections in index.html — expected id="' +
         SHOP_SECTIONS[0] + '" before id="sale".');
  }
  const shop = html.slice(start, end);

  // Which category each card sits in. Section ids are on <section>, card ids
  // are on the card div — match the section marker only when it is NOT part
  // of a look-card tag.
  const sectionOf = [];
  let current = SHOP_SECTIONS[0];
  const marker = /<section[^>]*id="([a-z-]+)"|<div class="look-card"/g;
  let m;
  while ((m = marker.exec(shop)) !== null) {
    if (m[1]) {
      if (SHOP_SECTIONS.indexOf(m[1]) !== -1) current = m[1];
    } else {
      sectionOf.push(current);
    }
  }

  const cards = shop.match(
    /<div class="look-card"[^>]*>[\s\S]*?Ask a Question<\/a>\s*<\/div>\s*<\/div>/g
  );
  if (!cards || !cards.length) fail('no .look-card blocks found');
  if (cards.length !== sectionOf.length) {
    fail('found ' + cards.length + ' cards but mapped ' + sectionOf.length + ' to sections');
  }

  return cards.map((card, i) => {
    const pick = (re, label) => {
      const found = card.match(re);
      if (!found) {
        const plate = (card.match(/look-plate">([^<]+)</) || [, '#' + (i + 1)])[1];
        fail('card ' + plate + ' is missing its ' + label);
      }
      return found[1];
    };

    const id = pick(/<div class="look-card" id="([a-z0-9-]+)"/, 'slug id');
    const name = decodeEntities(pick(/look-name">([^<]+)</, 'product name'));
    const description = decodeEntities(pick(/class="look-tag">([^<]+)</, 'description'));
    const price = pick(/data-price="(\d+)"/, 'price');
    const size = decodeEntities(pick(/class="look-size">([^<]*)</, 'size'));

    // Every photo on the card, in display order, with the alt text already
    // written for it — no second set of descriptions to keep in step.
    //
    // Two markups exist: multi-photo cards use <img class="gallery-img">, and
    // the handful of single-photo cards use a bare <img> in .look-media. Parse
    // any <img> in the card and read its attributes independently, so neither
    // attribute order nor the presence of a class decides whether a page gets
    // its photo.
    const images = [];
    const tagRe = /<img\b[^>]*>/g;
    let tag;
    while ((tag = tagRe.exec(card)) !== null) {
      const src = tag[0].match(/\ssrc="images\/([^"]+)"/);
      if (!src) continue;
      const alt = tag[0].match(/\salt="([^"]*)"/);
      images.push({ file: src[1], alt: alt ? decodeEntities(alt[1]) : '' });
    }
    if (!images.length) fail('"' + name + '" has no gallery images');

    return { id, name, description, price, size, images, section: sectionOf[i] };
  });
}

// --------------------------------------------------------------- rendering ---

const STYLES = `
  :root{
    --ivory:#FBF3E7; --ivory-dim:#F0E4D2; --maroon:#332920; --maroon-deep:#1C1712;
    --gold:#A3895E; --gold-light:#C1A87E; --ink:#2A2420; --line:rgba(36,16,20,0.14);
  }
  *{ box-sizing:border-box; }
  a:focus-visible, button:focus-visible{
    outline:2px solid var(--maroon); outline-offset:3px; border-radius:2px;
  }
  html{ -webkit-text-size-adjust:100%; text-size-adjust:100%; }
  a, button{ -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
  body{ margin:0; background:var(--ivory); color:var(--ink);
        font-family:'Jost',Arial,sans-serif; line-height:1.6;
        -webkit-font-smoothing:antialiased; }
  h1,h2{ font-family:'Cormorant Garamond',Georgia,serif; margin:0;
         font-weight:600; color:var(--maroon); }
  .wrap{ max-width:1080px; margin:0 auto; padding:0 24px; }
  header{ padding:24px 0; border-bottom:1px solid var(--line); }
  header .wrap{ display:flex; align-items:center; justify-content:space-between; }
  .logo{ display:flex; align-items:center; gap:12px; text-decoration:none; }
  .logo img{ height:44px; width:auto; mix-blend-mode:multiply; }
  .logo span{ font-family:'Yeseva One',serif; font-size:20px; color:var(--maroon); }
  .back-link{ font-size:13px; color:var(--maroon); letter-spacing:0.04em;
              text-decoration:underline; }
  nav.crumbs{ font-size:12.5px; color:#6b5a53; padding:18px 0 0; }
  nav.crumbs a{ color:#6b5a53; }
  main{ padding:20px 0 72px; }
  .product{ display:grid; grid-template-columns:1fr 1fr; gap:48px; align-items:start; }
  .shots{ display:flex; flex-direction:column; gap:12px; }
  .shot{ aspect-ratio:4/5; background:var(--ivory-dim); overflow:hidden; }
  .shot img{ width:100%; height:100%; object-fit:cover; display:block; }
  .eyebrow{ font-family:'Space Mono',monospace; font-size:11.5px;
            letter-spacing:0.14em; text-transform:uppercase; color:var(--gold);
            margin-bottom:12px; }
  h1{ font-size:clamp(26px,3.4vw,38px); line-height:1.15; margin-bottom:14px; }
  .price{ font-size:22px; color:var(--maroon); margin:0 0 6px; }
  .size{ font-size:14px; color:#6b5a53; margin:0 0 20px; }
  .desc{ font-size:15.5px; color:#5a4a44; margin:0 0 24px; }
  .buy{ display:inline-block; background:var(--maroon); color:var(--ivory);
        padding:14px 30px; font-size:13px; letter-spacing:0.1em;
        text-transform:uppercase; text-decoration:none; }
  .buy:hover{ background:var(--maroon-deep); }
  .ask{ display:inline-block; margin-left:18px; font-size:13px;
        color:var(--maroon); text-decoration:underline; }
  .sold{ display:none; background:var(--ivory-dim); border:1px solid var(--line);
         padding:14px 18px; margin:0 0 20px; font-size:14px; color:var(--maroon); }
  body[data-sold-out="true"] .sold{ display:block; }
  body[data-sold-out="true"] .buy{ background:#8d8078; pointer-events:none; }
  .facts{ border-top:1px solid var(--line); margin-top:28px; padding-top:20px;
          font-size:14px; color:#5a4a44; }
  .facts p{ margin:0 0 10px; }
  .facts a{ color:var(--maroon); }
  footer{ border-top:1px solid var(--line); padding:26px 0; text-align:center; }
  footer a{ color:#6b5a53; font-size:13px; }
  @media (max-width:820px){
    .product{ grid-template-columns:1fr; gap:28px; }
    main{ padding:12px 0 56px; }
  }
`;

function renderPage(p, index) {
  const label = SECTION_LABEL[p.section] || 'Collection';
  const url = SITE + '/products/' + p.id + '.html';
  const lead = p.images[0];
  // Google truncates a title around 60 characters, so the category and the
  // city are dropped in that order rather than letting a long product name
  // push the brand off the end of the result. The product name always
  // survives whole — it is the thing being searched for.
  const titleOptions = [
    p.name + ' \u2014 ' + label + ' | Anokhi Ada Atlanta',
    p.name + ' | Anokhi Ada Atlanta',
    p.name + ' | Anokhi Ada',
  ];
  const title = titleOptions.find((t) => t.length <= 62) ||
                titleOptions[titleOptions.length - 1];

  // Trimmed to roughly what a search result will show, then finished with the
  // facts that decide a click: price, size, and that it is one of a kind.
  const metaDesc = p.description.length > 150
    ? p.description.slice(0, 147).replace(/[\s,;]+\S*$/, '') + '\u2026'
    : p.description;
  const fullMeta = metaDesc + ' $' + p.price + ', ' + p.size.replace('Size ', 'size ') +
                   '. One-of-a-kind, from our Atlanta boutique.';

  const shots = p.images.map((im, i) =>
    '      <div class="shot"><img src="../images/' + escapeHtml(im.file) + '" alt="' +
    escapeHtml(im.alt) + '"' + (i === 0 ? ' fetchpriority="high"' : ' loading="lazy"') +
    ' width="480" height="640"></div>'
  ).join('\n');

  // Product + BreadcrumbList. The offer URL is THIS page, which is the whole
  // point of the exercise: one product, one canonical URL, everywhere.
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Product',
        name: p.name,
        image: p.images.map((im) => SITE + '/images/' + im.file),
        description: p.description,
        brand: { '@type': 'Brand', name: 'Anokhi Ada' },
        size: p.size.replace('Size ', ''),
        offers: {
          '@type': 'Offer',
          url: url,
          priceCurrency: 'USD',
          price: p.price,
          availability: 'https://schema.org/InStock',
          seller: { '@type': 'Organization', name: 'Anokhi Ada' },
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: label, item: SITE + '/#' + p.section },
          { '@type': 'ListItem', position: 3, name: p.name, item: url },
        ],
      },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(fullMeta)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="../images/anokhi-ada-logo.jpg" type="image/jpeg">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Anokhi Ada">
<meta property="og:title" content="${escapeHtml(p.name + ' \u2014 Anokhi Ada')}">
<meta property="og:description" content="${escapeHtml(fullMeta)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/images/${escapeHtml(lead.file)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(p.name + ' \u2014 Anokhi Ada')}">
<meta name="twitter:description" content="${escapeHtml(fullMeta)}">
<meta name="twitter:image" content="${SITE}/images/${escapeHtml(lead.file)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,500&family=Yeseva+One&family=Jost:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${STYLES}</style>
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>

<header>
  <div class="wrap">
    <a href="../index.html" class="logo">
      <img src="../images/anokhi-ada-logo.jpg" alt="Anokhi Ada logo">
      <span>Anokhi Ada</span>
    </a>
    <a href="../index.html" class="back-link">&#8592; Back to shop</a>
  </div>
</header>

<div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="../index.html">Home</a> &rsaquo;
    <a href="../index.html#${p.section}">${escapeHtml(label)}</a> &rsaquo;
    <span>${escapeHtml(p.name)}</span>
  </nav>
</div>

<main>
  <div class="wrap">
    <div class="product">
      <div class="shots">
${shots}
      </div>

      <div class="detail">
        <div class="eyebrow">${escapeHtml(label)}</div>
        <h1>${escapeHtml(p.name)}</h1>
        <p class="price">$${escapeHtml(p.price)}</p>
        <p class="size">${escapeHtml(p.size)} &mdash; one piece only, in one size</p>

        <div class="sold">This piece has sold. It was one-of-a-kind, so it won&rsquo;t be
          restocked &mdash; but we can often find something close. Ask us.</div>

        <p class="desc">${escapeHtml(p.description)}</p>

        <a class="buy" href="../index.html#${p.id}">Add to Bag</a>
        <a class="ask" href="../index.html#contact">Ask a Question</a>

        <div class="facts">
          <p><strong>One-of-a-kind.</strong> There is exactly one of this piece, in
             ${escapeHtml(p.size.replace('Size ', 'size '))}. Once it sells it is gone,
             and all sales are final.</p>
          <p><strong>Shipping.</strong> ${p.section === 'bridal'
             ? 'Bridal pieces ship at a flat $40.00 anywhere in the US, insured and specially packed.'
             : '$9.99 within Georgia, $14.99 elsewhere in the US.'}
             Studio pickup in Atlanta is free.
             <a href="../shipping-returns.html">Full shipping &amp; returns</a>.</p>
          <p><strong>Not sure about the fit?</strong> Every piece ships as-is with no
             alterations. <a href="../index.html#contact">Ask us before you buy</a> and
             we&rsquo;ll answer honestly.</p>
        </div>
      </div>
    </div>
  </div>
</main>

<footer>
  <div class="wrap">
    <a href="../index.html#${p.section}">&#8592; More ${escapeHtml(label)}</a>
  </div>
</footer>

<script>
  // One-of-a-kind stock: ask the same endpoint the shop asks, so a sold piece
  // says so here too rather than inviting a click through to a dead Add to Bag.
  (function(){
    var NAME = ${jsonString(p.name)};
    fetch('https://anokhi-ada-backend.vercel.app/api/inventory')
      .then(function(res){ return res.json(); })
      .then(function(data){
        var sold = (data && data.soldItems) || [];
        if(sold.indexOf(NAME) === -1) return;
        document.body.setAttribute('data-sold-out', 'true');
        var buy = document.querySelector('.buy');
        if(buy){ buy.textContent = 'Sold'; }
        var ask = document.querySelector('.ask');
        if(ask){ ask.textContent = 'Ask About Similar Pieces'; }
      })
      .catch(function(err){ console.error('Could not check inventory:', err); });
  })();
</script>

</body>
</html>
`;
}

function renderSitemap(products) {
  const stamp = today();
  const entries = STATIC_PAGES.map((page) => [
    '  <url>',
    '    <loc>' + SITE + page.loc + '</loc>',
    '    <lastmod>' + stamp + '</lastmod>',
    '    <changefreq>' + page.changefreq + '</changefreq>',
    '    <priority>' + page.priority + '</priority>',
    '  </url>',
  ].join('\n'));

  products.forEach((p) => {
    entries.push([
      '  <url>',
      '    <loc>' + SITE + '/products/' + p.id + '.html</loc>',
      '    <lastmod>' + stamp + '</lastmod>',
      '    <changefreq>monthly</changefreq>',
      '    <priority>0.8</priority>',
      '  </url>',
    ].join('\n'));
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Generated by generate-product-pages.js. Do not hand-edit: run the',
    '     script after any catalogue change and commit the result. -->',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.join('\n'),
    '</urlset>',
    '',
  ].join('\n');
}

// -------------------------------------------------------------- validation ---

function validate(products) {
  const problems = [];
  const seen = new Map();

  products.forEach((p) => {
    if (seen.has(p.id)) {
      problems.push('duplicate slug "' + p.id + '" (' + seen.get(p.id) + ' and ' + p.name + ')');
    }
    seen.set(p.id, p.name);

    if (!p.id) problems.push('"' + p.name + '" produced an empty slug');
    if (!/^\d+$/.test(p.price)) problems.push('"' + p.name + '" has a bad price: ' + p.price);
    if (!p.size) problems.push('"' + p.name + '" has no size');
    if (!SECTION_LABEL[p.section]) problems.push('"' + p.name + '" is in unknown section ' + p.section);
    p.images.forEach((im) => {
      if (!/\.(jpe?g|png|webp)$/i.test(im.file)) {
        problems.push('"' + p.name + '" has a bad image filename: ' + im.file);
      }
      if (!im.alt) problems.push('"' + p.name + '" has an image with no alt text: ' + im.file);
    });
  });

  const imagesDir = path.join(ROOT, 'images');
  if (fs.existsSync(imagesDir)) {
    const onDisk = new Set(fs.readdirSync(imagesDir));
    products.forEach((p) => {
      p.images.forEach((im) => {
        if (!onDisk.has(im.file)) {
          problems.push('"' + p.name + '" references images/' + im.file + ', not in the repo');
        }
      });
    });
  }

  return problems;
}

// -------------------------------------------------------------------- main ---

function main() {
  const checkOnly = process.argv.includes('--check');

  if (!fs.existsSync(INPUT)) fail('index.html not found at ' + INPUT);
  const html = fs.readFileSync(INPUT, 'utf8');

  const products = extractProducts(html);
  const problems = validate(products);
  if (problems.length) {
    console.error('generate-product-pages: found ' + problems.length + ' problem(s):');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  const pages = products.map((p, i) => ({
    file: path.join(OUT_DIR, p.id + '.html'),
    body: renderPage(p, i),
  }));
  const sitemap = renderSitemap(products);

  if (checkOnly) {
    const stale = [];
    if (!fs.existsSync(OUT_DIR)) fail('products/ does not exist. Run "node generate-product-pages.js".');

    pages.forEach((page) => {
      const current = fs.existsSync(page.file) ? fs.readFileSync(page.file, 'utf8') : '';
      // lastmod aside, a page differing at all means the catalogue moved on.
      if (current !== page.body) stale.push(path.basename(page.file));
    });

    // A page left behind after a product is removed is worse than a missing
    // one: it stays indexed, and it stays buyable-looking.
    const expected = new Set(pages.map((p) => path.basename(p.file)));
    fs.readdirSync(OUT_DIR)
      .filter((f) => f.endsWith('.html'))
      .forEach((f) => { if (!expected.has(f)) stale.push('ORPHAN: ' + f); });

    if (stale.length) {
      console.error('generate-product-pages: ' + stale.length + ' page(s) out of date:');
      stale.forEach((s) => console.error('  - ' + s));
      fail('run "node generate-product-pages.js" and commit the result.');
    }
    console.log('products/ is up to date (' + products.length + ' pages).');
    return;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Remove pages for products that no longer exist, so a deleted piece stops
  // being served and stops being indexed.
  const expected = new Set(pages.map((p) => path.basename(p.file)));
  let removed = 0;
  fs.readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.html'))
    .forEach((f) => {
      if (!expected.has(f)) { fs.unlinkSync(path.join(OUT_DIR, f)); removed++; }
    });

  pages.forEach((page) => fs.writeFileSync(page.file, page.body, 'utf8'));
  fs.writeFileSync(SITEMAP, sitemap, 'utf8');

  console.log('Wrote ' + pages.length + ' product pages into products/' +
              (removed ? ' (removed ' + removed + ' orphaned)' : '') + '.');
  console.log('Wrote sitemap.xml with ' + (STATIC_PAGES.length + products.length) + ' URLs.');
}

main();
