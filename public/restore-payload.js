export const RESTORE_PREFIX = 'GUIDESEARCH_RESTORE_V1:';

function occurrenceId(index) {
  return `img-${String(index + 1).padStart(3, '0')}`;
}

export function buildRestorePayload(documentData, latestJsonUrl) {
  if (!documentData || typeof documentData.bodyHtml !== 'string') {
    throw new Error('백업 문서에 bodyHtml이 없습니다.');
  }

  const parsed = new DOMParser().parseFromString(`<body>${documentData.bodyHtml}</body>`, 'text/html');
  const assetsByFileName = new Map((documentData.assets || []).map((asset) => [asset.fileName, asset]));
  const payloadAssets = {};
  const imageOccurrences = [];

  for (const [index, image] of [...parsed.body.querySelectorAll('img')].entries()) {
    const rawSource = image.getAttribute('src') || '';
    let fileName;
    try {
      fileName = decodeURIComponent(new URL(rawSource, latestJsonUrl).pathname.split('/').pop() || '');
    } catch {
      throw new Error(`이미지 경로를 해석할 수 없습니다: ${rawSource || '(empty)'}`);
    }
    const asset = assetsByFileName.get(fileName);
    if (!asset?.hash) throw new Error(`백업 asset을 찾을 수 없습니다: ${fileName}`);

    const id = occurrenceId(index);
    const assetUrl = new URL(rawSource, latestJsonUrl);
    const documentUrl = new URL(latestJsonUrl);
    const expectedPath = `/assets/guide/${documentData.postNo}/${asset.fileName}`;
    if (assetUrl.origin !== documentUrl.origin || !assetUrl.pathname.endsWith(expectedPath)) {
      throw new Error(`GuideSearch asset 경로가 아닙니다: ${rawSource}`);
    }

    payloadAssets[asset.hash] ||= {
      hash: asset.hash,
      fileName: asset.fileName,
      contentType: asset.contentType,
      url: assetUrl.href,
    };
    imageOccurrences.push({ id, assetHash: asset.hash });

    const placeholder = parsed.createElement('span');
    placeholder.setAttribute('data-guidesearch-image', id);
    image.replaceWith(placeholder);
  }

  return {
    type: 'GuideSearchRestore',
    version: 1,
    postNo: String(documentData.postNo || ''),
    title: documentData.title || '',
    sourceUrl: documentData.url || '',
    bodyTemplateHtml: parsed.body.innerHTML,
    imageOccurrences,
    assets: payloadAssets,
  };
}

export function serializeRestorePayload(payload) {
  return `${RESTORE_PREFIX}${JSON.stringify(payload)}`;
}
