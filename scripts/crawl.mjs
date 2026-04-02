import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SOURCES_PATH = path.join(DATA_DIR, 'sources.json');
const SEARCH_INDEX_PATH = path.join(DATA_DIR, 'search-index.json');
const CRAWL_STATUS_PATH = path.join(DATA_DIR, 'crawl-status.json');

const today = new Date().toISOString().slice(0, 10);
const nowIso = new Date().toISOString();

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ko,en-US;q=0.8,en;q=0.6',
};

const statusMap = new Map();

function parseDocMeta(urlString) {
  try {
    const url = new URL(urlString);
    const postNo = url.searchParams.get('no');
    const galleryId = url.searchParams.get('id');
    if (!postNo) return null;
    return { postNo, galleryId, normalizedUrl: url.toString() };
  } catch {
    return null;
  }
}

function classifyHttpStatus(code) {
  if (code === 403) return 'forbidden';
  if (code === 404 || code === 410) return 'deleted';
  if (code === 429) return 'rate_limited';
  if (code >= 500) return 'network_error';
  return 'network_error';
}

function toText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractTitle($) {
  const candidates = [
    '.title_subject',
    '.view_content_wrap .title_subject',
    '.view_content .title_subject',
    '.gallview_head .title_subject',
    'meta[property="og:title"]',
    'title',
  ];

  for (const selector of candidates) {
    if (selector.startsWith('meta')) {
      const value = $(selector).attr('content');
      if (toText(value)) return toText(value);
      continue;
    }

    const value = toText($(selector).first().text());
    if (value) return value;
  }

  return 'Untitled';
}

function extractBody($) {
  const candidates = [
    '.write_div',
    '.view_content_wrap .write_div',
    '.view_content .write_div',
    '.gallview_contents',
    '.memo_write',
  ];

  for (const selector of candidates) {
    const node = $(selector).first();
    if (!node.length) continue;

    node.find('script, style, noscript').remove();
    const value = toText(node.text());
    if (value) return value;
  }

  return '';
}

