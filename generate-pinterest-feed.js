#!/usr/bin/env node
/*
 * generate-pinterest-feed.js
 *
 * Regenerates pinterest-feed.xml from the Lookbook cards in index.html, so the
 * feed can never drift out of sync with the catalog again. index.html is the
 * single source of truth: names, descriptions, prices, and lead photos are all
 * read straight off the .look-card blocks.
 *
 * Usage:
 *   node generate-pinterest-feed.js           write pinterest-feed.xml
 *   node generate-pinterest-feed.js --check   verify the file on disk is current
 *                                             (exit 1 if stale — good for CI)
 *
 * Product IDs are slugs of the product name (& becomes "and"). That scheme
 * matches the IDs already in Pinterest, so regenerating never orphans an
 * existing pin. Renaming a product DOES change its ID — see NOTE below.
 *
 * No dependencies. Runs on any Node that Vercel provides.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE = 'https://anokhi-ada.com';
const ROOT = __dirname;
const INPUT = path.join(ROOT, 'index.html');
const OUTPUT = path.join(ROOT, 'pinterest-feed.xml');

const CHANNEL = {
  title: 'Anokhi Ada \u2014 Product Catalog',
  link: SITE + '/',
  description:
    'Indian clothing boutique in Atlanta \u2014 hand-selected sarees, ' +
    'bridal lehengas, and trousseau pieces.',
};

// ---------------------------------------------------------------- helpers ---

// Decode the handful of HTML entities that actually appear in card copy.
// Product names use &amp; and descriptions use things like &eacute;.
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&eacute;/g, '\u00e9')
    // Card copy uses typographic entities freely. Any not decoded here survive
    // as literal text — an item description reading "pearl work &mdash;" is
    // what a shopper then sees in a Google listing.
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Re-escape for XML. Only these three are required in element text.
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(name) {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fail(message) {
  console.error('generate-pinterest-feed: ' + message);
  process.exit(1);
}

// ------------------------------------------------------------- extraction ---

// The shop is split across one section per category. Products are read from
// all of them, and each product's link points at THAT PRODUCT's own anchor
// (every card carries id="<slug>", the same slug used for g:id), so a click
// lands on the piece itself rather than the top of a 37-item page. Google
// Merchant Center in particular treats many products sharing one URL as a
// mismatched landing page.
const SHOP_SECTIONS = ['suits', 'sarees', 'chaniya-cholis', 'lehengas', 'indo-western', 'gowns', 'bridal'];

// The section immediately after the last shop category. Everything between
// the first category and this marker is treated as the catalogue.
const SHOP_END_MARKER = 'services';

// Google's product taxonomy, per category.
//
// Every item used to be sent as the two-level "Apparel & Accessories >
// Clothing", which Pinterest flags (Warning 126) because a shallow category
// limits how well products match searches and recommendations. These are the
// deepest accurate paths in Google's taxonomy for what's actually being sold.
//
// "Traditional & Ceremonial Clothing > Saris & Lehengas" is a real four-level
// node (ID 8248) and is exactly right for sarees, lehengas and chaniya
// cholis. Kurta and sharara sets sit one level up under Traditional &
// Ceremonial Clothing; the fusion separates and the evening gown are better
// described by their western equivalents.
const APPAREL = 'Apparel & Accessories > Clothing';
const TRADITIONAL = APPAREL + ' > Traditional & Ceremonial Clothing';
const CATEGORY_BY_SECTION = {
  'suits':          TRADITIONAL,
  'sarees':         TRADITIONAL + ' > Saris & Lehengas',
  'chaniya-cholis': TRADITIONAL + ' > Saris & Lehengas',
  'lehengas':       TRADITIONAL + ' > Saris & Lehengas',
  'indo-western':   TRADITIONAL,
  'gowns':          APPAREL + ' > Dresses',
  'bridal':         TRADITIONAL + ' > Saris & Lehengas',
};
const CATEGORY_FALLBACK = TRADITIONAL;

// Google requires colour, size, gender and age group on apparel in the US, and
// shows products missing them less often. Size comes off the card. Gender and
// age group are the same for everything sold here.
const GENDER = 'female';
const AGE_GROUP = 'adult';

// Colour is read from the start of the product name, which is how the catalogue
// is written: "Blush Tissue Bridal Lehenga" is blush. Longer names come first
// so "Light Blue" wins over "Blue". Anything that doesn't begin with a colour,
// or where the piece is genuinely two-tone, gets an explicit entry in
// COLOR_OVERRIDES below and the build fails until it has one.
const COLOR_WORDS = [
  'Light Blue', 'Mint Green', 'Dusty Rose', 'Blush Pink', 'Blush',
  'Chartreuse', 'Lavender', 'Fuchsia', 'Emerald', 'Mustard', 'Maroon',
  'Taupe', 'Purple', 'Orange', 'Yellow', 'Silver', 'Brown', 'Green',
  'Black', 'White', 'Ivory', 'Grey', 'Pink', 'Blue', 'Gold', 'Rust',
  'Nude', 'Red',
];

// Up to three colours, separated by "/", is what Google accepts for a
// multi-coloured piece.
const COLOR_OVERRIDES = {
  'rani-pink-short-kurta-and-wide-leg-pants': 'Pink',
  'color-blocked-silk-anarkali-set': 'Purple/Red/Orange',
  'vintage-hand-embroidered-chaniya-choli': 'Mustard/Red',
  'grey-tissue-crop-top-and-red-pleated-skirt': 'Grey/Red',
  'black-and-gold-antique-work-evening-gown': 'Black/Gold',
  'yellow-printed-wide-leg-pants-and-embroidered-crop-top': 'Yellow/Red',
  'grey-tissue-draped-lehenga-and-embroidered-blouse': 'Grey/Purple',
  'red-raw-silk-bridal-lehenga': 'Red/Ivory',
};

function colorFor(product) {
  if (COLOR_OVERRIDES[product.slug]) return COLOR_OVERRIDES[product.slug];
  for (let i = 0; i < COLOR_WORDS.length; i++) {
    if (product.name.indexOf(COLOR_WORDS[i]) === 0) return COLOR_WORDS[i];
  }
  return null; // validate() turns this into a build failure
}

// Shipping, stated per product rather than left to the account-level setting.
// Merchant Center would otherwise apply one flat rate to everything, quoting
// $14.99 on a bridal lehenga that actually ships at $40 — and under-quoting
// shipping is exactly the discrepancy Google penalises.
//
// These mirror getShippingFee() in the backend's api/_tax-rates.js. Change
// both together. Rush delivery is deliberately absent: it is an upgrade the
// customer chooses at checkout, not the standard service.
const SHIPPING_GEORGIA = '9.99 USD';
const SHIPPING_OUT_OF_STATE = '14.99 USD';
const SHIPPING_BRIDAL = '40.00 USD';

// g:id overrides. Google caps the id attribute at 50 characters; a couple of
// product names slugify to more than that. The override changes ONLY the feed
// id — the product's page URL, its card anchor and its link here all keep the
// full slug, so nothing a customer sees or has bookmarked moves.
//
// Once an id is in here it must never change again: to Google and Pinterest a
// changed id is a different product, and the old one's history goes with it.
const ID_OVERRIDES = {
  'yellow-printed-wide-leg-pants-and-embroidered-crop-top':
    'yellow-printed-pants-embroidered-crop-top',
};

function extractProducts(html) {
  // Everything from the first category section to the Sale section. The Sale
  // grid is filled in at runtime and has no cards in the source, but scoping
  // keeps this honest if that ever changes.
  // The shop runs from the first category section to the one that follows the
  // last of them. This used to end at id="sale"; that section was removed when
  // it had nothing in it, so the boundary is now the section after Bridal.
  const start = html.indexOf('id="' + SHOP_SECTIONS[0] + '"');
  const end = html.indexOf('id="' + SHOP_END_MARKER + '"');
  if (start === -1 || end === -1 || end <= start) {
    fail(
      'could not locate the shop sections in index.html — expected id="' +
      SHOP_SECTIONS[0] + '" before id="' + SHOP_END_MARKER + '". If the ' +
      'categories were renamed or a section was added after Bridal, update ' +
      'SHOP_SECTIONS and SHOP_END_MARKER.'
    );
  }
  const shop = html.slice(start, end);

  // Which category each card sits in, so its link can point there.
  const sectionOf = [];
  let current = SHOP_SECTIONS[0];
  // Section ids are on <section>, card ids are on the card div — match the
  // section marker only when it is NOT part of a look-card tag.
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
  if (!cards || !cards.length) fail('no .look-card blocks found in the shop sections');
  if (cards.length !== sectionOf.length) {
    fail('found ' + cards.length + ' cards but mapped ' + sectionOf.length + ' to sections');
  }

  return cards.map((card, i) => {
    const pick = (re, label) => {
      const m = card.match(re);
      if (!m) {
        const plate = (card.match(/look-plate">([^<]+)</) || [, '#' + (i + 1)])[1];
        fail('card ' + plate + ' is missing its ' + label);
      }
      return m[1];
    };

    const name = decodeEntities(pick(/look-name">([^<]+)</, 'product name'));
    const description = decodeEntities(
      pick(/class="look-tag">([^<]+)</, 'description')
    );
    const price = pick(/data-price="(\d+)"/, 'price');
    // "Size M" on the card becomes "M" for the feed.
    const size = decodeEntities(pick(/class="look-size">([^<]*)</, 'size'))
      .replace(/^Size\s*/i, '').trim();
    // First image in the card is the lead photo — the full view where one exists.
    const image = pick(/src="images\/([^"]+)"/, 'image');

    // slug drives the link and the product page; id is what Google and
    // Pinterest key on, and may be shortened by ID_OVERRIDES.
    const slug = slugify(name);
    return {
      id: ID_OVERRIDES[slug] || slug,
      slug, name, description, price, size, image, section: sectionOf[i],
    };
  });
}

