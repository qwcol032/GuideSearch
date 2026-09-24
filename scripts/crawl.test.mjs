import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImageFormat } from './crawl.mjs';

const cases = [
  ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'jpg', 'image/jpeg'],
  ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png', 'image/png'],
  ['GIF87a', Buffer.from('GIF87a'), 'gif', 'image/gif'],
  ['GIF89a', Buffer.from('GIF89a'), 'gif', 'image/gif'],
  ['WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'webp', 'image/webp'],
];

for (const [name, binary, extension, contentType] of cases) {
  test(`detects ${name} by signature before the response headers`, () => {
    assert.deepEqual(detectImageFormat(binary, 'application/octet-stream', 'https://example.com/viewimage.php'), {
      extension,
      contentType,
      detectedBy: 'signature',
    });
  });
}

test('uses a supported image content type when the signature is unknown', () => {
  assert.equal(detectImageFormat(Buffer.from('unknown'), 'image/png', 'https://example.com/image.bin').detectedBy, 'content-type');
});

test('uses the URL extension only after signature and content type', () => {
  assert.equal(detectImageFormat(Buffer.from('unknown'), 'application/octet-stream', 'https://example.com/image.jpeg').detectedBy, 'url');
});

test('does not save an HTML error page based on an image header or URL', () => {
  assert.equal(detectImageFormat(Buffer.from('  <!doctype html><html>Error</html>'), 'image/jpeg', 'https://example.com/error.jpg'), null);
});
