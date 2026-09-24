import { buildRestorePayload, serializeRestorePayload } from './restore-payload.js';

const els = {
  form: document.getElementById('search-form'),
  query: document.getElementById('query'),
  results: document.getElementById('results'),
  resultMeta: document.getElementById('result-meta'),
  empty: document.getElementById('empty-message'),
  resultTemplate: document.getElementById('result-template'),
  statusList: document.getElementById('status-list'),
  toggleOk: document.getElementById('toggle-ok'),
  restoreMessage: document.getElementById('restore-message'),
};

let indexData = { documents: [] };
let statusData = { items: [] };
const currentUrl = new URL(window.location.href);

const testDataMode =
  currentUrl.searchParams.get('data') === 'test';

const restoreUiEnabled =
  currentUrl.searchParams.get('restore') === '1';

function dataPath(pathname) {
  return `./data/${testDataMode ? 'test/' : ''}${pathname}`;
}

function showRestoreMessage(message, isError = false) {
  els.restoreMessage.textContent = message;
  els.restoreMessage.classList.remove('hidden');
  els.restoreMessage.classList.toggle('error', isError);
}

async function copyRestoreData(doc, button) {
  button.disabled = true;

  try {
    const latestUrl = new URL(
      dataPath(
        `documents/guide/${doc.postNo}/latest.json`
      ),
      window.location.href
    );

    // latest.json은 같은 URL에서 내용이 변경되므로
    // 브라우저/CDN의 이전 응답 사용을 방지한다.
    latestUrl.searchParams.set(
      '_restore',
      Date.now().toString()
    );

    const response = await fetch(
      latestUrl,
      {
        cache: 'no-store'
      }
    );

    if (!response.ok) {
      throw new Error(
        `latest.json 요청 실패 (HTTP ${response.status})`
      );
    }

    const documentData =
      await response.json();

    console.log(
      '[GuideSearch] restore source:',
      {
        postNo:
          documentData.postNo,

        contentHash:
          documentData.contentHash,

        bodyImages:
          (
            documentData.bodyHtml
              .match(/<img\b/gi) ||
            []
          ).length,

        assets:
          documentData.assets?.length ??
          0,

        backupAt:
          documentData.backupAt
      }
    );

    const payload =
      buildRestorePayload(
        documentData,
        latestUrl
      );

    console.log(
      '[GuideSearch] restore payload:',
      {
        assets:
          Object.keys(
            payload.assets
          ).length,

        occurrences:
          payload.imageOccurrences
            .length,

        payload
      }
    );

    await navigator.clipboard.writeText(
      serializeRestorePayload(
        payload
      )
    );

    showRestoreMessage(
      `복원 데이터가 클립보드에 복사되었습니다. ` +
      `이미지 ${Object.keys(payload.assets).length}개 / ` +
      `이미지 위치 ${payload.imageOccurrences.length}개`
    );
  } catch (error) {
    console.error(
      '[GuideSearch] restore copy failed:',
      error
    );

    showRestoreMessage(
      `복원 데이터 복사 실패: ${error.message}`,
      true
    );
  } finally {
    button.disabled = false;
  }
}

function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const safe = escapeHtml(text);
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'ig');
  return safe.replace(regex, '<mark>$1</mark>');
}

function makeSnippet(body, query) {
  const text = (body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!query) return text.slice(0, 180);

  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const index = lower.indexOf(q);
  if (index === -1) return text.slice(0, 180);

  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + q.length + 100);
  return text.slice(start, end);
}

function getFullBody(doc) {
  return (doc.searchBody || doc.body || '').toString();
}

function searchDocuments(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return indexData.documents.filter((doc) => {
    const title = (doc.title || '').toLowerCase();
    const body = getFullBody(doc).toLowerCase();
    return title.includes(q) || body.includes(q);
  });
}


