// ==UserScript==
// @name         GuideSearch DCInside Backup Restore
// @namespace    https://qwcol032.github.io/GuideSearch/
// @version      1.0.0
// @description  Restore a GuideSearch backup into the existing DCInside editor for manual review and submission.
// @match        https://gall.dcinside.com/mgallery/board/write*
// @match        https://gall.dcinside.com/board/write*
// @match        https://gall.dcinside.com/mini/board/write*
// @grant        GM_xmlhttpRequest
// @connect      qwcol032.github.io
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const PREFIX = 'GUIDESEARCH_RESTORE_V1:';
  const ASSET_HOST = 'qwcol032.github.io';
  const UPLOAD_TIMEOUT_MS = 45000;

  function createPanel() {
    const panel = document.createElement('section');
    panel.id = 'guidesearch-restore-panel';
    panel.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #3b82f6;background:#f8fafc;color:#111;font:13px/1.5 sans-serif;';
    panel.innerHTML = `
      <strong>GuideSearch 백업 복원</strong>
      <p style="margin:6px 0">복원 결과를 확인한 뒤 등록은 직접 진행하세요.</p>
      <button type="button" data-action="clipboard">클립보드에서 불러오기</button>
      <button type="button" data-action="paste">복원 데이터 직접 붙여넣기</button>
      <div data-role="paste-box" hidden style="margin-top:8px">
        <textarea rows="6" style="box-sizing:border-box;width:100%" placeholder="GUIDESEARCH_RESTORE_V1:..."></textarea>
        <button type="button" data-action="restore">붙여넣은 데이터 복원</button>
      </div>
      <pre data-role="status" style="margin:8px 0 0;white-space:pre-wrap"></pre>`;
    const anchor = document.querySelector('form') || document.body.firstElementChild;
    (anchor?.parentNode || document.body).insertBefore(panel, anchor || null);
    return panel;
  }

  function setStatus(panel, message, error = false) {
    const status = panel.querySelector('[data-role="status"]');
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '#1d4ed8';
  }

  function parsePayload(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith(PREFIX)) throw new Error('GuideSearch restore prefix가 없습니다.');
    let payload;
    try { payload = JSON.parse(trimmed.slice(PREFIX.length).trim()); }
    catch { throw new Error('restore JSON을 해석할 수 없습니다.'); }
    if (payload?.type !== 'GuideSearchRestore' || payload.version !== 1) throw new Error('지원하지 않는 restore payload입니다.');
    if (typeof payload.bodyTemplateHtml !== 'string') throw new Error('bodyTemplateHtml이 없습니다.');
    if (!Array.isArray(payload.imageOccurrences)) throw new Error('imageOccurrences가 배열이 아닙니다.');
    if (!payload.assets || typeof payload.assets !== 'object' || Array.isArray(payload.assets)) throw new Error('assets가 없습니다.');

    const ids = new Set();
    for (const occurrence of payload.imageOccurrences) {
      if (!occurrence?.id || ids.has(occurrence.id)) throw new Error('이미지 occurrence ID가 없거나 중복됩니다.');
      ids.add(occurrence.id);
      const asset = payload.assets[occurrence.assetHash];
      if (!asset || asset.hash !== occurrence.assetHash || !asset.fileName || !asset.contentType || !asset.url) {
        throw new Error(`${occurrence.id}의 asset 정보가 올바르지 않습니다.`);
      }
      if (!/^image\/(?:jpeg|png|gif|webp)$/.test(asset.contentType)) throw new Error(`지원하지 않는 이미지 형식입니다: ${asset.contentType}`);
      const url = new URL(asset.url);
      if (url.protocol !== 'https:' || url.hostname !== ASSET_HOST || !url.pathname.includes('/GuideSearch/data/')) {
        throw new Error(`허용되지 않은 asset URL입니다: ${asset.url}`);
      }
    }

    const template = document.createElement('template');
    template.innerHTML = payload.bodyTemplateHtml;
    if (template.content.querySelector('script,style,iframe,object,embed,form,input,button,img')) {
      throw new Error('bodyTemplateHtml에 허용되지 않은 요소가 있습니다.');
    }
    for (const element of template.content.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        if (/^on/i.test(attribute) || ['style', 'srcdoc'].includes(attribute.toLowerCase())) {
          throw new Error(`bodyTemplateHtml에 허용되지 않은 속성이 있습니다: ${attribute}`);
        }
      }
      const href = element.getAttribute('href');
      if (href && /^\s*(?:javascript|data|vbscript):/i.test(href)) throw new Error('안전하지 않은 링크가 있습니다.');
    }
    const placeholderIds = [...template.content.querySelectorAll('[data-guidesearch-image]')]
      .map((node) => node.getAttribute('data-guidesearch-image'));
    if (placeholderIds.length !== ids.size || placeholderIds.some((id) => !ids.has(id)) || new Set(placeholderIds).size !== placeholderIds.length) {
      throw new Error('이미지 placeholder와 occurrence가 일치하지 않습니다.');
    }
    return payload;
  }

  function findEditor() {
    const iframe = [...document.querySelectorAll('iframe')].find((item) => {
      try { return item.contentDocument?.body?.isContentEditable; } catch { return false; }
    });
    if (iframe) return { root: iframe.contentDocument.body, document: iframe.contentDocument, kind: 'html' };
    const editable = document.querySelector('[contenteditable="true"], .note-editable, .fr-element, .cke_editable');
    if (editable) return { root: editable, document: editable.ownerDocument, kind: 'html' };
    throw new Error('DCInside 본문 에디터를 찾을 수 없습니다. 페이지 로드 후 다시 시도하세요.');
  }

  function findUploadInput() {
    const candidates = [...document.querySelectorAll('input[type="file"]')];
    return candidates.find((input) => /image/i.test(input.accept || '')) || candidates[0] || null;
  }

  function hasEditorContent(root) {
    const copy = root.cloneNode(true);
    copy.querySelectorAll?.('[data-guidesearch-image]').forEach((node) => node.remove());
    return Boolean((copy.textContent || '').trim() || copy.querySelector?.('img,video,iframe'));
  }

  function fillTitle(title) {
    if (!title) return;
    const input = document.querySelector('input[name="subject"], input[name="title"], input#subject, input[placeholder*="제목"]');
    if (input && !input.value.trim()) {
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setCaretAtPlaceholder(editor, placeholder) {
    const selection = editor.document.getSelection();
    const range = editor.document.createRange();
    range.selectNode(placeholder);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.root.focus();
  }

  function downloadAsset(asset) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: asset.url, responseType: 'arraybuffer', timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) return reject(new Error(`asset HTTP ${response.status}`));
          const blob = new Blob([response.response], { type: asset.contentType });
          resolve(new File([blob], asset.fileName, { type: asset.contentType }));
        },
        onerror: () => reject(new Error('asset 다운로드 네트워크 오류')),
        ontimeout: () => reject(new Error('asset 다운로드 시간 초과')),
      });
    });
  }

  function waitForUploadedImage(root, knownImages) {
    return new Promise((resolve, reject) => {
      const findNewImage = () => [...root.querySelectorAll('img')].find((image) => !knownImages.has(image));
      const existing = findNewImage();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const image = findNewImage();
        if (image) { observer.disconnect(); clearTimeout(timer); resolve(image); }
      });
      observer.observe(root, { childList: true, subtree: true });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DCInside 업로드 완료를 확인하지 못했습니다.')); }, UPLOAD_TIMEOUT_MS);
    });
  }

  async function uploadWithExistingInput(editor, input, file, placeholder) {
    const knownImages = new Set(editor.root.querySelectorAll('img'));
    setCaretAtPlaceholder(editor, placeholder);
    const uploaded = waitForUploadedImage(editor.root, knownImages);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const uploadedImage = await uploaded;
    const restoredImage = uploadedImage.cloneNode(true);
    uploadedImage.remove();
    placeholder.replaceWith(restoredImage);
    return restoredImage.outerHTML;
  }

  function replaceFailure(editor, id, message) {
    const placeholder = editor.root.querySelector(`[data-guidesearch-image="${CSS.escape(id)}"]`);
    if (!placeholder) return;
    const failure = editor.document.createElement('strong');
    failure.style.color = '#c00';
    failure.textContent = `[GuideSearch 이미지 복원 실패: ${id} - ${message}]`;
    placeholder.replaceWith(failure);
  }

  async function restore(payload, panel) {
    const editor = findEditor();
    if (hasEditorContent(editor.root) && !window.confirm('현재 작성 중인 내용이 있습니다. GuideSearch 백업으로 교체하시겠습니까?')) return;
    const uploadInput = findUploadInput();
    if (payload.imageOccurrences.length && !uploadInput) throw new Error('DCInside 기존 이미지 file input을 찾을 수 없습니다.');

    editor.root.innerHTML = payload.bodyTemplateHtml;
    editor.root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    fillTitle(payload.title);
    setStatus(panel, `본문 로드 완료\n이미지 0 / ${payload.imageOccurrences.length}`);

    const uploadedHtmlByHash = new Map();
    let succeeded = 0;
    const failures = [];
    for (const [index, occurrence] of payload.imageOccurrences.entries()) {
      setStatus(panel, `본문 로드 완료\n이미지 ${index + 1} / ${payload.imageOccurrences.length} 복원 중...`);
      const placeholder = editor.root.querySelector(`[data-guidesearch-image="${CSS.escape(occurrence.id)}"]`);
      if (!placeholder) { failures.push(`${occurrence.id}: placeholder 없음`); continue; }
      try {
        const cachedHtml = uploadedHtmlByHash.get(occurrence.assetHash);
        if (cachedHtml) {
          const holder = editor.document.createElement('template');
          holder.innerHTML = cachedHtml;
          placeholder.replaceWith(holder.content.cloneNode(true));
        } else {
          const asset = payload.assets[occurrence.assetHash];
          const file = await downloadAsset(asset);
          const uploadedHtml = await uploadWithExistingInput(editor, uploadInput, file, placeholder);
          uploadedHtmlByHash.set(occurrence.assetHash, uploadedHtml);
        }
        succeeded += 1;
      } catch (error) {
        failures.push(`${occurrence.id}: ${error.message}`);
        replaceFailure(editor, occurrence.id, error.message);
      }
    }
    editor.root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    setStatus(panel, `복원 완료: ${succeeded} / ${payload.imageOccurrences.length}\n실패: ${failures.length}${failures.length ? `\n${failures.join('\n')}` : ''}\n내용을 확인한 뒤 등록 버튼은 직접 누르세요.`, failures.length > 0);
  }

  async function start(text, panel) {
    try { await restore(parsePayload(text), panel); }
    catch (error) { setStatus(panel, `복원 실패: ${error.message}`, true); }
  }

  const panel = createPanel();
  panel.querySelector('[data-action="paste"]').addEventListener('click', () => {
    panel.querySelector('[data-role="paste-box"]').hidden = false;
    panel.querySelector('textarea').focus();
  });
  panel.querySelector('[data-action="restore"]').addEventListener('click', () => start(panel.querySelector('textarea').value, panel));
  panel.querySelector('[data-action="clipboard"]').addEventListener('click', async () => {
    try { await start(await navigator.clipboard.readText(), panel); }
    catch {
      panel.querySelector('[data-role="paste-box"]').hidden = false;
      setStatus(panel, '클립보드 권한을 사용할 수 없습니다. 아래 칸에 복원 데이터를 직접 붙여넣으세요.', true);
    }
  });
})();
