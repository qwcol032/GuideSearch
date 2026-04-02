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

function toText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function statusKey(docType, postNo, url) {
  return `${docType}:${postNo || 'na'}:${url}`;
}

function updateStatus({
  docType,
  url,
  postNo,
  status,
  httpStatus = null,
  error = null,
  success = false,
  extra = {},
}) {
  const key = statusKey(docType, postNo, url);
  const prev = statusMap.get(key) || {
    docType,
    url,
    postNo,
    lastSuccessAt: null,
  };

  const next = {
    ...prev,
    ...extra,
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

function classifyHttpStatus(code) {
  if (code === 403) return 'forbidden';
  if (code === 404 || code === 410) return 'deleted';
  if (code === 429) return 'rate_limited';
  return 'network_error';
}

function isDcinsideHost(hostname) {
  return hostname === 'gall.dcinside.com';
}

function normalizeDcinsideUrl(url) {
  url.hash = '';
  return url.toString();
}

/**
 * Supports:
 * 1) query style:
 *    https://gall.dcinside.com/mgallery/board/view?id=gov&no=3624608
 * 2) path style:
 *    https://gall.dcinside.com/gov/1367754
 */

function sanitizeCandidateUrl(raw) {
  return (raw || '')
    .trim()
    .replace(/&amp;/gi, '&');
}

function parseDocMeta(urlString, baseUrl = undefined) {
  try {
    const cleaned = sanitizeCandidateUrl(urlString);
    const url = new URL(cleaned, baseUrl);

    if (!isDcinsideHost(url.hostname)) {
      return null;
    }

    let postNo = toText(url.searchParams.get('no'));
    let galleryId = toText(url.searchParams.get('id'));

    const parts = url.pathname.split('/').filter(Boolean);

    // 1) query style
    // /mgallery/board/view/?id=gov&no=5062108
    // /board/view/?id=gov&no=5062108
    if (!postNo) {
      // 2) short path style
      // /gov/5062108
      if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        galleryId = galleryId || parts[0];
        postNo = parts[1];
      }

      // 3) mobile path style
      // /m/gov/5062108
      else if (parts.length === 3 && parts[0] === 'm' && /^\d+$/.test(parts[2])) {
        galleryId = galleryId || parts[1];
        postNo = parts[2];
      }
    }

    if (!galleryId || !postNo || !/^\d+$/.test(postNo)) {
      return null;
    }

    url.hash = '';

    return {
      postNo,
      galleryId,
      normalizedUrl: url.toString(),
    };
  } catch {
    return null;
  }
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

    const cloned = node.clone();
    cloned.find('script, style, noscript').remove();

    const value = toText(cloned.text());
    if (value) return value;
  }

  return '';
}

function extractBodyHtml($) {
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

    const cloned = node.clone();
    cloned.find('script, style, noscript').remove();

    const html = (cloned.html() || '').trim();
    if (html) return html;
  }

  return '';
}

function extractFallbackBody($) {
  const parts = [];

  $('meta[property="og:description"], meta[name="description"]').each((_, el) => {
    const content = toText($(el).attr('content'));
    if (content) parts.push(content);
  });

  $('.write_div img, .gallview_contents img, .writing_view_box img, img').each((_, el) => {
    const alt = toText($(el).attr('alt'));
    const title = toText($(el).attr('title'));
    if (alt) parts.push(alt);
    else if (title) parts.push(title);
  });

  $('.appending_file a, .file_list a, .file_box a').each((_, el) => {
    const name = toText($(el).text());
    if (name) parts.push(`attachment:${name}`);
  });

  return toText(parts.join(' '));
}


function recordIgnoredCandidate({
  candidateUrl,
  reason,
  sourcePostNo = null,
  originLabel = null,
  contextText = '',
}) {
  updateStatus({
    docType: 'candidate',
    url: candidateUrl,
    postNo: null,
    status: 'ignored_unsupported_url',
    error: reason,
    extra: {
      sourcePostNo,
      originLabel,
      contextText: (contextText || '').slice(0, 300),
    },
  });
}

