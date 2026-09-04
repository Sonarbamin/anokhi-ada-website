#!/usr/bin/env node
// convert-images-to-webp.js
//
// Writes a .webp beside every .jpg in images/. It does NOT delete or replace
// anything: the JPEGs stay exactly where they are, because pinterest-feed.xml
// and Google Merchant Center point at them by name and a format change there
// risks items being rejected from the feed. The site can serve WebP while the
// feed keeps serving JPEG.
//
// Run it from the root of anokhi-ada-website:
//
//   npm install sharp
//   node convert-images-to-webp.js
//   node convert-images-to-webp.js --check    # reports what's missing, writes nothing
//
// Safe to re-run: an image whose .webp is already newer than its .jpg is
// skipped, so adding one new photograph doesn't re-encode the other 143.

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('sharp is not installed. Run:  npm install sharp');
  process.exit(1);
}

const DIR = path.join(__dirname, 'images');
// 82 matches the quality already used for the JPEGs, so the two formats look
// the same. WebP at a given quality number is not the same as JPEG at that
// number, but at 82 the difference is not visible on these photographs.
const QUALITY = 82;
const checkOnly = process.argv.includes('--check');

if (!fs.existsSync(DIR)) {
  console.error('No images/ directory here. Run this from the root of anokhi-ada-website.');
  process.exit(1);
}

const jpgs = fs.readdirSync(DIR).filter((f) => /\.jpg$/i.test(f));
if (!jpgs.length) {
  console.error('No .jpg files found in images/.');
  process.exit(1);
}

(async () => {
  let written = 0, skipped = 0, missing = 0, savedBytes = 0, originalBytes = 0;

  for (const name of jpgs) {
    const src = path.join(DIR, name);
    const dest = path.join(DIR, name.replace(/\.jpg$/i, '.webp'));
    const srcStat = fs.statSync(src);

    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) {
      skipped++;
      originalBytes += srcStat.size;
      savedBytes += srcStat.size - fs.statSync(dest).size;
      continue;
    }

    if (checkOnly) {
      console.log('  missing or stale: ' + path.basename(dest));
      missing++;
      continue;
    }

    await sharp(src).webp({ quality: QUALITY }).toFile(dest);
    const outSize = fs.statSync(dest).size;
    originalBytes += srcStat.size;
    savedBytes += srcStat.size - outSize;
    written++;
  }

  if (checkOnly) {
    if (missing) {
      console.error('\n' + missing + ' of ' + jpgs.length + ' images have no current .webp. Run without --check.');
      process.exit(1);
    }
    console.log('All ' + jpgs.length + ' images have a current .webp.');
    return;
  }

  const pct = originalBytes ? (100 * savedBytes / originalBytes) : 0;
  console.log('\nwritten: ' + written + '   already current: ' + skipped);
  console.log('JPEG total: ' + (originalBytes / 1048576).toFixed(1) + ' MB');
  console.log('saved:      ' + (savedBytes / 1048576).toFixed(1) + ' MB  (' + pct.toFixed(1) + '% smaller)');
  console.log('\nThe .jpg files are untouched — the Pinterest and Google feeds still work.');
  console.log('Nothing on the site uses the .webp files yet; that is a separate change.');
})().catch((err) => {
  console.error('Conversion failed:', err.message);
  process.exit(1);
});