function extractGuideLinks($, baseUrl, preferredGalleryId) {
  const urlObjects = new Map();

  const contentArea = $('.write_div, .view_content_wrap .write_div, .view_content .write_div').first();
  const anchors = (contentArea.length ? contentArea : $('body')).find('a[href]');

  anchors.each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      const absolute = new URL(href, baseUrl);
      if (!absolute.hostname.includes('dcinside.com')) return;

      const postNo = absolute.searchParams.get('no');
      if (!postNo) return;

      absolute.hash = '';
      const normalized = absolute.toString();
      if (!urlObjects.has(postNo)) {
        urlObjects.set(postNo, {
          url: normalized,
          postNo,
          galleryId: absolute.searchParams.get('id') || null,
        });
      }
    } catch {
      // Ignore malformed href.
    }
  });

  // Regex fallback for plain-text links in content.
  if (contentArea.length) {
    const htmlText = contentArea.html() || '';
    const regex = /https?:\/\/[^\s"'<>]*dcinside\.com[^\s"'<>]*/gi;
    const matches = htmlText.match(regex) || [];

    for (const raw of matches) {
      try {
        const absolute = new URL(raw, baseUrl);
        const postNo = absolute.searchParams.get('no');
        if (!postNo) continue;
        absolute.hash = '';
        if (!urlObjects.has(postNo)) {
          urlObjects.set(postNo, {
            url: absolute.toString(),
            postNo,
            galleryId: absolute.searchParams.get('id') || null,
          });
        }
      } catch {
        // Ignore malformed URL in regex match.
      }
    }
  }

  return [...urlObjects.values()].sort((a, b) => {
    const aPreferred = a.galleryId === preferredGalleryId ? 0 : 1;
    const bPreferred = b.galleryId === preferredGalleryId ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    return Number(a.postNo) - Number(b.postNo);
  });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function statusKey(docType, postNo, url) {
  return `${docType}:${postNo || 'na'}:${url}`;
}

function updateStatus({ docType, url, postNo, status, httpStatus = null, error = null, success = false }) {
  const key = statusKey(docType, postNo, url);
  const prev = statusMap.get(key) || {
    docType,
    url,
    postNo,
    lastSuccessAt: null,
  };

  const next = {
    ...prev,
    docType,
    url,
    postNo,
    status,
    httpStatus,
    error,
    lastAttemptAt: nowIso,
    lastSuccessAt: success ? nowIso : prev.lastSuccessAt,
  };

  statusMap.set(key, next);
}

async function fetchDocument(url, docType, postNo) {
  try {
    const response = await fetch(url, { headers: DEFAULT_HEADERS, redirect: 'follow' });
    if (!response.ok) {
      updateStatus({
        docType,
        url,
        postNo,
        status: classifyHttpStatus(response.status),
        httpStatus: response.status,
        error: `HTTP ${response.status}`,
      });
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const title = extractTitle($);
    const body = extractBody($);

    if (!title || !body) {
      updateStatus({
        docType,
        url,
        postNo,
        status: 'parse_failed',
        httpStatus: response.status,
        error: 'Could not parse title/body with known selectors',
      });
      return null;
    }

    updateStatus({
      docType,
      url,
      postNo,
      status: 'ok',
      httpStatus: response.status,
      error: null,
      success: true,
    });

    return { $, title, body, finalUrl: response.url };
  } catch (error) {
    updateStatus({
      docType,
      url,
      postNo,
      status: 'network_error',
      httpStatus: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function persistDocument(document) {
  const baseDir = path.join(DATA_DIR, 'documents', document.docType, document.postNo);
  const datedPath = path.join(baseDir, `${today}.json`);
  const latestPath = path.join(baseDir, 'latest.json');

  const existingDated = await readJson(datedPath, null);
  if (!existingDated) {
    await writeJson(datedPath, document);
  }
  await writeJson(latestPath, document);
}

function makeSnippet(body, query = '', maxLength = 200) {
  const text = toText(body);
  if (!text) return '';
  if (!query) return text.slice(0, maxLength);

  const lower = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lower.indexOf(lowerQuery);

  if (idx < 0) return text.slice(0, maxLength);

  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + lowerQuery.length + 100);
  return text.slice(start, end);
}

async function loadLatestDocuments() {
  const all = [];
  for (const docType of ['source', 'guide']) {
    const typeDir = path.join(DATA_DIR, 'documents', docType);
    let postDirs = [];
    try {
      postDirs = await fs.readdir(typeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of postDirs) {
      if (!dirent.isDirectory()) continue;
      const latestPath = path.join(typeDir, dirent.name, 'latest.json');
      const doc = await readJson(latestPath, null);
      if (doc) all.push(doc);
    }
  }
  return all;
}

async function buildSearchIndex() {
  const docs = await loadLatestDocuments();
  const documents = docs.map((doc) => ({
    id: `${doc.docType}-${doc.postNo}`,
    docType: doc.docType,
    title: doc.title,
    body: doc.body,
    snippet: makeSnippet(doc.body),
    url: doc.url,
    postNo: doc.postNo,
    backupDate: doc.backupDate,
    status: 'ok',
    parentSourceId: doc.parentSourcePostNo ? `source-${doc.parentSourcePostNo}` : null,
  }));

  await writeJson(SEARCH_INDEX_PATH, {
    generatedAt: nowIso,
    documents,
  });
}

async function main() {
  const existingStatus = await readJson(CRAWL_STATUS_PATH, { generatedAt: null, items: [] });
  for (const item of existingStatus.items || []) {
    statusMap.set(statusKey(item.docType, item.postNo, item.url), item);
  }

  const sourcesData = await readJson(SOURCES_PATH, { sources: [] });

  for (const source of sourcesData.sources || []) {
    if (!source.enabled) continue;

    const sourceMeta = parseDocMeta(source.url);
    if (!sourceMeta) {
      updateStatus({
        docType: 'source',
        url: source.url,
        postNo: null,
        status: 'parse_failed',
        error: 'Source URL missing no= query parameter',
      });
      continue;
    }

    const sourceDoc = await fetchDocument(sourceMeta.normalizedUrl, 'source', sourceMeta.postNo);
    if (!sourceDoc) continue;

    const sourceRecord = {
      id: `source-${sourceMeta.postNo}`,
      docType: 'source',
      title: sourceDoc.title,
      body: sourceDoc.body,
      snippet: makeSnippet(sourceDoc.body),
      url: sourceMeta.normalizedUrl,
      postNo: sourceMeta.postNo,
      backupDate: today,
      parentSourcePostNo: null,
    };

    await persistDocument(sourceRecord);

    const links = extractGuideLinks(sourceDoc.$, sourceMeta.normalizedUrl, source.galleryId || sourceMeta.galleryId);

    for (const link of links) {
      const guide = await fetchDocument(link.url, 'guide', link.postNo);
      if (!guide) continue;

      const guideRecord = {
        id: `guide-${link.postNo}`,
        docType: 'guide',
        title: guide.title,
        body: guide.body,
        snippet: makeSnippet(guide.body),
        url: link.url,
        postNo: link.postNo,
        backupDate: today,
        parentSourcePostNo: sourceMeta.postNo,
      };

      await persistDocument(guideRecord);
    }
  }

  await buildSearchIndex();

  const items = [...statusMap.values()].sort((a, b) => a.url.localeCompare(b.url));
  await writeJson(CRAWL_STATUS_PATH, {
    generatedAt: nowIso,
    items,
  });

  console.log(`Crawl complete. Documents indexed and ${items.length} status entries written.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
