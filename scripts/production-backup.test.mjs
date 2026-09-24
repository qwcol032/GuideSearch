import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchImageWithRetry, isRetryableStatusItem, persistGuideBackup } from './crawl.mjs';

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('one')]);
const PNG2 = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('two')]);
function response(binary, url, status = 200, contentType = 'application/octet-stream') {
  return { ok: status >= 200 && status < 300, status, url, headers: { get: (name) => name === 'content-type' ? contentType : null },
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
  const fetchImpl = async (url) => fail ? response(Buffer.alloc(0), url, 503) : response(binaries[new URL(url).pathname.slice(1)], url);
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
  const binaryChanged = await persistGuideBackup(doc('<p>before<img src="https://img.test/a-v2"></p>'),
    { dataDir: root, fetchImpl: async (url) => response(PNG2, url), backupAt: '2026-01-06T00:00:00.000Z' });
  assert.notEqual(binaryChanged.record.contentHash, first.record.contentHash);

  const duplicate = await persistGuideBackup(doc('<img src="https://img.test/a">x<img src="https://img.test/a">'),
    { dataDir: root, fetchImpl, backupAt: '2026-01-07T00:00:00.000Z' });
  assert.equal(duplicate.record.assets.length, 1);
  assert.equal((duplicate.record.bodyHtml.match(/<img/g) || []).length, 2);

  const protectedLatest = await fs.readFile(latestPath, 'utf8');
  const protectedVersions = await versions(root);
  fail = true;
  const partial = await persistGuideBackup(doc('<img src="https://failed.test/a">new'),
    { dataDir: root, fetchImpl, maxAttempts: 1, backupAt: '2026-01-08T00:00:00.000Z' });
  assert.equal(partial.status, 'asset_partial_failure');
  assert.equal(await fs.readFile(latestPath, 'utf8'), protectedLatest);
  assert.deepEqual(await versions(root), protectedVersions);

  const fresh = '999';
  const freshFailure = await persistGuideBackup(doc('<img src="https://img.test/a">', 'new', fresh),
    { dataDir: root, fetchImpl, maxAttempts: 1, backupAt: '2026-01-08T00:00:00.000Z' });
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

test('retries transient HTTP and network failures, but not permanent HTTP failures', async () => {
  const noWait = async () => {};
  let calls = 0;
  const eventuallyOk = await fetchImageWithRetry('https://dcimg1.dcinside.com/image', 'https://gall.dcinside.com/post', '5131545', {
    fetchImpl: async (url) => (++calls < 3 ? response(Buffer.alloc(0), url, 504) : response(PNG, url)),
    sleepImpl: noWait,
  });
  assert.equal(calls, 3);
  assert.equal(eventuallyOk.error, undefined);

  calls = 0;
  const networkOk = await fetchImageWithRetry('https://dcimg1.dcinside.com/image', 'https://gall.dcinside.com/post', '5354076', {
    fetchImpl: async (url) => { if (++calls === 1) throw new TypeError('terminated', { cause: { code: 'ECONNRESET' } }); return response(PNG, url); },
    sleepImpl: noWait,
  });
  assert.equal(calls, 2);
  assert.equal(networkOk.error, undefined);

  for (const status of [404, 410]) {
    calls = 0;
    const result = await fetchImageWithRetry('https://external.test/image', 'https://gall.dcinside.com/post', '123', {
      fetchImpl: async (url) => { calls += 1; return response(Buffer.alloc(0), url, status); }, sleepImpl: noWait,
    });
    assert.equal(calls, 1);
    assert.equal(result.error.classification, 'permanent');
    assert.equal(result.error.httpStatus, status);
  }
});

test('external 403 and HTML responses get one referer-free fallback then become permanent', async () => {
  for (const mode of ['403', 'html']) {
    const referers = [];
    const result = await fetchImageWithRetry('https://external.test/image.jpg', 'https://gall.dcinside.com/post', '123', {
      fetchImpl: async (url, options) => {
        referers.push(options.headers.referer);
        return mode === '403'
          ? response(Buffer.alloc(0), url, 403)
          : response(Buffer.from('<html>gone</html>'), url, 200, 'text/html; charset=UTF-8');
      },
      sleepImpl: async () => {},
    });
    assert.deepEqual(referers, ['https://gall.dcinside.com/post', undefined]);
    assert.equal(result.error.classification, 'permanent');
    if (mode === 'html') {
      assert.equal(result.error.error, 'Unsupported image binary');
      assert.equal(result.error.contentType, 'text/html; charset=UTF-8');
    }
  }
});

test('reuses an exact previous asset only while its local binary exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guidesearch-reuse-'));
  const html = '<img src="https://img.test/exact">';
  await persistGuideBackup(doc(html), { dataDir: root, fetchImpl: async (url) => response(PNG, url) });
  let calls = 0;
  const reused = await persistGuideBackup(doc(html), {
    dataDir: root, fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
  });
  assert.equal(reused.status, 'ok');
  assert.equal(calls, 0);

  const latest = JSON.parse(await fs.readFile(path.join(root, 'documents/guide/123/latest.json')));
  await fs.unlink(path.join(root, 'assets/guide/123', latest.assets[0].fileName));
  const fetched = await persistGuideBackup(doc(html), {
    dataDir: root, fetchImpl: async (url) => { calls += 1; return response(PNG, url); },
  });
  assert.equal(fetched.status, 'ok');
  assert.equal(calls, 1);
});

test('exhausted transient and permanent failures preserve a complete latest and versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guidesearch-protect-'));
  await persistGuideBackup(doc('<img src="https://img.test/good">'), {
    dataDir: root, fetchImpl: async (url) => response(PNG, url), backupAt: '2026-01-01T00:00:00.000Z',
  });
  const latestPath = path.join(root, 'documents/guide/123/latest.json');
  const originalLatest = await fs.readFile(latestPath, 'utf8');
  const originalVersions = await versions(root);
  let calls = 0;
  const transient = await persistGuideBackup(doc('<img src="https://img.test/transient">'), {
    dataDir: root, fetchImpl: async (url) => { calls += 1; return response(Buffer.alloc(0), url, 504); },
    sleepImpl: async () => {},
  });
  assert.equal(calls, 4);
  assert.equal(transient.status, 'asset_partial_failure');
  assert.equal(transient.assetErrors[0].classification, 'transient');

  const unavailable = await persistGuideBackup(doc('<img src="https://img.test/gone">'), {
    dataDir: root, fetchImpl: async (url) => response(Buffer.alloc(0), url, 410),
  });
  assert.equal(unavailable.status, 'asset_unavailable');
  assert.equal(await fs.readFile(latestPath, 'utf8'), originalLatest);
  assert.deepEqual(await versions(root), originalVersions);
});

test('retry-only skips permanent asset unavailability but retains transient failures', () => {
  const base = { docType: 'guide', postNo: '123', url: 'https://gall.dcinside.com/m/gov/123' };
  assert.equal(isRetryableStatusItem({ ...base, status: 'asset_unavailable' }), false);
  assert.equal(isRetryableStatusItem({ ...base, status: 'asset_partial_failure' }), true);
  assert.equal(isRetryableStatusItem({ ...base, status: 'network_error' }), true);
  assert.equal(isRetryableStatusItem({ ...base, status: 'rate_limited' }), true);
});
