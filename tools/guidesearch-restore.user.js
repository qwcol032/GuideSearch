// ==UserScript==
// @name         GuideSearch DCInside Backup Restore
// @namespace    https://qwcol032.github.io/GuideSearch/
// @version      1.0.2
// @description  Restore a GuideSearch backup into the existing DCInside editor for manual review and submission.
// @match        https://gall.dcinside.com/mgallery/board/write*
// @match        https://gall.dcinside.com/board/write*
// @match        https://gall.dcinside.com/mini/board/write*
// @match        https://gall.dcinside.com/upload/image*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      qwcol032.github.io
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const PREFIX = 'GUIDESEARCH_RESTORE_V1:';
    const ASSET_HOST = 'qwcol032.github.io';
    const UPLOAD_TIMEOUT_MS = 60000;
    const ORIGIN = location.origin;

    const MESSAGE = {
        POPUP_READY: 'GUIDESEARCH_UPLOAD_POPUP_READY',
        UPLOAD_REQUEST: 'GUIDESEARCH_UPLOAD_REQUEST',
        UPLOAD_PROGRESS: 'GUIDESEARCH_UPLOAD_PROGRESS',
        UPLOAD_READY_TO_APPLY: 'GUIDESEARCH_UPLOAD_READY_TO_APPLY',
        UPLOAD_ERROR: 'GUIDESEARCH_UPLOAD_ERROR',
    };


    const MAX_TRANSIENT_UPLOAD_RETRIES = 1;

    function isTransientUploadAlert(message) {
        const text =
              String(message || '');

        return (
            text.includes(
                '일시적으로 이미지 업로드'
            ) &&
            text.includes(
                '잠시 후 시도'
            )
        );
    }

    let reservedUploadPopup = null;

    function reserveUploadPopup() {
        try {
            if (
                reservedUploadPopup &&
                !reservedUploadPopup.closed
            ) {
                try {
                    reservedUploadPopup.close();
                } catch {}
            }

            // 반드시 실제 사용자 클릭 이벤트 안에서 실행되어야
            // 브라우저 popup blocker를 통과할 수 있다.
            reservedUploadPopup = window.open(
                'about:blank',
                'image',
                [
                    'width=550',
                    'height=650',
                    'scrollbars=yes',
                    'resizable=yes'
                ].join(',')
            );

            if (!reservedUploadPopup) {
                throw new Error(
                    '브라우저가 이미지 업로드 팝업을 차단했습니다. 이 사이트의 팝업을 허용해 주세요.'
                );
            }

            console.log(
                '[GuideSearch] Upload popup reserved:',
                reservedUploadPopup
            );

            return reservedUploadPopup;
        } catch (error) {
            reservedUploadPopup = null;
            throw error;
        }
    }

    function closeReservedUploadPopup() {
        try {
            if (
                reservedUploadPopup &&
                !reservedUploadPopup.closed
            ) {
                reservedUploadPopup.close();
            }
        } catch {}

        reservedUploadPopup = null;
    }


    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function createPanel() {
        const launcher = document.createElement('button');
        launcher.id = 'guidesearch-restore-launcher';
        launcher.type = 'button';
        launcher.textContent = 'GuideSearch 복원';
        launcher.setAttribute(
            'aria-controls',
            'guidesearch-restore-panel'
        );
        launcher.setAttribute(
            'aria-expanded',
            'false'
        );

        launcher.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:18px',
            'z-index:2147483647',
            'box-sizing:border-box',
            'padding:9px 13px',
            'border:1px solid #1d4ed8',
            'border-radius:7px',
            'background:#2563eb',
            'color:#fff',
            'font:600 13px/1.2 sans-serif',
            'cursor:pointer',
            'box-shadow:0 4px 14px rgba(0,0,0,.28)',
            'pointer-events:auto'
        ].join(';');

        const panel = document.createElement('section');

        panel.id = 'guidesearch-restore-panel';
        panel.hidden = true;

        panel.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:64px',
            'z-index:2147483647',
            'box-sizing:border-box',
            'width:min(430px,calc(100vw - 24px))',
            'max-height:min(70vh,640px)',
            'overflow:auto',
            'padding:12px',
            'border:1px solid #3b82f6',
            'border-radius:8px',
            'background:#f8fafc',
            'color:#111',
            'font:13px/1.5 sans-serif',
            'box-shadow:0 10px 32px rgba(0,0,0,.35)',
            'pointer-events:auto'
        ].join(';');

        panel.innerHTML = `
      <div
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px
        "
      >
        <strong style="font-size:14px">
          GuideSearch 백업 복원
        </strong>

        <button
          type="button"
          data-action="close"
          aria-label="GuideSearch 복원 패널 닫기"
          style="
            border:0;
            background:transparent;
            color:#444;
            font-size:20px;
            line-height:1;
            cursor:pointer;
            padding:0 2px
          "
        >
          ×
        </button>
      </div>

      <p style="margin:6px 0 10px">
        복원 결과를 확인한 뒤 등록은 직접 진행하세요.
      </p>

      <div
        style="
          display:flex;
          flex-wrap:wrap;
          gap:6px
        "
      >
        <button
          type="button"
          data-action="clipboard"
          style="padding:6px 9px;cursor:pointer"
        >
          클립보드에서 불러오기
        </button>

        <button
          type="button"
          data-action="paste"
          style="padding:6px 9px;cursor:pointer"
        >
          복원 데이터 직접 붙여넣기
        </button>
      </div>

      <div
        data-role="paste-box"
        hidden
        style="margin-top:8px"
      >
        <textarea
          rows="6"
          style="
            box-sizing:border-box;
            width:100%;
            resize:vertical;
            padding:7px;
            font:12px/1.4 monospace
          "
          placeholder="GUIDESEARCH_RESTORE_V1:..."
        ></textarea>

        <button
          type="button"
          data-action="restore"
          style="
            margin-top:6px;
            padding:6px 9px;
            cursor:pointer
          "
        >
          붙여넣은 데이터 복원
        </button>
      </div>

      <pre
        data-role="status"
        style="
          margin:8px 0 0;
          white-space:pre-wrap;
          overflow-wrap:anywhere
        "
      ></pre>
    `;

        const setOpen = (open) => {
            panel.hidden = !open;

            launcher.setAttribute(
                'aria-expanded',
                open ? 'true' : 'false'
            );

            launcher.textContent =
                open
                ? 'GuideSearch 닫기'
            : 'GuideSearch 복원';
        };

        launcher.addEventListener(
            'click',
            () => {
                setOpen(panel.hidden);
            }
        );

        panel
            .querySelector('[data-action="close"]')
            .addEventListener(
            'click',
            () => {
                setOpen(false);
            }
        );

        document.addEventListener(
            'keydown',
            (event) => {
                if (
                    event.key === 'Escape' &&
                    !panel.hidden
                ) {
                    setOpen(false);
                }
            }
        );

        document.body.append(
            launcher,
            panel
        );

        return panel;
    }

    function setStatus(
    panel,
     message,
     error = false
    ) {
        const status =
              panel.querySelector(
                  '[data-role="status"]'
              );

        status.textContent =
            message;

        status.style.color =
            error
            ? '#b91c1c'
        : '#1d4ed8';
    }

    function parsePayload(text) {
        const trimmed =
              String(text || '')
        .trim();

        if (
            !trimmed.startsWith(
                PREFIX
            )
        ) {
            throw new Error(
                'GuideSearch restore prefix가 없습니다.'
            );
        }

        let payload;

        try {
            payload =
                JSON.parse(
                trimmed
                .slice(
                    PREFIX.length
                )
                .trim()
            );
        } catch {
            throw new Error(
                'restore JSON을 해석할 수 없습니다.'
            );
        }

        if (
            payload?.type !==
            'GuideSearchRestore' ||
            payload.version !== 1
        ) {
            throw new Error(
                '지원하지 않는 restore payload입니다.'
            );
        }

        if (
            typeof payload.bodyTemplateHtml !==
            'string'
        ) {
            throw new Error(
                'bodyTemplateHtml이 없습니다.'
            );
        }

        if (
            !Array.isArray(
                payload.imageOccurrences
            )
        ) {
            throw new Error(
                'imageOccurrences가 배열이 아닙니다.'
            );
        }

        if (
            !payload.assets ||
            typeof payload.assets !==
            'object' ||
            Array.isArray(
                payload.assets
            )
        ) {
            throw new Error(
                'assets가 없습니다.'
            );
        }

        const ids =
              new Set();

        for (
            const occurrence
            of payload.imageOccurrences
        ) {
            if (
                !occurrence?.id ||
                ids.has(
                    occurrence.id
                )
            ) {
                throw new Error(
                    '이미지 occurrence ID가 없거나 중복됩니다.'
                );
            }

            ids.add(
                occurrence.id
            );

            const asset =
                  payload.assets[
                      occurrence.assetHash
                  ];

            if (
                !asset ||
                asset.hash !==
                occurrence.assetHash ||
                !asset.fileName ||
                !asset.contentType ||
                !asset.url
            ) {
                throw new Error(
                    `${occurrence.id}의 asset 정보가 올바르지 않습니다.`
                );
            }

            if (
                !/^image\/(?:jpeg|png|gif|webp)$/.test(
                    asset.contentType
                )
            ) {
                throw new Error(
                    `지원하지 않는 이미지 형식입니다: ${asset.contentType}`
                );
            }

            const url =
                  new URL(
                      asset.url
                  );

            if (
                url.protocol !==
                'https:' ||
                url.hostname !==
                ASSET_HOST ||
                !url.pathname.includes(
                    '/GuideSearch/data/'
                )
            ) {
                throw new Error(
                    `허용되지 않은 asset URL입니다: ${asset.url}`
                );
            }
        }

        const template =
              document.createElement(
                  'template'
              );

        template.innerHTML =
            payload.bodyTemplateHtml;

        if (
            template.content.querySelector(
                'script,style,iframe,object,embed,form,input,button,img'
            )
        ) {
            throw new Error(
                'bodyTemplateHtml에 허용되지 않은 요소가 있습니다.'
            );
        }

        for (
            const element
            of template.content.querySelectorAll(
                '*'
            )
        ) {
            for (
                const attribute
                of element.getAttributeNames()
            ) {
                if (
                    /^on/i.test(
                        attribute
                    ) ||
                    [
                        'style',
                        'srcdoc'
                    ].includes(
                        attribute.toLowerCase()
                    )
                ) {
                    throw new Error(
                        `bodyTemplateHtml에 허용되지 않은 속성이 있습니다: ${attribute}`
                    );
                }
            }

            const href =
                  element.getAttribute(
                      'href'
                  );

            if (
                href &&
                /^\s*(?:javascript|data|vbscript):/i.test(
                    href
                )
            ) {
                throw new Error(
                    '안전하지 않은 링크가 있습니다.'
                );
            }
        }

        const placeholderIds =
              [
                  ...template.content.querySelectorAll(
                      '[data-guidesearch-image]'
                  )
              ].map(
                  (node) =>
                  node.getAttribute(
                      'data-guidesearch-image'
                  )
              );

        if (
            placeholderIds.length !==
            ids.size ||
            placeholderIds.some(
                (id) =>
                !ids.has(id)
            ) ||
            new Set(
                placeholderIds
            ).size !==
            placeholderIds.length
        ) {
            throw new Error(
                '이미지 placeholder와 occurrence가 일치하지 않습니다.'
            );
        }

        return payload;
    }

    function findEditor() {
        const iframe =
              [
                  ...document.querySelectorAll(
                      'iframe'
                  )
              ].find(
                  (item) => {
                      try {
                          return (
                              item.contentDocument
                              ?.body
                              ?.isContentEditable
                          );
                      } catch {
                          return false;
                      }
                  }
              );

        if (iframe) {
            return {
                root:
                iframe.contentDocument.body,

                document:
                iframe.contentDocument,

                kind: 'html'
            };
        }

        const editable =
              document.querySelector(
                  [
                      '[contenteditable="true"]',
                      '.note-editable',
                      '.fr-element',
                      '.cke_editable'
                  ].join(',')
              );

        if (editable) {
            return {
                root:
                editable,

                document:
                editable.ownerDocument,

                kind:
                'html'
            };
        }

        throw new Error(
            'DCInside 본문 에디터를 찾을 수 없습니다. 페이지 로드 후 다시 시도하세요.'
        );
    }

    function findDcImageUploadButton() {
        const candidates =
              [
                  ...document.querySelectorAll(
                      'button,a,input[type="button"]'
                  )
              ];

        return (
            candidates.find(
                (el) =>
                el.classList?.contains(
                    'btn_add'
                ) &&
                (
                    el.textContent ||
                    el.value ||
                    ''
                ).trim() ===
                '이미지 올리기'
            ) ||

            candidates.find(
                (el) =>
                (
                    el.textContent ||
                    el.value ||
                    ''
                ).trim() ===
                '이미지 올리기'
            ) ||

            null
        );
    }

    function hasEditorContent(
    root
    ) {
        const copy =
              root.cloneNode(true);

        copy
            .querySelectorAll?.(
            '[data-guidesearch-image]'
        )
            .forEach(
            (node) =>
            node.remove()
        );

        return Boolean(
            (
                copy.textContent ||
                ''
            ).trim() ||
            copy.querySelector?.(
                'img,video,iframe'
            )
        );
    }

    function fillTitle(
    title
    ) {
        if (!title) {
            return;
        }

        const input =
              document.querySelector(
                  [
                      'input[name="subject"]',
                      'input[name="title"]',
                      'input#subject',
                      'input[placeholder*="제목"]'
                  ].join(',')
              );

        if (
            input &&
            !input.value.trim()
        ) {
            input.value =
                title;

            input.dispatchEvent(
                new Event(
                    'input',
                    {
                        bubbles: true
                    }
                )
            );

            input.dispatchEvent(
                new Event(
                    'change',
                    {
                        bubbles: true
                    }
                )
            );
        }
    }

    function setCaretAtPlaceholder(
    editor,
     placeholder
    ) {
        const selection =
              editor.document
        .getSelection();

        const range =
              editor.document
        .createRange();

        range.selectNode(
            placeholder
        );

        range.collapse(
            true
        );

        selection.removeAllRanges();

        selection.addRange(
            range
        );

        editor.root.focus();
    }

    function downloadAsset(
    asset
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                GM_xmlhttpRequest({
                    method:
                    'GET',

                    url:
                    asset.url,

                    responseType:
                    'arraybuffer',

                    timeout:
                    30000,

                    onload(response) {
                        if (
                            response.status <
                            200 ||
                            response.status >=
                            300
                        ) {
                            reject(
                                new Error(
                                    `asset HTTP ${response.status}`
                                )
                            );

                            return;
                        }

                        const blob =
                              new Blob(
                                  [
                                      response.response
                                  ],
                                  {
                                      type:
                                      asset.contentType
                                  }
                              );

                        resolve(
                            new File(
                                [blob],
                                asset.fileName,
                                {
                                    type:
                                    asset.contentType
                                }
                            )
                        );
                    },

                    onerror: () =>
                    reject(
                        new Error(
                            'asset 다운로드 네트워크 오류'
                        )
                    ),

                    ontimeout: () =>
                    reject(
                        new Error(
                            'asset 다운로드 시간 초과'
                        )
                    )
                });
            }
        );
    }

    function waitForNewEditorImages(
    root,
     knownImages,
     expectedCount
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                const getNewImages =
                      () =>
                [
                    ...root.querySelectorAll(
                        'img'
                    )
                ].filter(
                    (image) =>
                    !knownImages.has(
                        image
                    )
                );

                let observer;
                let timer;

                const check =
                      () => {
                          const images =
                                getNewImages();

                          if (
                              images.length >=
                              expectedCount
                          ) {
                              observer.disconnect();

                              clearTimeout(
                                  timer
                              );

                              resolve(
                                  images.slice(
                                      0,
                                      expectedCount
                                  )
                              );

                              return true;
                          }

                          return false;
                      };

                observer =
                    new MutationObserver(
                    check
                );

                observer.observe(
                    root,
                    {
                        childList: true,
                        subtree: true
                    }
                );

                timer =
                    setTimeout(
                    () => {
                        observer.disconnect();

                        reject(
                            new Error(
                                `DCInside 적용 후 본문 이미지 ${expectedCount}개를 확인하지 못했습니다.`
                            )
                        );
                    },
                    UPLOAD_TIMEOUT_MS
                );

                check();
            }
        );
    }

    function uniqueAssetsInOccurrenceOrder(
    payload
    ) {
        const hashes = [];
        const seen =
              new Set();

        for (
            const occurrence
            of payload.imageOccurrences
        ) {
            if (
                seen.has(
                    occurrence.assetHash
                )
            ) {
                continue;
            }

            seen.add(
                occurrence.assetHash
            );

            hashes.push(
                occurrence.assetHash
            );
        }

        return hashes.map(
            (hash) =>
            payload.assets[hash]
        );
    }

    function waitForUploadPopup(panel) {
        return new Promise((resolve, reject) => {
            const popupWindow =
                  reservedUploadPopup;

            if (
                !popupWindow ||
                popupWindow.closed
            ) {
                reject(
                    new Error(
                        '이미지 업로드 팝업이 준비되지 않았습니다.'
                    )
                );
                return;
            }

            let timer;

            const cleanup = () => {
                window.removeEventListener(
                    'message',
                    onMessage
                );

                clearTimeout(timer);
            };

            const onMessage = (event) => {
                if (
                    event.origin !== ORIGIN
                ) {
                    return;
                }

                if (
                    event.source !== popupWindow
                ) {
                    return;
                }

                if (
                    event.data?.type !==
                    MESSAGE.POPUP_READY
                ) {
                    return;
                }

                cleanup();

                console.log(
                    '[GuideSearch] Upload popup ready:',
                    popupWindow
                );

                resolve(
                    popupWindow
                );
            };

            window.addEventListener(
                'message',
                onMessage
            );

            timer = setTimeout(
                () => {
                    cleanup();

                    reject(
                        new Error(
                            'DCInside 이미지 업로드 팝업 초기화 시간이 초과되었습니다.'
                        )
                    );
                },
                10000
            );

            setStatus(
                panel,
                'DCInside 이미지 업로드 팝업을 여는 중...'
            );

            console.log(
                '[GuideSearch] Navigating reserved popup to /upload/image'
            );

            try {
                popupWindow.location.href =
                    `${ORIGIN}/upload/image`;
            } catch (error) {
                cleanup();

                reject(
                    new Error(
                        `이미지 업로드 팝업 이동 실패: ${error.message}`
                    )
                );
            }
        });
    }

    function waitForPopupUploadResult(
    popupWindow,
     requestId,
     panel
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                let timer;

                const onMessage =
                      (event) => {
                          if (
                              event.origin !==
                              ORIGIN ||
                              event.source !==
                              popupWindow
                          ) {
                              return;
                          }

                          const data =
                                event.data;

                          if (
                              !data ||
                              data.requestId !==
                              requestId
                          ) {
                              return;
                          }

                          if (
                              data.type ===
                              MESSAGE.UPLOAD_PROGRESS
                          ) {
                              setStatus(
                                  panel,
                                  `이미지 업로드 중...\n${data.completed} / ${data.total}`
                              );

                              return;
                          }

                          if (
                              data.type ===
                              MESSAGE.UPLOAD_READY_TO_APPLY
                          ) {
                              window.removeEventListener(
                                  'message',
                                  onMessage
                              );

                              clearTimeout(
                                  timer
                              );

                              resolve(
                                  data
                              );

                              return;
                          }

                          if (
                              data.type ===
                              MESSAGE.UPLOAD_ERROR
                          ) {
                              window.removeEventListener(
                                  'message',
                                  onMessage
                              );

                              clearTimeout(
                                  timer
                              );

                              reject(
                                  new Error(
                                      data.error ||
                                      'DCInside 이미지 업로드 팝업에서 오류가 발생했습니다.'
                                  )
                              );
                          }
                      };

                window.addEventListener(
                    'message',
                    onMessage
                );

                timer =
                    setTimeout(
                    () => {
                        window.removeEventListener(
                            'message',
                            onMessage
                        );

                        reject(
                            new Error(
                                'DCInside 이미지 업로드 팝업 응답 시간이 초과되었습니다.'
                            )
                        );
                    },
                    UPLOAD_TIMEOUT_MS
                );
            }
        );
    }

    function buildImageTemplateNode(
    editor,
     outerHtml
    ) {
        const template =
              editor.document.createElement(
                  'template'
              );

        template.innerHTML =
            outerHtml.trim();

        return (
            template.content
            .firstElementChild
        );
    }

    async function restoreImagesThroughPopup(
    payload,
     editor,
     panel
    ) {
        if (
            !payload.imageOccurrences
            .length
        ) {
            return {
                succeeded: 0,
                failures: []
            };
        }

        const uniqueAssets =
              uniqueAssetsInOccurrenceOrder(
                  payload
              );

        const firstOccurrence =
              payload.imageOccurrences[0];

        const firstPlaceholder =
              editor.root.querySelector(
                  `[data-guidesearch-image="${CSS.escape(
                      firstOccurrence.id
                  )}"]`
              );

        if (
            !firstPlaceholder
        ) {
            throw new Error(
                '첫 번째 이미지 placeholder를 찾을 수 없습니다.'
            );
        }

        // DCInside에서 적용한 이미지가
        // 삽입될 기준 위치를 설정한다.
        setCaretAtPlaceholder(
            editor,
            firstPlaceholder
        );

        const knownImages =
              new Set(
                  editor.root.querySelectorAll(
                      'img'
                  )
              );

        const popupWindow =
              await waitForUploadPopup(
                  panel
              );

        const requestId =
              `guidesearch-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

        const popupResult =
              waitForPopupUploadResult(
                  popupWindow,
                  requestId,
                  panel
              );

        const editorImagesResult =
              waitForNewEditorImages(
                  editor.root,
                  knownImages,
                  uniqueAssets.length
              );

        console.log(
            '[GuideSearch] Sending assets to upload popup:',
            uniqueAssets
        );

        popupWindow.postMessage(
            {
                type:
                MESSAGE.UPLOAD_REQUEST,

                requestId,

                assets:
                uniqueAssets
            },
            ORIGIN
        );

        // 팝업에서 모든 이미지 업로드가 끝나고
        // DCInside의 적용 직전 상태까지 대기한다.
        await popupResult;

        setStatus(
            panel,
            `DCInside 업로드 완료\n본문 적용 확인 중... (${uniqueAssets.length}개)`
        );

        const insertedImages =
              await editorImagesResult;

        console.log(
            '[GuideSearch] Inserted images detected:',
            insertedImages
        );

        const htmlByHash =
              new Map();

        for (
            let i = 0;
            i <
            uniqueAssets.length;
            i += 1
        ) {
            htmlByHash.set(
                uniqueAssets[i].hash,
                insertedImages[i]
                .outerHTML
            );
        }

        // DCInside가 caret 위치에 삽입한 이미지들은
        // 임시 결과로 보고 제거한 뒤,
        // GuideSearch placeholder 위치에 다시 배치한다.
        for (
            const image
            of insertedImages
        ) {
            image.remove();
        }

        let succeeded = 0;

        const failures =
              [];

        for (
            const occurrence
            of payload.imageOccurrences
        ) {
            const placeholder =
                  editor.root.querySelector(
                      `[data-guidesearch-image="${CSS.escape(
                          occurrence.id
                      )}"]`
                  );

            if (
                !placeholder
            ) {
                failures.push(
                    `${occurrence.id}: placeholder 없음`
                );

                continue;
            }

            const imageHtml =
                  htmlByHash.get(
                      occurrence.assetHash
                  );

            if (
                !imageHtml
            ) {
                failures.push(
                    `${occurrence.id}: 업로드 이미지 매핑 실패`
                );

                continue;
            }

            const imageNode =
                  buildImageTemplateNode(
                      editor,
                      imageHtml
                  );

            if (
                !imageNode
            ) {
                failures.push(
                    `${occurrence.id}: 업로드 이미지 HTML 생성 실패`
                );

                continue;
            }

            placeholder.replaceWith(
                imageNode.cloneNode(
                    true
                )
            );

            succeeded += 1;
        }

        return {
            succeeded,
            failures
        };
    }

    function replaceRemainingFailures(
    editor,
     failures
    ) {
        for (
            const failureText
            of failures
        ) {
            const match =
                  /^([^:]+):\s*(.*)$/.exec(
                      failureText
                  );

            if (
                !match
            ) {
                continue;
            }

            const id =
                  match[1];

            const message =
                  match[2];

            const placeholder =
                  editor.root.querySelector(
                      `[data-guidesearch-image="${CSS.escape(
                          id
                      )}"]`
                  );

            if (
                !placeholder
            ) {
                continue;
            }

            const failure =
                  editor.document.createElement(
                      'strong'
                  );

            failure.style.color =
                '#c00';

            failure.textContent =
                `[GuideSearch 이미지 복원 실패: ${id} - ${message}]`;

            placeholder.replaceWith(
                failure
            );
        }
    }

    async function restore(
    payload,
     panel
    ) {
        const editor =
              findEditor();

        if (
            hasEditorContent(
                editor.root
            ) &&
            !window.confirm(
                '현재 작성 중인 내용이 있습니다. GuideSearch 백업으로 교체하시겠습니까?'
            )
        ) {
            return;
        }

        editor.root.innerHTML =
            payload.bodyTemplateHtml;

        editor.root.dispatchEvent(
            new InputEvent(
                'input',
                {
                    bubbles: true,
                    inputType:
                    'insertText'
                }
            )
        );

        fillTitle(
            payload.title
        );

        setStatus(
            panel,
            `본문 로드 완료\n이미지 0 / ${payload.imageOccurrences.length}`
        );

        let succeeded = 0;

        let failures =
            [];

        if (
            payload.imageOccurrences
            .length
        ) {
            try {
                const result =
                      await restoreImagesThroughPopup(
                          payload,
                          editor,
                          panel
                      );

                succeeded =
                    result.succeeded;

                failures =
                    result.failures;
            } catch (error) {
                console.error(
                    '[GuideSearch] Popup restore failed:',
                    error
                );

                failures =
                    payload.imageOccurrences.map(
                    (occurrence) =>
                    `${occurrence.id}: ${error.message}`
                );
            }
        }

        replaceRemainingFailures(
            editor,
            failures
        );

        editor.root.dispatchEvent(
            new InputEvent(
                'input',
                {
                    bubbles: true,
                    inputType:
                    'insertText'
                }
            )
        );

        setStatus(
            panel,
            `복원 완료: ${succeeded} / ${payload.imageOccurrences.length}\n` +
            `실패: ${failures.length}` +
            `${failures.length
            ? `\n${failures.join('\n')}`
            : ''
            }\n` +
            '내용을 확인한 뒤 등록 버튼은 직접 누르세요.',
            failures.length > 0
        );
    }

    async function start(
    text,
     panel
    ) {
        try {
            await restore(
                parsePayload(
                    text
                ),
                panel
            );
        } catch (error) {
            console.error(
                '[GuideSearch] Restore failed:',
                error
            );

            setStatus(
                panel,
                `복원 실패: ${error.message}`,
                true
            );
        }
    }

    function initWritePage() {
        const panel =
              createPanel();

        panel
            .querySelector(
            '[data-action="paste"]'
        )
            .addEventListener(
            'click',
            () => {
                panel.querySelector(
                    '[data-role="paste-box"]'
                ).hidden = false;

                panel
                    .querySelector(
                    'textarea'
                )
                    .focus();
            }
        );

        panel
            .querySelector('[data-action="restore"]')
            .addEventListener(
            'click',
            () => {
                try {
                    reserveUploadPopup();

                    start(
                        panel.querySelector(
                            'textarea'
                        ).value,
                        panel
                    );
                } catch (error) {
                    setStatus(
                        panel,
                        `복원 시작 실패: ${error.message}`,
                        true
                    );
                }
            }
        );


        panel
            .querySelector(
            '[data-action="clipboard"]'
        )
            .addEventListener(
            'click',
            async () => {
                try {
                    // 반드시 await 전에 popup을 확보한다.
                    reserveUploadPopup();

                    const text =
                          await navigator.clipboard
                    .readText();

                    await start(
                        text,
                        panel
                    );
                } catch (error) {
                    closeReservedUploadPopup();

                    panel.querySelector(
                        '[data-role="paste-box"]'
                    ).hidden = false;

                    setStatus(
                        panel,
                        `클립보드 복원 실패: ${error.message}`,
                        true
                    );
                }
            }
        );

        console.log(
            '[GuideSearch] Write-page restore helper initialized.'
        );
    }

    function postToOpener(
    message
    ) {
        if (
            !window.opener ||
            window.opener.closed
        ) {
            return;
        }

        window.opener.postMessage(
            message,
            ORIGIN
        );
    }

    function waitForPopupPreviewCount(
    existingCount,
     expectedNewCount
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                const getUploadedImages =
                      () =>
                [
                    ...document.querySelectorAll(
                        'img.listDelip_img'
                    )
                ];

                const isUploadIdle =
                      () => {
                          const input =
                                document.querySelector(
                                    'input[name="upload_ing"]'
                                );

                          return (
                              !input ||
                              input.value ===
                              'N'
                          );
                      };

                const isRemoteDcImage =
                      (image) => {
                          try {
                              const url =
                                    new URL(
                                        image.src,
                                        location.href
                                    );

                              return (
                                  /(^|\.)dcinside\.co\.kr$/i.test(
                                      url.hostname
                                  ) ||
                                  /^dcimg\d*\./i.test(
                                      url.hostname
                                  )
                              );
                          } catch {
                              return false;
                          }
                      };

                let settled =
                    false;

                let observer;
                let interval;
                let timer;

                const cleanup =
                      () => {
                          observer?.disconnect();

                          clearInterval(
                              interval
                          );

                          clearTimeout(
                              timer
                          );
                      };

                const check =
                      () => {
                          if (
                              settled
                          ) {
                              return;
                          }

                          const images =
                                getUploadedImages();

                          const newImages =
                                images.slice(
                                    existingCount
                                );

                          const readyImages =
                                newImages.filter(
                                    isRemoteDcImage
                                );

                          if (
                              readyImages.length >=
                              expectedNewCount &&
                              isUploadIdle()
                          ) {
                              settled =
                                  true;

                              cleanup();

                              resolve(
                                  readyImages.slice(
                                      0,
                                      expectedNewCount
                                  )
                              );
                          }
                      };

                observer =
                    new MutationObserver(
                    check
                );

                observer.observe(
                    document.body,
                    {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: [
                            'src'
                        ]
                    }
                );

                // upload_ing은 DOM attribute가 아니라
                // JS property로 변경될 가능성이 있으므로
                // polling도 같이 사용한다.
                interval =
                    setInterval(
                    check,
                    100
                );

                timer =
                    setTimeout(
                    () => {
                        if (
                            settled
                        ) {
                            return;
                        }

                        settled =
                            true;

                        cleanup();

                        reject(
                            new Error(
                                `팝업에서 업로드된 이미지 ${expectedNewCount}개를 확인하지 못했습니다.`
                            )
                        );
                    },
                    UPLOAD_TIMEOUT_MS
                );

                check();
            }
        );
    }

    async function uploadAssetsInPopup(
    assets,
     requestId
    ) {
        const form =
              document.querySelector(
                  '#fileupload'
              );

        const input =
              form?.querySelector(
                  'input[type="file"][name="files[]"]'
              );

        if (
            !form ||
            !input
        ) {
            throw new Error(
                'DCInside 업로드 팝업의 files[] input을 찾을 수 없습니다.'
            );
        }

        if (
            !input.multiple &&
            assets.length > 1
        ) {
            throw new Error(
                'DCInside 업로드 input이 다중 파일을 지원하지 않습니다.'
            );
        }

        const files =
              [];

        for (
            let i = 0;
            i < assets.length;
            i += 1
        ) {
            postToOpener({
                type:
                MESSAGE.UPLOAD_PROGRESS,

                requestId,

                completed:
                i,

                total:
                assets.length
            });

            const file =
                  await downloadAsset(
                      assets[i]
                  );

            files.push(
                file
            );
        }


        const pageWindow =
              getPopupPageWindow();

        const $ =
              pageWindow.jQuery;

        if (
            !$ ||
            !$.fn ||
            typeof $.fn.fileupload !==
            'function'
        ) {
            throw new Error(
                'DCInside Blueimp fileupload plugin을 찾을 수 없습니다.'
            );
        }

        const $form =
              $('#fileupload');

        if (
            !$form.length
        ) {
            throw new Error(
                'DCInside #fileupload form을 찾을 수 없습니다.'
            );
        }

        let uploadedImages =
            null;

        let lastError =
            null;

        for (
            let attempt = 0;
            attempt <=
            MAX_TRANSIENT_UPLOAD_RETRIES;
            attempt += 1
        ) {
            const transientBefore =
                  getTransientUploadCount();

            const existingCount =
                  document.querySelectorAll(
                      'img.listDelip_img'
                  ).length;

            console.log(
                '[GuideSearch popup] Upload attempt:',
                attempt + 1,
                '/',
                MAX_TRANSIENT_UPLOAD_RETRIES + 1
            );

            const uploadedPromise =
                  waitForPopupPreviewCount(
                      existingCount,
                      files.length
                  );

            let failHandler;

            const failurePromise =
                  new Promise(
                      (_, reject) => {
                          failHandler =
                              async (
                              event,
                              data
                          ) => {
                              console.warn(
                                  '[GuideSearch popup] fileupload failure:',
                                  {
                                      eventType:
                                      event.type,
                                      result:
                                      data?.result,
                                      errorThrown:
                                      data?.errorThrown,
                                      textStatus:
                                      data?.textStatus
                                  }
                              );

                              // alert callback이 같은 event loop에서
                              // 실행될 시간을 조금 준다.
                              await sleep(150);

                              reject(
                                  new Error(
                                      data?.errorThrown ||
                                      data?.textStatus ||
                                      'error'
                                  )
                              );
                          };

                          $form.one(
                              'fileuploadfail.guidesearch',
                              failHandler
                          );

                          $form.one(
                              'fileuploadprocessfail.guidesearch',
                              failHandler
                          );
                      }
                  );

            try {
                console.log(
                    '[GuideSearch popup] Calling fileupload(add):',
                    files
                );

                $form.fileupload(
                    'add',
                    {
                        files
                    }
                );

                uploadedImages =
                    await Promise.race([
                    uploadedPromise,
                    failurePromise
                ]);

                // 성공했으면 retry loop 탈출
                lastError = null;
                break;
            } catch (error) {
                lastError =
                    error;

                await sleep(200);

                const transientAfter =
                      getTransientUploadCount();

                const transientDetected =
                      transientAfter >
                      transientBefore;

                const currentPreviewCount =
                      document.querySelectorAll(
                          'img.listDelip_img'
                      ).length;

                console.warn(
                    '[GuideSearch popup] Upload attempt failed:',
                    {
                        attempt:
                        attempt + 1,
                        transientDetected,
                        existingCount,
                        currentPreviewCount,
                        error:
                        error.message
                    }
                );

                // 기존 시도에서 일부 이미지가 이미 올라갔다면
                // 전부 재업로드하면 중복될 수 있으므로 자동 retry 하지 않는다.
                const partialUpload =
                      currentPreviewCount >
                      existingCount;

                if (
                    transientDetected &&
                    !partialUpload &&
                    attempt <
                    MAX_TRANSIENT_UPLOAD_RETRIES
                ) {
                    console.warn(
                        '[GuideSearch popup] Transient DCInside upload error detected. Retrying once...'
                    );

                    postToOpener({
                        type:
                        MESSAGE.UPLOAD_PROGRESS,

                        requestId,

                        completed:
                        0,

                        total:
                        files.length,

                        message:
                        'DCInside 일시적 업로드 오류 감지 - 자동 재시도'
                    });

                    await sleep(800);

                    continue;
                }

                throw error;
            } finally {
                try {
                    $form.off(
                        '.guidesearch'
                    );
                } catch {}
            }
        }

        if (
            !uploadedImages
        ) {
            throw (
                lastError ||
                new Error(
                    '이미지 업로드에 실패했습니다.'
                )
            );
        }

        console.log(
            '[GuideSearch popup] Upload complete:',
            uploadedImages
        );

        postToOpener({
            type:
            MESSAGE.UPLOAD_PROGRESS,

            requestId,

            completed:
            files.length,

            total:
            files.length
        });

        postToOpener({
            type:
            MESSAGE.UPLOAD_READY_TO_APPLY,

            requestId,

            count:
            uploadedImages.length
        });

        // opener가 메시지를 받을 시간을 약간 준다.
        await sleep(100);

        await applyDcUploadedImages();



    }

    function getPopupPageWindow() {
        return (
            typeof unsafeWindow !==
            'undefined'
            ? unsafeWindow
            : window
        );
    }

    function installUploadAlertInterceptor() {
        const pageWindow =
              getPopupPageWindow();

        if (
            pageWindow
            .__GUIDESEARCH_ALERT_PATCHED__
        ) {
            return;
        }

        const originalAlert =
              pageWindow.alert.bind(
                  pageWindow
              );

        const state = {
            transientCount: 0,
            lastMessage: '',
            lastAt: 0
        };

        pageWindow
            .__GUIDESEARCH_UPLOAD_STATE__ =
            state;

        pageWindow.alert =
            function (message) {
            const text =
                  String(
                      message ?? ''
                  );

            if (
                isTransientUploadAlert(
                    text
                )
            ) {
                state.transientCount += 1;
                state.lastMessage =
                    text;
                state.lastAt =
                    Date.now();

                console.warn(
                    '[GuideSearch popup] DCInside transient upload alert intercepted:',
                    text
                );

                // alert를 실제로 띄우지 않는다.
                // 결과적으로 "확인"을 누른 것과 같은 흐름으로 계속 진행 가능.
                return;
            }

            return originalAlert(
                message
            );
        };

        pageWindow
            .__GUIDESEARCH_ALERT_PATCHED__ =
            true;

        console.log(
            '[GuideSearch popup] Upload alert interceptor installed.'
        );
    }

    function getTransientUploadCount() {
        const pageWindow =
              getPopupPageWindow();

        return (
            pageWindow
            .__GUIDESEARCH_UPLOAD_STATE__
            ?.transientCount ||
            0
        );
    }

    async function applyDcUploadedImages() {
        const pageWindow =
              getPopupPageWindow();

        // DCInside 내부 upload_ing이 있다면
        // 실제 업로드 완료 상태까지 잠깐 기다린다.
        for (
            let i = 0;
            i < 30;
            i += 1
        ) {
            const uploadIng =
                  document.querySelector(
                      'input[name="upload_ing"]'
                  );

            if (
                !uploadIng ||
                uploadIng.value === 'N'
            ) {
                break;
            }

            await sleep(100);
        }

        // 진단 결과상 DCInside 적용 버튼은
        // done()을 호출하므로 이것을 우선 사용한다.
        if (
            typeof pageWindow.done ===
            'function'
        ) {
            console.log(
                '[GuideSearch popup] Calling DCInside done() directly.'
            );

            try {
                pageWindow.done();
                return;
            } catch (error) {
                console.warn(
                    '[GuideSearch popup] done() failed, falling back to apply button:',
                    error
                );
            }
        }

        const applyButton =
              [
                  ...document.querySelectorAll(
                      'button,input[type="button"],a'
                  )
              ].find(
                  (el) => {
                      const text =
                            (
                                el.textContent ||
                                el.value ||
                                ''
                            ).trim();

                      return (
                          el.classList
                          ?.contains(
                              'btn_apply'
                          ) ||
                          text === '적용'
                      );
                  }
              );

        if (!applyButton) {
            throw new Error(
                'DCInside 이미지 적용 버튼과 done() 함수를 모두 찾을 수 없습니다.'
            );
        }

        console.log(
            '[GuideSearch popup] Clicking apply button fallback:',
            applyButton
        );

        applyButton.dispatchEvent(
            new MouseEvent(
                'click',
                {
                    bubbles: true,
                    cancelable: true,
                    view: pageWindow
                }
            )
        );
    }


    function initUploadPopup() {
        console.log(
            '[GuideSearch popup] Upload popup helper initialized.'
        );

        installUploadAlertInterceptor();

        window.addEventListener(
            'message',
            async (event) => {
                if (
                    event.origin !==
                    ORIGIN ||
                    event.source !==
                    window.opener
                ) {
                    return;
                }

                const data =
                      event.data;

                if (
                    data?.type !==
                    MESSAGE.UPLOAD_REQUEST
                ) {
                    return;
                }

                const requestId =
                      data.requestId;

                try {
                    if (
                        !Array.isArray(
                            data.assets
                        ) ||
                        !data.assets.length
                    ) {
                        throw new Error(
                            '업로드할 GuideSearch asset이 없습니다.'
                        );
                    }

                    await uploadAssetsInPopup(
                        data.assets,
                        requestId
                    );
                } catch (error) {
                    console.error(
                        '[GuideSearch popup] Upload failed:',
                        error
                    );

                    postToOpener({
                        type:
                        MESSAGE.UPLOAD_ERROR,

                        requestId,

                        error:
                        error instanceof Error
                        ? error.message
                        : String(error)
                    });
                }
            }
        );

        postToOpener({
            type:
            MESSAGE.POPUP_READY
        });
    }

    if (
        location.pathname ===
        '/upload/image'
    ) {
        initUploadPopup();
        return;
    }

    initWritePage();
})();
