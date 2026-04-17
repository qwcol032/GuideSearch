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
const RETRY_FAILED_ONLY = process.env.RETRY_FAILED_ONLY === 'true';
const HIDDEN_SOURCE_POST_NO = '3538743';

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ko,en-US;q=0.8,en;q=0.6',
};

function extractAnchorContext($, el) {
  const anchor = $(el);

  // 1차: a 태그 자체 텍스트/속성
  const direct =
    toText(anchor.text()) ||
    toText(anchor.attr('title')) ||
    toText(anchor.attr('alt'));

  if (direct) return direct;

  // 2차: 가장 가까운 문단/리스트/셀의 전체 텍스트
  const container = anchor.closest('p, li, div, td');
  let surrounding = '';

  if (container.length) {
    surrounding = toText(container.text());
  } else {
    surrounding = toText(anchor.parent().text());
  }

  if (!surrounding) return '';

  // 흔한 노이즈 제거
  surrounding = surrounding
    .replace(/\bLINK\b/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return surrounding;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 일반 요청 전 대기: 1.5초 ~ 4초
async function waitBeforeRequest() {
  await sleep(randomInt(1000, 1500));
}

// 에러/차단 의심 시 더 길게 대기: 8초 ~ 20초
async function waitAfterBackoff() {
  await sleep(randomInt(8000, 20000));
}

const statusMap = new Map();

function toText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function statusKey(docType, postNo, url) {
  // 실제 게시글은 글번호 기준으로 하나의 상태만 유지
  if ((docType === 'guide' || docType === 'source') && postNo) {
    return `${docType}:${postNo}`;
  }

  // candidate 같은 디버그용 항목은 URL 기준 유지
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
  sourcePostNo = null,
  contextText = null,
  originLabel = null,
  extra = {},
}) {
  const key = statusKey(docType, postNo, url);
  const prev = statusMap.get(key) || {
    docType,
    url,
    postNo,
    lastSuccessAt: null,
  };

  const normalizedContext =
  typeof contextText === 'string' && contextText.trim()
    ? contextText.trim().slice(0, 300)
    : null;

  const next = {
    ...prev,
    ...extra,
    docType,
    url,
    postNo,
    sourcePostNo: sourcePostNo ?? prev.sourcePostNo ?? null,
    contextText: normalizedContext ?? prev.contextText ?? null,
    originLabel: originLabel ?? prev.originLabel ?? null,
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

function normalizeBodyHtml($, html) {
  if (!html) return '';

  const wrapped = cheerio.load(`<div id="__root__">${html}</div>`, {
    decodeEntities: false,
  });
  const root = wrapped('#__root__');

  root.find('img').each((_, el) => {
    const img = wrapped(el);

    const dataOriginal = img.attr('data-original');
    const src = img.attr('src') || '';

    // lazy-load placeholder면 실제 이미지 주소로 치환
    if (dataOriginal) {
      img.attr('src', dataOriginal);
      img.removeAttr('data-original');
    }

    // 로딩 gif만 src에 남아있고 실제 주소가 없으면 그대로 두되,
    // 보통 data-original이 있으면 위에서 대체됨
    if (src.includes('gallview_loading_ori.gif') && dataOriginal) {
      img.attr('src', dataOriginal);
    }

    // 새 글에서 필요 없는 DC 전용 속성 제거
    img.removeAttr('onclick');
    img.removeAttr('onerror');
    img.removeAttr('fetchpriority');

    // lazy 관련 class 제거
    const cls = (img.attr('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((name) => name !== 'lazy')
      .join(' ');

    if (cls) img.attr('class', cls);
    else img.removeAttr('class');
  });

  return root.html() || '';
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
    sourcePostNo,
    originLabel,
    contextText: (contextText || '').trim().slice(0, 300),
    status: 'ignored_unsupported_url',
    error: reason,
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
        recordIgnoredCandidate({
          candidateUrl: absolute.toString(),
          reason: `Could not parse DCInside post metadata from ${originLabel}`,
          sourcePostNo,
          originLabel,
          contextText,
        });
        return;
      }
  
      if (meta.postNo === sourcePostNo) return;
  
      const existing = urlObjects.get(meta.postNo);
      if (!existing) {
        urlObjects.set(meta.postNo, {
          url: meta.normalizedUrl,
          postNo: meta.postNo,
          galleryId: meta.galleryId,
          contextText: (contextText || '').trim(),
        });
        return;
      }
  
      // 이미 같은 글번호가 있어도 context가 비어 있으면 보강
      if (!existing.contextText && contextText) {
        existing.contextText = contextText.trim();
      }
    } catch {
      // malformed candidate URL
    }
  }

  searchRoot.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const anchorText = extractAnchorContext($, el);
    tryAddCandidate(href, 'anchor', anchorText);
  });

  const htmlText = searchRoot.html() || '';
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const matches = htmlText.match(urlRegex) || [];
  for (const raw of matches) {
    tryAddCandidate(raw, 'regex', raw);
  }

  const relativePathRegex = /\/m\/[a-zA-Z0-9_]+\/\d+\b|\/[a-zA-Z0-9_]+\/\d+\b/g;
  const relativeMatches = htmlText.match(relativePathRegex) || [];
  
  for (const raw of relativeMatches) {
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

function isRetryableStatusItem(item) {
  if (!item) return false;
  if (item.docType !== 'guide' && item.docType !== 'source') return false;
  if (!item.url || !item.postNo) return false;
  if (item.status === 'ok') return false;
  if (item.status === 'ignored_unsupported_url') return false;

  // 필요하면 3538743 source 계열은 재시도 대상에서도 제외
  if (String(item.sourcePostNo ?? '') === HIDDEN_SOURCE_POST_NO) return false;
  if (item.docType === 'source' && String(item.postNo ?? '') === HIDDEN_SOURCE_POST_NO) return false;

  return true;
}

async function retryFailedDocuments(existingStatusItems) {
  const retryTargets = (existingStatusItems || []).filter(isRetryableStatusItem);

  console.log(`Retry-only mode enabled. ${retryTargets.length} failed item(s) will be retried.`);

  for (const item of retryTargets) {
    const sourcePostNo =
      item.docType === 'source'
        ? item.postNo
        : (item.sourcePostNo ?? null);

    const doc = await fetchDocument(
      item.url,
      item.docType,
      item.postNo,
      sourcePostNo,
      item.contextText || null
    );

    if (!doc) continue;

    const record = {
      id: `${item.docType}-${item.postNo}`,
      docType: item.docType,
      title: doc.title,
      body: doc.body,
      bodyHtml: doc.bodyHtml || '',
      snippet: makeSnippet(doc.body),
      url: item.url,
      postNo: item.postNo,
      backupDate: today,
      parentSourcePostNo: item.docType === 'guide' ? sourcePostNo : null,
    };

    await persistDocument(record);
  }
}

async function fetchDocument(
  url,
  docType,
  postNo,
  sourcePostNo = null,
  contextText = null
) {
  try {
    await waitBeforeRequest();

    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
    });

    if (!response.ok) {
      updateStatus({
        docType,
        url,
        postNo,
        sourcePostNo,
        contextText,
        originLabel: 'fetch',
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
    const rawBodyHtml = extractBodyHtml($);
    const bodyHtml = normalizeBodyHtml($, rawBodyHtml);

    if (!body) {
      body = extractFallbackBody($);
    }

    if (!title) {
      updateStatus({
        docType,
        url,
        postNo,
        sourcePostNo,
        contextText,
        originLabel: 'fetch',
        status: 'parse_failed',
        httpStatus: response.status,
        error: 'Could not parse title with known selectors',
      });
      return null;
    }

    if (!body) {
      body = '[본문 텍스트 없음 / 이미지 또는 첨부 위주 게시글]';
    }

    updateStatus({
      docType,
      url,
      postNo,
      sourcePostNo,
      contextText,
      originLabel: 'fetch',
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
    await waitAfterBackoff();

    updateStatus({
      docType,
      url,
      postNo,
      sourcePostNo,
      contextText,
      originLabel: 'fetch',
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

  // 같은 글번호가 source/guide 둘 다 있을 때 하나만 남김
  // 우선순위: guide > source
  const deduped = new Map();

  for (const doc of docs) {
    const key = String(doc.postNo);
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, doc);
      continue;
    }

    const existingPriority = existing.docType === 'guide' ? 2 : 1;
    const currentPriority = doc.docType === 'guide' ? 2 : 1;

    if (currentPriority > existingPriority) {
      deduped.set(key, doc);
      continue;
    }

    // 같은 우선순위면 backupDate가 더 최신인 쪽 유지
    if (currentPriority === existingPriority) {
      const existingDate = existing.backupDate || '';
      const currentDate = doc.backupDate || '';
      if (currentDate > existingDate) {
        deduped.set(key, doc);
      }
    }
  }

  const documents = [...deduped.values()].map((doc) => {
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
  
    const key = statusKey(item.docType, item.postNo, item.url);
    const prev = statusMap.get(key);
  
    if (!prev) {
      statusMap.set(key, item);
      continue;
    }
  
    // sourcePostNo가 있는 쪽 우선
    const prevHasSource = !!prev.sourcePostNo;
    const currentHasSource = !!item.sourcePostNo;
  
    if (!prevHasSource && currentHasSource) {
      statusMap.set(key, item);
      continue;
    }
  
    // 둘 다 같으면 lastAttemptAt이 더 최신인 쪽 유지
    if ((item.lastAttemptAt || '') > (prev.lastAttemptAt || '')) {
      statusMap.set(key, item);
    }
  }

  if (RETRY_FAILED_ONLY) {
  await retryFailedDocuments(existingStatus.items || []);
  await buildSearchIndex();

  const items = [...statusMap.values()].sort((a, b) => {
    return String(a.url).localeCompare(String(b.url));
  });

  await writeJson(CRAWL_STATUS_PATH, {
    generatedAt: nowIso,
    items,
  });

  console.log(
    `Retry-only crawl complete. Search index written and ${items.length} status entries saved.`
  );
  return;
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
        sourcePostNo,
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
      const guideDoc = await fetchDocument(
        link.url,
        'guide',
        link.postNo,
        sourceMeta.postNo,
        link.contextText || null
      );
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
