import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
// Lossless crops from the approved 1280×960 source image (SHA-256: f387b329e40651725178e1a6c6b7f8d8e0fe0e232dfba988483768a864583560).
const expectedAssets = [
  {
    filename: 'assets/vocora-logo.png',
    width: 1040,
    height: 256,
    sha256: '1d593bac5bac9964cec5b8ce5c614fadb3912e72a34e7f110fd975885f00db8b'
  },
  {
    filename: 'assets/vocora-icon.png',
    width: 384,
    height: 384,
    sha256: 'bbf3b5ba0883c55e9e8bc20ea6c78363016c3b1a7f4b1628c493c13477c16730'
  }
];

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', 'Brand assets must remain PNG files');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const asset of expectedAssets) {
  const buffer = fs.readFileSync(new URL(asset.filename, root));
  assert.deepEqual(pngDimensions(buffer), { width: asset.width, height: asset.height });
  assert.equal(
    crypto.createHash('sha256').update(buffer).digest('hex'),
    asset.sha256,
    `${asset.filename} must remain the exact crop of the approved source image`
  );
}

for (const page of ['index.html', 'login.html', 'register.html']) {
  const markup = fs.readFileSync(new URL(page, root), 'utf8');
  const { document } = new JSDOM(markup).window;
  const favicon = document.querySelector('link[rel="icon"]');
  const logo = document.querySelector('img.brand-logo');

  assert.equal(favicon?.getAttribute('href'), 'assets/vocora-icon.png', `${page} must use the approved Vocora icon`);
  assert.equal(favicon?.getAttribute('type'), 'image/png');
  assert.equal(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'), 'assets/vocora-icon.png');
  assert.equal(logo?.getAttribute('src'), 'assets/vocora-logo.png', `${page} must use the approved Vocora wordmark`);
  assert.equal(document.querySelector('.brand-mark'), null, `${page} must not render the previous substitute V mark`);
}

for (const obsoleteAsset of ['assets/favicon.svg', 'assets/vocora-logo.svg', 'assets/vocora-mark.svg']) {
  assert.equal(fs.existsSync(new URL(obsoleteAsset, root)), false, `${obsoleteAsset} must not remain as an alternate logo`);
}

console.log('All Vocora branding tests passed.');
