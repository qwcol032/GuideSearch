import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { buildRestorePayload, RESTORE_PREFIX, serializeRestorePayload } from '../public/restore-payload.js';

class TestDOMParser {
  parseFromString(html) {
    const $ = cheerio.load(html, { decodeEntities: false });
    return {
      body: {
        querySelectorAll: () => $('body img').toArray().map((node) => ({
          getAttribute: (name) => $(node).attr(name) ?? null,
          replaceWith: (replacement) => $(node).replaceWith(`<span data-guidesearch-image="${replacement.attributes['data-guidesearch-image']}"></span>`),
        })),
        get innerHTML() { return $('body').html() || ''; },
      },
      createElement: () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
    };
  }
}

globalThis.DOMParser = TestDOMParser;
const latestUrl = 'https://qwcol032.github.io/GuideSearch/data/test/documents/guide/123/latest.json';

function asset(hash) {
  return { hash, fileName: `${hash}.png`, contentType: 'image/png' };
}

function build(bodyHtml, hashes) {
  return buildRestorePayload({
    postNo: '123', title: '복원 제목', url: 'https://gall.dcinside.com/example', bodyHtml,
    assets: [...new Set(hashes)].map(asset),
  }, latestUrl);
}

test('preserves text-image-text and empty paragraph structure', () => {
  const payload = build('<p>텍스트 A</p><p><img src="../../../assets/guide/123/a.png"></p><p><br></p><p>텍스트 B</p>', ['a']);
  assert.equal(payload.bodyTemplateHtml, '<p>텍스트 A</p><p><span data-guidesearch-image="img-001"></span></p><p><br></p><p>텍스트 B</p>');
});

test('preserves image-text-image order by occurrences rather than asset array order', () => {
  const payload = build('<img src="../../../assets/guide/123/b.png"><b>middle</b><img src="../../../assets/guide/123/a.png">', ['a', 'b']);
  assert.deepEqual(payload.imageOccurrences, [{ id: 'img-001', assetHash: 'b' }, { id: 'img-002', assetHash: 'a' }]);
});

test('keeps duplicate image occurrences while deduplicating assets', () => {
  const payload = build('<img src="../../../assets/guide/123/a.png"><em>text</em><img src="../../../assets/guide/123/a.png">', ['a']);
  assert.deepEqual(payload.imageOccurrences.map((item) => item.assetHash), ['a', 'a']);
  assert.equal(Object.keys(payload.assets).length, 1);
});

test('keeps five image positions deterministic', () => {
  const html = Array.from({ length: 5 }, (_, index) => `<p>T${index}<img src="../../../assets/guide/123/${index}.png"></p>`).join('');
  const payload = build(html, ['0', '1', '2', '3', '4']);
  assert.deepEqual(payload.imageOccurrences.map((item) => item.id), ['img-001', 'img-002', 'img-003', 'img-004', 'img-005']);
});

test('fails clearly instead of guessing when an image has no matching asset', () => {
  assert.throws(() => build('<img src="../../../assets/guide/123/missing.png">', []), /asset을 찾을 수 없습니다/);
});

test('serializes a versioned, recognizable clipboard value', () => {
  const serialized = serializeRestorePayload(build('<p>text</p>', []));
  assert.ok(serialized.startsWith(RESTORE_PREFIX));
  assert.equal(JSON.parse(serialized.slice(RESTORE_PREFIX.length)).version, 1);
});