function renderResults(query) {
  const docs = searchDocuments(query);
  els.results.innerHTML = '';
  els.resultMeta.textContent = `${docs.length} result(s)`;
  els.empty.classList.toggle('hidden', docs.length !== 0);

  for (const doc of docs) {
    const node = els.resultTemplate.content.cloneNode(true);
    const badge = node.querySelector('.badge');
    badge.textContent = doc.docType;
    badge.classList.add(doc.docType);

    const title = node.querySelector('.title');
    title.href = doc.url;
    title.innerHTML = highlight(doc.title, query);

    const meta = node.querySelector('.meta');
    meta.textContent = `#${doc.postNo} · backup ${doc.backupDate}`;

    const snippet = node.querySelector('.snippet');
    snippet.innerHTML = highlight(makeSnippet(getFullBody(doc), query), query);

    const restoreButton = node.querySelector('.copy-restore');
    if (doc.docType === 'guide') restoreButton.addEventListener('click', () => copyRestoreData(doc, restoreButton));
    else restoreButton.remove();

    els.results.append(node);
  }
}

function renderStatus() {
  const showOk = els.toggleOk.checked;
  const HIDDEN_SOURCE_POST_NO = '3538743';

  const problematic = statusData.items.filter((item) => {
    const isHiddenBySource = String(item.sourcePostNo ?? '') === HIDDEN_SOURCE_POST_NO;
    const isHiddenSourceItself =
      item.docType === 'source' && String(item.postNo ?? '') === HIDDEN_SOURCE_POST_NO;
  
    if (isHiddenBySource || isHiddenSourceItself) {
      return false;
    }
  
    return showOk || item.status !== 'ok';
  });

  els.statusList.innerHTML = '';
  if (problematic.length === 0) {
    const li = document.createElement('li');
    li.className = 'card muted';
    li.textContent = 'No problematic backup entries.';
    els.statusList.append(li);
    return;
  }

  for (const item of problematic) {
    const li = document.createElement('li');
    li.className = 'card';
    const statusClass = item.status === 'ok' ? '' : 'problem';
    li.innerHTML = `
      <div class="row">
        <span class="badge ${statusClass}">${item.status}</span>
        <a class="title" href="${item.url}" target="_blank" rel="noopener noreferrer">
          ${item.docType} #${item.postNo ?? '-'}
        </a>
      </div>
      <p class="meta">
        HTTP: ${item.httpStatus ?? '-'} · Last attempt: ${item.lastAttemptAt ?? '-'}
      </p>
      <p class="muted">${item.error ?? 'No error message'}</p>
      <p class="muted">URL: ${item.url ?? '-'}</p>
      <p class="muted">Origin: ${item.originLabel ?? '-'}</p>
      <p class="muted">Source post: ${item.sourcePostNo ?? '-'}</p>
      <p class="muted">Context: ${item.contextText ?? '-'}</p>
    `;
        els.statusList.append(li);
  }
}

function syncQueryToUrl(query) {
  const url = new URL(window.location.href);
  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }
  history.replaceState({}, '', url);
}

async function fetchJsonWithFallback(primaryPath, fallbackPath) {
  const primary = await fetch(primaryPath);
  if (primary.ok) return primary.json();

  const fallback = await fetch(fallbackPath);
  if (!fallback.ok) {
    throw new Error(`Failed to load ${primaryPath} and ${fallbackPath}`);
  }

  return fallback.json();
}

async function init() {
  const [index, status] = await Promise.all([
    fetchJsonWithFallback(dataPath('search-index.json'), `../data/${testDataMode ? 'test/' : ''}search-index.json`),
    fetchJsonWithFallback(dataPath('crawl-status.json'), `../data/${testDataMode ? 'test/' : ''}crawl-status.json`),
  ]);

  indexData = index;
  statusData = status;

  const initialQuery = new URL(window.location.href).searchParams.get('q') || '';
  els.query.value = initialQuery;
  renderResults(initialQuery);
  renderStatus();
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const q = els.query.value.trim();
  syncQueryToUrl(q);
  renderResults(q);
});

els.toggleOk.addEventListener('change', renderStatus);

init().catch((error) => {
  console.error(error);
  els.resultMeta.textContent = 'Failed to load index/status files.';
});
