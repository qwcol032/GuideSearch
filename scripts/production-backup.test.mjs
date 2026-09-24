import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistGuideBackup } from './crawl.mjs';

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('one')]);
const PNG2 = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('two')]);
function response(binary, url, ok = true) {
  return { ok, status: ok ? 200 : 503, url, headers: { get: () => 'application/octet-stream' },
    arrayBuffer: async () => binary };
}
function doc(bodyHtml, title = 'title', postNo = '123') {
  return { id: `guide-${postNo}`, docType: 'guide', title, body: 'body', bodyHtml,
    snippet: 'body', url: `https://gall.dcinside.com/gov/${postNo}`, postNo };
}
async function versions(root, postNo = '123') {
  try { return await fs.readdir(path.join(root, 'documents/guide', postNo, 'versions')); } catch { return []; }
}

test('production backup lifecycle, hashing, deduplication, failure protection, and legacy migration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guidesearch-'));
  let binaries = { a: PNG, b: PNG2 };
  let fail = false;
  const fetchImpl = async (url) => fail ? response(Buffer.alloc(0), url, false) : response(binaries[new URL(url).pathname.slice(1)], url);
  const html = '<p>before<img src="https://img.test/a"></p>';

  const first = await persistGuideBackup(doc(html), { dataDir: root, fetchImpl, backupAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.backupResult, 'new');
  assert.equal((await versions(root)).length, 1);
  assert.equal((await fs.readdir(path.join(root, 'assets/guide/123'))).length, 1);
  await fs.access(path.join(root, 'documents/guide/123/preview.html'));

  const latestPath = path.join(root, 'documents/guide/123/latest.json');
  const firstLatest = await fs.readFile(latestPath, 'utf8');
  const unchanged = await persistGuideBackup(doc(html), { dataDir: root, fetchImpl, backupAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(unchanged.backupResult, 'unchanged');
  assert.equal((await versions(root)).length, 1);
  assert.equal(await fs.readFile(latestPath, 'utf8'), firstLatest);

  const textChanged = await persistGuideBackup(doc(`<p>changed<img src="https://cdn.changed/a"></p>`),
    { dataDir: root, fetchImpl: async (url) => response(PNG, url), backupAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(textChanged.backupResult, 'changed');

  const added = await persistGuideBackup(doc('<img src="https://img.test/a"><img src="https://img.test/b">'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-04T00:00:00.000Z' });
  assert.equal(added.backupResult, 'changed');
  assert.equal(added.record.assets.length, 2);

  const reversed = await persistGuideBackup(doc('<img src="https://img.test/b"><img src="https://img.test/a">'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-05T00:00:00.000Z' });
  assert.notEqual(reversed.record.contentHash, added.record.contentHash);

  binaries.a = PNG2;
  const binaryChanged = await persistGuideBackup(doc(html), { dataDir: root, fetchImpl, backupAt: '2026-01-06T00:00:00.000Z' });
  assert.notEqual(binaryChanged.record.contentHash, first.record.contentHash);

  const duplicate = await persistGuideBackup(doc('<img src="https://img.test/a">x<img src="https://img.test/a">'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-07T00:00:00.000Z' });
  assert.equal(duplicate.record.assets.length, 1);
  assert.equal((duplicate.record.bodyHtml.match(/<img/g) || []).length, 2);

  const protectedLatest = await fs.readFile(latestPath, 'utf8');
  const protectedVersions = await versions(root);
  fail = true;
  const partial = await persistGuideBackup(doc('<img src="https://img.test/a">new'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-08T00:00:00.000Z' });
  assert.equal(partial.status, 'asset_partial_failure');
  assert.equal(await fs.readFile(latestPath, 'utf8'), protectedLatest);
  assert.deepEqual(await versions(root), protectedVersions);

  const fresh = '999';
  const freshFailure = await persistGuideBackup(doc('<img src="https://img.test/a">', 'new', fresh),
    { dataDir: root, fetchImpl, backupAt: '2026-01-08T00:00:00.000Z' });
  assert.equal(freshFailure.status, 'asset_partial_failure');
  await assert.rejects(fs.access(path.join(root, 'documents/guide', fresh, 'latest.json')));

  fail = false;
  const legacyPath = path.join(root, 'documents/guide/777');
  await fs.mkdir(legacyPath, { recursive: true });
  await fs.writeFile(path.join(legacyPath, '2025-01-01.json'), '{}');
  await fs.writeFile(path.join(legacyPath, 'latest.json'), JSON.stringify(doc('legacy', 'legacy', '777')));
  const migrated = await persistGuideBackup(doc('<p>current</p>', 'current', '777'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-09T00:00:00.000Z' });
  assert.equal(migrated.backupResult, 'changed');
  assert.ok(migrated.record.contentHash);
  await fs.access(path.join(legacyPath, '2025-01-01.json'));
});