// --------------------------------------------------------------- rendering ---

// Bridal ships at one flat rate wherever it goes, so it needs a single entry.
// Everything else is cheaper inside Georgia, which takes two: the specific
// region first, then the country-wide fallback.
function shippingFor(product) {
  const entry = (price, region) =>
    [
      '      <g:shipping>',
      '        <g:country>US</g:country>',
      region ? '        <g:region>' + region + '</g:region>' : null,
      '        <g:price>' + price + '</g:price>',
      '      </g:shipping>',
    ].filter(Boolean).join('\n');

  if (product.section === 'bridal') return entry(SHIPPING_BRIDAL);
  return entry(SHIPPING_GEORGIA, 'GA') + '\n' + entry(SHIPPING_OUT_OF_STATE);
}

function renderFeed(products) {
  const items = products
    .map(p =>
      [
        '    <item>',
        '      <g:id>' + p.id + '</g:id>',
        '      <title>' + escapeXml(p.name) + '</title>',
        '      <description>' + escapeXml(p.description) + '</description>',
        // Each product's own page, not a fragment of the homepage. Google
        // Merchant Center treats many products sharing one URL as a mismatched
        // landing page; Pinterest just sends people to the top of a 47-item
        // scroll. g:id is unchanged, so existing pins keep their history.
        '      <link>' + SITE + '/products/' + p.slug + '.html</link>',
        '      <g:image_link>' + SITE + '/images/' + p.image + '</g:image_link>',
        '      <g:price>' + p.price + '.00 USD</g:price>',
        '      <g:availability>in stock</g:availability>',
        shippingFor(p),
        '      <g:color>' + escapeXml(colorFor(p)) + '</g:color>',
        '      <g:size>' + escapeXml(p.size) + '</g:size>',
        '      <g:size_system>US</g:size_system>',
        '      <g:gender>' + GENDER + '</g:gender>',
        '      <g:age_group>' + AGE_GROUP + '</g:age_group>',
        '      <g:brand>Anokhi Ada</g:brand>',
        '      <g:condition>new</g:condition>',
        // Every piece is one-of-a-kind and handmade, so it genuinely has no
        // GTIN or MPN. Pinterest and Google both require either an identifier
        // or this explicit declaration that none exists — omitting all three
        // is what gets a feed rejected. Inventing numbers instead is treated
        // as a serious violation, so this is the correct answer, not a
        // workaround.
        '      <g:identifier_exists>false</g:identifier_exists>',
        '      <g:google_product_category>' +
          escapeXml(CATEGORY_BY_SECTION[p.section] || CATEGORY_FALLBACK) +
          '</g:google_product_category>',
        '    </item>',
      ].join('\n')
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">',
    '  <channel>',
    '    <title>' + escapeXml(CHANNEL.title) + '</title>',
    '    <link>' + CHANNEL.link + '</link>',
    '    <description>' + escapeXml(CHANNEL.description) + '</description>',
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// -------------------------------------------------------------- validation ---

function validate(products) {
  const problems = [];

  const seen = new Map();
  products.forEach(p => {
    if (seen.has(p.id)) {
      problems.push(
        'duplicate product id "' + p.id + '" (' + seen.get(p.id) + ' and ' + p.name + ')'
      );
    }
    seen.set(p.id, p.name);

    if (!p.id) problems.push('"' + p.name + '" produced an empty id');
    if (!p.size) problems.push('"' + p.name + '" has no size on its card');
    if (!colorFor(p)) {
      problems.push(
        '"' + p.name + '" does not start with a known colour. Add "' + p.slug +
        '" to COLOR_OVERRIDES, or add the colour to COLOR_WORDS.'
      );
    }
    // Google caps g:id at 50 characters and truncates past it, which silently
    // splits one product into two identities. Add an ID_OVERRIDES entry.
    if (p.id.length > 50) {
      problems.push(
        '"' + p.name + '" has a ' + p.id.length + '-character id (' + p.id +
        '). Google allows 50 — add a shorter one to ID_OVERRIDES.'
      );
    }
    if (!/^\d+$/.test(p.price)) problems.push('"' + p.name + '" has a bad price: ' + p.price);
    if (!/\.(jpe?g|png|webp)$/i.test(p.image)) {
      problems.push('"' + p.name + '" has a bad image filename: ' + p.image);
    }
    // Pinterest limits: title 500 chars, description 10000. Ours run far under,
    // but a runaway edit should fail the build rather than the ingestion.
    if (p.name.length > 500) problems.push('"' + p.name + '" title exceeds 500 chars');
    if (p.description.length > 10000) {
      problems.push('"' + p.name + '" description exceeds 10000 chars');
    }
    // A leftover HTML entity means decodeEntities missed one. It would be
    // shown to shoppers verbatim, so stop the build rather than publish it.
    const leftover = (p.name + ' ' + p.description).match(/&[a-z]+;|&#\d+;/i);
    if (leftover) {
      problems.push(
        '"' + p.name + '" still contains the HTML entity ' + leftover[0] +
        ' — add it to decodeEntities().'
      );
    }
  });

  // Cross-check against the images actually on disk, when the folder is present.
  const imagesDir = path.join(ROOT, 'images');
  if (fs.existsSync(imagesDir)) {
    const onDisk = new Set(fs.readdirSync(imagesDir));
    products.forEach(p => {
      if (!onDisk.has(p.image)) {
        problems.push(
          '"' + p.name + '" references images/' + p.image + ', which is not in the repo'
        );
      }
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
    console.error('generate-pinterest-feed: found ' + problems.length + ' problem(s):');
    problems.forEach(p => console.error('  - ' + p));
    process.exit(1);
  }

  const xml = renderFeed(products);

  if (checkOnly) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== xml) {
      fail(
        'pinterest-feed.xml is out of date. Run "node generate-pinterest-feed.js" and commit the result.'
      );
    }
    console.log('pinterest-feed.xml is up to date (' + products.length + ' products).');
    return;
  }

  fs.writeFileSync(OUTPUT, xml, 'utf8');
  console.log(
    'Wrote pinterest-feed.xml with ' + products.length + ' products.'
  );
}

main();

/*
 * NOTE ON RENAMING
 * ----------------
 * Because g:id is derived from the product name, renaming a product changes its
 * id. Pinterest treats that as the old product disappearing and a new one
 * arriving, so the existing pin's stats and any saves attached to it are lost.
 * If you ever need to rename a live product without that happening, add the old
 * id here and it will be kept:
 *
 *   const ID_OVERRIDES = { 'new-product-slug': 'original-slug-pinterest-knows' };
 *
 * and apply it in extractProducts. Nothing needs it today.
 */
