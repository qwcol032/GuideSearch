import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SOURCES_PATH = path.join(DATA_DIR, 'sources.json');
const SEARCH_INDEX_PATH = path.join(DATA_DIR, 'search-index.json');
const CRAWL_STATUS_PATH = path.join(DATA_DIR, 'crawl-status.json');
const TEST_DATA_DIR = path.join(DATA_DIR, 'test');

const today = new Date().toISOString().slice(0, 10);
const nowIso = new Date().toISOString();
const RETRY_FAILED_ONLY = process.env.RETRY_FAILED_ONLY === 'true';
const HIDDEN_SOURCE_POST_NO = '3538743';
const SUPPORTED_GALLERY_ID = 'gov';
const TEST_MODE = process.env.TEST_MODE === 'true' || process.argv.includes('--test');

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
  await sleep(randomInt(2000, 2500));
}

// 에러/차단 의심 시 더 길게 대기: 8초 ~ 20초
async function waitAfterBackoff() {
  await sleep(randomInt(8000, 20000));
}

const statusMap = new Map();

function toText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function isSupportedGuideMeta(meta, preferredGalleryId = SUPPORTED_GALLERY_ID) {
  if (!meta) return false;
  const galleryId = toText(preferredGalleryId || SUPPORTED_GALLERY_ID);
  return meta.galleryId === galleryId;
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeBackupHtml(html) {
  const wrapped = cheerio.load(`<div id="__root__">${html || ''}</div>`, {
    decodeEntities: false,
  });
  const root = wrapped('#__root__');

  root.find('script, style, noscript, iframe, object, embed, video, audio, base, meta, link, form').remove();
  root.find('*').each((_, element) => {
    const node = wrapped(element);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (/^on/i.test(attribute) || ['fetchpriority', 'srcset', 'style'].includes(attribute.toLowerCase())) {
        node.removeAttr(attribute);
      }
    }
    const href = node.attr('href');
    if (href && /^\s*(?:javascript|data|vbscript):/i.test(href)) node.removeAttr('href');
  });
  root.find('img').each((_, element) => {
    const image = wrapped(element);
    const actualSource = image.attr('data-original') || image.attr('src');
    if (actualSource) image.attr('src', actualSource);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (/^data-(original|src|lazy)/i.test(attribute)) image.removeAttr(attribute);
    }
    image.removeAttr('loading');
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
      if (!meta) return;
      if (!isSupportedGuideMeta(meta, preferredGalleryId)) return;
  
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
    const parentText = toText($(el).closest('p, li, div, td').text());
    const anchorText =
      parentText ||
      toText($(el).text()) ||
      toText($(el).attr('title')) ||
      toText($(el).attr('alt')) ||
      '';
  
    tryAddCandidate(href, 'anchor', anchorText);
  });

  const htmlText = searchRoot.html() || '';
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const matches = htmlText.match(urlRegex) || [];
  for (const raw of matches) {
    tryAddCandidate(raw, 'regex', raw);
  }

  const preferredGalleryPattern = escapeRegExp(preferredGalleryId || SUPPORTED_GALLERY_ID);
  const relativePathRegex = new RegExp(
    `/m/${preferredGalleryPattern}/\\d+\\b|/${preferredGalleryPattern}/\\d+\\b`,
    'g'
  );
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