function extractGuideLinks($, baseUrl, preferredGalleryId, sourcePostNo) {
  const urlObjects = new Map();

  const contentArea = $(
    '.write_div, .view_content_wrap .write_div, .view_content .write_div'
  ).first();

  const searchRoot = contentArea.length ? contentArea : $('body');

  function tryAddCandidate(rawUrl, originLabel, contextText = '') {
    if (!rawUrl) return;
  
    try {
      const absolute = new URL(sanitizeCandidateUrl(rawUrl), baseUrl);
      if (!isDcinsideHost(absolute.hostname)) return;
  
      const meta = parseDocMeta(absolute.toString());
      if (!meta) {
        // anchor는 실제 클릭 가능한 링크라 디버그 가치가 큼
        // regex는 노이즈가 많으므로 기록하지 않음
        if (originLabel === 'anchor') {
          recordIgnoredCandidate({
            candidateUrl: absolute.toString(),
            reason: `Could not parse DCInside post metadata from ${originLabel}`,
            sourcePostNo,
            originLabel,
            contextText,
          });
        }
        return;
      }
  
      if (meta.postNo === sourcePostNo) return;
  
      if (!urlObjects.has(meta.postNo)) {
        urlObjects.set(meta.postNo, {
          url: meta.normalizedUrl,
          postNo: meta.postNo,
          galleryId: meta.galleryId,
        });
      }
    } catch {
      // malformed candidate URL
    }
  }

  searchRoot.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const anchorText = toText($(el).text());
    tryAddCandidate(href, 'anchor', anchorText);
  });

  const htmlText = searchRoot.html() || '';
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const matches = htmlText.match(urlRegex) || [];
  for (const raw of matches) {
    tryAddCandidate(raw, 'regex', raw);
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

async function fetchDocument(url, docType, postNo) {
  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
    });

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
    let body = extractBody($);
    const bodyHtml = extractBodyHtml($);

    if (!body) {
      body = extractFallbackBody($);
    }

    if (!title) {
      updateStatus({
        docType,
        url,
        postNo,
        status: 'parse_failed',
        httpStatus: response.status,
        error: 'Could not parse title with known selectors',
      });
      return null;
    }

    // 본문 텍스트가 거의 없는 이미지/첨부 위주 글도 저장되게 완화
    if (!body) {
      body = '[본문 텍스트 없음 / 이미지 또는 첨부 위주 게시글]';
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

    return {
      $,
      title,
      body,
      bodyHtml,
      finalUrl: response.url,
    };
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

  const documents = docs.map((doc) => {
    const fullBody = toText(doc.body);
    return {
      id: `${doc.docType}-${doc.postNo}`,
      docType: doc.docType,
      title: doc.title,
      body: fullBody,
      searchBody: fullBody,
      snippet: makeSnippet(fullBody),
      url: doc.url,
      postNo: doc.postNo,
      backupDate: doc.backupDate,
      status: 'ok',
      parentSourceId: doc.parentSourcePostNo
        ? `source-${doc.parentSourcePostNo}`
        : null,
    };
  });

  await writeJson(SEARCH_INDEX_PATH, {
    generatedAt: nowIso,
    documents,
  });
}

async function main() {
  const existingStatus = await readJson(CRAWL_STATUS_PATH, {
    generatedAt: null,
    items: [],
  });
  
  for (const item of existingStatus.items || []) {
    // candidate 디버그 로그는 매 실행마다 새로 계산
    if (item.docType === 'candidate') continue;
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
        error: 'Source URL is not a supported DCInside post format',
      });
      continue;
    }

    const sourceDoc = await fetchDocument(
      sourceMeta.normalizedUrl,
      'source',
      sourceMeta.postNo
    );
    if (!sourceDoc) continue;

    const sourceRecord = {
      id: `source-${sourceMeta.postNo}`,
      docType: 'source',
      title: sourceDoc.title,
      body: sourceDoc.body,
      bodyHtml: sourceDoc.bodyHtml || '',
      snippet: makeSnippet(sourceDoc.body),
      url: sourceMeta.normalizedUrl,
      postNo: sourceMeta.postNo,
      backupDate: today,
      parentSourcePostNo: null,
    };

    await persistDocument(sourceRecord);

    const links = extractGuideLinks(
      sourceDoc.$,
      sourceMeta.normalizedUrl,
      source.galleryId || sourceMeta.galleryId,
      sourceMeta.postNo
    );

    for (const link of links) {
      const guideDoc = await fetchDocument(link.url, 'guide', link.postNo);
      if (!guideDoc) continue;

      const guideRecord = {
        id: `guide-${link.postNo}`,
        docType: 'guide',
        title: guideDoc.title,
        body: guideDoc.body,
        bodyHtml: guideDoc.bodyHtml || '',
        snippet: makeSnippet(guideDoc.body),
        url: link.url,
        postNo: link.postNo,
        backupDate: today,
        parentSourcePostNo: sourceMeta.postNo,
      };

      await persistDocument(guideRecord);
    }
  }

  await buildSearchIndex();

  const items = [...statusMap.values()].sort((a, b) => {
    return String(a.url).localeCompare(String(b.url));
  });

  await writeJson(CRAWL_STATUS_PATH, {
    generatedAt: nowIso,
    items,
  });

  console.log(
    `Crawl complete. Search index written and ${items.length} status entries saved.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