async function findContextFromSourcePost(sourcePostNo, targetPostNo) {
  if (!sourcePostNo || !targetPostNo) return null;

  const sourceUrl = `https://gall.dcinside.com/mgallery/board/view/?id=gov&no=${sourcePostNo}`;
  const sourceDoc = await fetchDocument(
    sourceUrl,
    'source',
    sourcePostNo,
    sourcePostNo,
    null
  );

  if (!sourceDoc) return null;

  const links = extractGuideLinks(
    sourceDoc.$,
    sourceUrl,
    'gov',
    sourcePostNo
  );

  const matched = links.find((link) => String(link.postNo) === String(targetPostNo));
  return matched?.contextText || null;
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

function pruneStaleDeletedGuideStatuses({
  discoveredGuideKeys,
  scannedSourcePostNos,
}) {
  let removedCount = 0;

  for (const [key, item] of statusMap.entries()) {
    if (item.docType !== 'guide') continue;

    const isDeletedGuide =
      item.status === 'deleted' ||
      item.httpStatus === 404 ||
      item.httpStatus === 410;

    if (!isDeletedGuide) continue;

    const sourcePostNo = String(item.sourcePostNo ?? '');

    // 어떤 source에서 온 건지 모르면 안전하게 유지
    if (!sourcePostNo) continue;

    // 이번 crawl에서 해당 source 모음글을 성공적으로 읽은 경우에만 정리
    // source 자체를 못 읽었으면 링크가 사라진 건지 판단 불가
    if (!scannedSourcePostNos.has(sourcePostNo)) continue;

    const itemKey = statusKey('guide', item.postNo, item.url);

    // 이번에 source 모음글에서 다시 발견되지 않은 deleted guide면 제거
    if (!discoveredGuideKeys.has(itemKey)) {
      statusMap.delete(key);
      removedCount += 1;
    }
  }

  return removedCount;
}

function pruneUnsupportedStatusItems() {
  let removedCount = 0;

  for (const [key, item] of statusMap.entries()) {
    if (item.docType === 'candidate' && item.status === 'ignored_unsupported_url') {
      statusMap.delete(key);
      removedCount += 1;
      continue;
    }

    if (item.docType !== 'guide') continue;
    if (item.status === 'ok') continue;

    const meta = parseDocMeta(item.url);
    if (isSupportedGuideMeta(meta)) continue;

    statusMap.delete(key);
    removedCount += 1;
  }

  return removedCount;
}

function isRetryableStatusItem(item) {
  if (!item) return false;
  if (item.docType !== 'guide' && item.docType !== 'source') return false;
  if (!item.url || !item.postNo) return false;
  if (item.status === 'ok') return false;
  if (item.status === 'ignored_unsupported_url') return false;

  if (item.docType === 'guide') {
    const meta = parseDocMeta(item.url);
    if (!isSupportedGuideMeta(meta)) return false;
  }

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

    let retryContext = item.contextText || null;
    
    if (
      !retryContext &&
      item.docType === 'guide' &&
      sourcePostNo
    ) {
      retryContext = await findContextFromSourcePost(sourcePostNo, item.postNo);
    }
    
    const doc = await fetchDocument(
      item.url,
      item.docType,
      item.postNo,
      sourcePostNo,
      retryContext
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

    const outcome = await persistDocument(record);
    if (item.docType === 'guide') {
      updateStatus({ docType: 'guide', url: item.url, postNo: item.postNo,
        sourcePostNo, contextText: retryContext, status: outcome.status,
        httpStatus: 200, success: outcome.status === 'ok',
        error: outcome.status === 'ok' ? null : 'One or more images could not be backed up',
        extra: { backupResult: outcome.backupResult, assetErrors: outcome.assetErrors } });
    }
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
  if (document.docType === 'guide') return persistGuideBackup(document);
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

function testPostNumbers() {
  const cliValue = process.argv.find((arg) => arg.startsWith('--posts='))?.slice(8);
  const values = (cliValue || process.env.TEST_POST_NOS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = values.filter((item) => !/^\d+$/.test(item));
  if (invalid.length) throw new Error(`Invalid test post number(s): ${invalid.join(', ')}`);
  return [...new Set(values)];
}

function extensionForImage(contentType, url) {
  const mime = (contentType || '').split(';', 1)[0].trim().toLowerCase();
  const byMime = new Map([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
  ]);
  if (byMime.has(mime)) return byMime.get(mime);
  if (mime && mime !== 'application/octet-stream') return null;
  try {
    const match = new URL(url).pathname.match(/\.((?:jpe?g|png|gif|webp))$/i);
    return match ? (match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()) : null;
  } catch {
    return null;
  }
}

function imageFormatFromSignature(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', contentType: 'image/jpeg', detectedBy: 'signature' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', contentType: 'image/png', detectedBy: 'signature' };
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { extension: 'gif', contentType: 'image/gif', detectedBy: 'signature' };
    }
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', contentType: 'image/webp', detectedBy: 'signature' };
  }
  return null;
}

function looksLikeMarkup(buffer) {
  const beginning = buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return beginning.startsWith('<!doctype html') || beginning.startsWith('<html') ||
    beginning.startsWith('<?xml') || beginning.startsWith('<svg');
}

export function detectImageFormat(buffer, contentType, url) {
  const signatureFormat = imageFormatFromSignature(buffer);
  if (signatureFormat) return signatureFormat;

  // A proxy can label an HTML error response as an image. Do not let the
  // weaker header/URL fallbacks turn such a response into a local image.
  if (looksLikeMarkup(buffer)) return null;

  const extensionFromContentType = extensionForImage(contentType, '');
  if (extensionFromContentType) {
    return {
      extension: extensionFromContentType,
      contentType: `image/${extensionFromContentType === 'jpg' ? 'jpeg' : extensionFromContentType}`,
      detectedBy: 'content-type',
    };
  }

  const extensionFromUrl = extensionForImage('', url);
  if (!extensionFromUrl) return null;
  return {
    extension: extensionFromUrl,
    contentType: `image/${extensionFromUrl === 'jpg' ? 'jpeg' : extensionFromUrl}`,
    detectedBy: 'url',
  };
}

export async function backupImages(html, postUrl, postNo, documentDir, {
  dataDir = DATA_DIR,
  fetchImpl = fetch,
} = {}) {
  const wrapped = cheerio.load(`<div id="__root__">${sanitizeBackupHtml(html)}</div>`, {
    decodeEntities: false,
  });
  const root = wrapped('#__root__');
  const assetDir = path.join(dataDir, 'assets', 'guide', postNo);
  const assets = [];
  const assetErrors = [];
  const downloadedByUrl = new Map();
  let imagesDownloaded = 0;

  for (const element of root.find('img').toArray()) {
    const image = wrapped(element);
    const rawSource = image.attr('src');
    if (!rawSource) continue;
    let sourceUrl;
    try {
      sourceUrl = new URL(rawSource, postUrl).toString();
      if (!/^https?:$/.test(new URL(sourceUrl).protocol)) throw new Error('Unsupported image URL protocol');
    } catch {
      assetErrors.push({ url: rawSource, error: 'Invalid image URL' });
      image.removeAttr('src');
      continue;
    }

    try {
      let saved = downloadedByUrl.get(sourceUrl);
      if (!saved) {
        const response = await fetchImpl(sourceUrl, {
          headers: { ...DEFAULT_HEADERS, accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8', referer: postUrl },
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const binary = Buffer.from(await response.arrayBuffer());
        const responseContentType = response.headers.get('content-type');
        const detected = detectImageFormat(binary, responseContentType, response.url || sourceUrl);
        if (!detected) {
          const error = new Error('Unsupported image binary');
          error.assetDetails = { contentType: responseContentType || 'unknown', size: binary.length };
          throw error;
        }
        const { extension } = detected;
        const imageHash = sha256(binary);
        const fileName = `${imageHash}.${extension}`;
        const filePath = path.join(assetDir, fileName);
        await fs.mkdir(assetDir, { recursive: true });
        try {
          await fs.access(filePath);
        } catch {
          await fs.writeFile(filePath, binary);
          imagesDownloaded += 1;
        }
        saved = { hash: imageHash, fileName, sourceUrl, contentType: detected.contentType, detectedBy: detected.detectedBy };
        downloadedByUrl.set(sourceUrl, saved);
        if (!assets.some((asset) => asset.hash === saved.hash)) assets.push(saved);
      }
      const relativePath = path.relative(documentDir, path.join(assetDir, saved.fileName)).split(path.sep).join('/');
      image.attr('src', relativePath);
    } catch (error) {
      image.attr('src', sourceUrl);
      assetErrors.push({
        url: sourceUrl,
        error: error instanceof Error ? error.message : String(error),
        ...(error?.assetDetails || {}),
      });
    }
  }

  return { bodyHtml: root.html() || '', assets, assetErrors, imagesDownloaded };
}

export function contentHashFor(document, orderedImageHashes) {
  const normalizedTitle = toText(document.title);
  const hashHtml = cheerio.load(`<div id="__root__">${document.bodyHtml}</div>`, { decodeEntities: false });
  hashHtml('#__root__ img').each((index, element) => {
    const hash = orderedImageHashes[index];
    if (hash) hashHtml(element).attr('src', `asset:${hash}`);
  });
  const normalizedHtml = (hashHtml('#__root__').html() || '').replace(/>\s+</g, '><').trim();
  return sha256(JSON.stringify([normalizedTitle, normalizedHtml, orderedImageHashes]));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function buildPreviewHtml(document) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.title)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.65;max-width:900px;margin:auto;padding:24px;color:#222}img{max-width:100%;height:auto}header{border-bottom:1px solid #ddd;margin-bottom:24px}a{overflow-wrap:anywhere}</style></head>
<body><header><h1>${escapeHtml(document.title)}</h1><p>원본: <a href="${escapeHtml(document.url)}">${escapeHtml(document.url)}</a><br>백업 시각: <time>${escapeHtml(document.backupAt)}</time></p></header><main>${document.bodyHtml}</main></body></html>\n`;
}


function orderedHashesFor(record) {
  const hashes = [];
  const parsed = cheerio.load(`<div id="__root__">${record.bodyHtml || ''}</div>`);
  parsed('#__root__ img').each((_, image) => {
    const fileName = path.basename(parsed(image).attr('src') || '');
    hashes.push(record.assets.find((item) => item.fileName === fileName)?.hash || 'unavailable');
  });
  return hashes;
}

// Shared by test and production. Partial downloads never publish an
// incomplete latest/version/preview, though successful assets remain reusable.
export async function persistGuideBackup(document, {
  dataDir = DATA_DIR, fetchImpl = fetch, backupAt = new Date().toISOString(),
} = {}) {
  const documentDir = path.join(dataDir, 'documents', 'guide', String(document.postNo));
  const latestPath = path.join(documentDir, 'latest.json');
  const previous = await readJson(latestPath, null);
  const imageResult = await backupImages(document.bodyHtml, document.finalUrl || document.url,
    String(document.postNo), documentDir, { dataDir, fetchImpl });
  if (imageResult.assetErrors.length) {
    return { backupResult: null, status: 'asset_partial_failure', previous, ...imageResult };
  }

  const record = { ...document, bodyHtml: imageResult.bodyHtml, backupAt,
    backupDate: backupAt.slice(0, 10), assets: imageResult.assets, assetErrors: [] };
  delete record.finalUrl;
  record.contentHash = contentHashFor(record, orderedHashesFor(record));
  if (previous?.contentHash === record.contentHash) {
    return { backupResult: 'unchanged', status: 'ok', record: previous, ...imageResult };
  }

  const backupResult = previous ? 'changed' : 'new';
  const safeTimestamp = backupAt.replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
  await writeJson(path.join(documentDir, 'versions', `${safeTimestamp}_${record.contentHash.slice(0, 12)}.json`), record);
  await writeJson(latestPath, record);
  await fs.writeFile(path.join(documentDir, 'preview.html'), buildPreviewHtml(record), 'utf8');
  return { backupResult, status: 'ok', record, ...imageResult };
}

async function buildTestSearchIndex() {
  const guideDir = path.join(TEST_DATA_DIR, 'documents', 'guide');
  let entries = [];
  try { entries = await fs.readdir(guideDir, { withFileTypes: true }); } catch { /* first run */ }
  const documents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const doc = await readJson(path.join(guideDir, entry.name, 'latest.json'), null);
    if (!doc) continue;
    documents.push({
      id: doc.id, docType: doc.docType, title: doc.title, body: doc.body,
      searchBody: toText(doc.body), snippet: makeSnippet(doc.body), url: doc.url,
      postNo: doc.postNo, backupDate: doc.backupAt.slice(0, 10), status: 'ok', parentSourceId: null,
    });
  }
  documents.sort((a, b) => Number(a.postNo) - Number(b.postNo));
  await writeJson(path.join(TEST_DATA_DIR, 'search-index.json'), { generatedAt: new Date().toISOString(), documents });
}

async function runTestMode() {
  const postNos = testPostNumbers();
  if (!postNos.length) throw new Error('Test mode requires TEST_POST_NOS or --posts=NUMBER,NUMBER');
  const galleryId = toText(process.env.TEST_GALLERY_ID) || SUPPORTED_GALLERY_ID;
  if (!/^[a-zA-Z0-9_-]+$/.test(galleryId)) throw new Error('Invalid TEST_GALLERY_ID');
  const summary = { total: postNos.length, new: 0, changed: 0, unchanged: 0, failed: 0, imagesDownloaded: 0, imageFailures: 0 };
  const statusItems = [];

  for (const postNo of postNos) {
    const url = `https://gall.dcinside.com/mgallery/board/view?id=${encodeURIComponent(galleryId)}&no=${postNo}`;
    const doc = await fetchDocument(url, 'guide', postNo);
    if (!doc) {
      const failure = statusMap.get(statusKey('guide', postNo, url));
      statusItems.push(failure || { docType: 'guide', postNo, url, status: 'network_error', error: 'Unknown fetch error', lastAttemptAt: new Date().toISOString() });
      summary.failed += 1;
      console.log(`[FAILED] #${postNo}`);
      continue;
    }

    const backupAt = new Date().toISOString();
    const outcome = await persistGuideBackup({
      id: `guide-${postNo}`, docType: 'guide', title: doc.title, body: doc.body,
      bodyHtml: doc.bodyHtml, snippet: makeSnippet(doc.body), url, postNo,
      finalUrl: doc.finalUrl,
    }, { dataDir: TEST_DATA_DIR, backupAt });
    summary.imagesDownloaded += outcome.imagesDownloaded;
    summary.imageFailures += outcome.assetErrors.length;
    if (outcome.status === 'ok') summary[outcome.backupResult] += 1;
    else summary.failed += 1;
    console.log(`[${(outcome.backupResult || outcome.status).toUpperCase()}] #${postNo}`);
    statusItems.push({
      docType: 'guide', postNo, url, status: outcome.status,
      backupResult: outcome.backupResult, httpStatus: 200,
      error: outcome.assetErrors.length ? 'One or more images could not be backed up' : null,
      assetErrors: outcome.assetErrors, contentHash: outcome.record?.contentHash || null,
      lastAttemptAt: backupAt, lastSuccessAt: outcome.status === 'ok' ? backupAt : null,
    });
  }

  await buildTestSearchIndex();
  await writeJson(path.join(TEST_DATA_DIR, 'crawl-status.json'), { generatedAt: new Date().toISOString(), items: statusItems, summary });
  console.log(`\nTest backup complete.\n\nTotal: ${summary.total}\nNew: ${summary.new}\nChanged: ${summary.changed}\nUnchanged: ${summary.unchanged}\nFailed: ${summary.failed}\nImages downloaded: ${summary.imagesDownloaded}\nImage failures: ${summary.imageFailures}`);
}

async function main() {
  if (TEST_MODE) {
    await runTestMode();
    return;
  }
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
  const removedUnsupportedCount = pruneUnsupportedStatusItems();
  if (removedUnsupportedCount > 0) {
    console.log(
      `Removed ${removedUnsupportedCount} unsupported status item(s).`
    );
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
    `Retry-only crawl complete. Search index written and ${items.length} status entries saved.`
  );
  return;
}

  const discoveredGuideKeys = new Set();
  const scannedSourcePostNos = new Set();
  const processedGuidePostNos = new Set();
  
  const sourcesData = await readJson(SOURCES_PATH, { sources: [] });

  for (const source of sourcesData.sources || []) {
    if (!source.enabled) continue;

    const sourceMeta = parseDocMeta(source.url);
    if (!sourceMeta) {
      updateStatus({
        docType: 'source',
        url: source.url,
        postNo: null,
        sourcePostNo: null,
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

    scannedSourcePostNos.add(String(sourceMeta.postNo));

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
      discoveredGuideKeys.add(statusKey('guide', link.postNo, link.url));
      if (processedGuidePostNos.has(String(link.postNo))) continue;
      processedGuidePostNos.add(String(link.postNo));
    
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

      const outcome = await persistDocument({ ...guideRecord, finalUrl: guideDoc.finalUrl });
      updateStatus({
        docType: 'guide', url: link.url, postNo: link.postNo,
        sourcePostNo: sourceMeta.postNo, contextText: link.contextText || null,
        status: outcome.status, httpStatus: 200, success: outcome.status === 'ok',
        error: outcome.status === 'ok' ? null : 'One or more images could not be backed up',
        extra: { backupResult: outcome.backupResult, assetErrors: outcome.assetErrors,
          contentHash: outcome.record?.contentHash || null },
      });
    }
  }

  const removedStaleDeletedCount = pruneStaleDeletedGuideStatuses({
    discoveredGuideKeys,
    scannedSourcePostNos,
  });
  const removedUnsupportedCount = pruneUnsupportedStatusItems();
  
  if (removedStaleDeletedCount > 0) {
    console.log(
      `Removed ${removedStaleDeletedCount} stale deleted guide status item(s).`
    );
  }

  if (removedUnsupportedCount > 0) {
    console.log(
      `Removed ${removedUnsupportedCount} unsupported status item(s).`
    );
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

if (path.resolve(process.argv[1] || '') === __filename) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
