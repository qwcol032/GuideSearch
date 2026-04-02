# GuideSearch (DCInside backup + search)

A GitHub Pages-compatible static site that:

- Backs up configured DCInside source(collection) posts.
- Extracts and backs up linked guide posts.
- Builds a static search index over both source + guide documents.
- Tracks crawl/backup failures (deleted/forbidden/rate limited/parse/network errors).

## Repository structure

```text
.
├─ data/
│  ├─ sources.json
│  ├─ documents/
│  │  ├─ source/{postNo}/{YYYY-MM-DD}.json
│  │  ├─ source/{postNo}/latest.json
│  │  ├─ guide/{postNo}/{YYYY-MM-DD}.json
│  │  └─ guide/{postNo}/latest.json
│  ├─ search-index.json
│  └─ crawl-status.json
├─ scripts/
│  └─ crawl.mjs
├─ public/
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
├─ .github/workflows/
│  ├─ weekly-backup.yml
│  └─ deploy-pages.yml
├─ package.json
└─ .nojekyll
```

## Seed source

Initial source is statically configured in `data/sources.json`:

- `https://gall.dcinside.com/mgallery/board/view?id=gov&no=3624608`

You can append additional sources later.

## Data model

### Source definition (`data/sources.json`)

```json
{
  "sources": [
    {
      "id": "gov-3624608",
      "url": "https://gall.dcinside.com/mgallery/board/view?id=gov&no=3624608",
      "galleryId": "gov",
      "enabled": true
    }
  ]
}
```

### Document JSON

Each document (source/guide) stores:

- `id`
- `docType` (`source` | `guide`)
- `title`
- `body` (plain text)
- `snippet`
- `url`
- `postNo`
- `backupDate`
- `parentSourcePostNo` (`guide` only)

### Crawl status (`data/crawl-status.json`)

Per URL/post keeps:

- `status`: `ok`, `deleted`, `forbidden`, `rate_limited`, `parse_failed`, `network_error`
- `httpStatus`
- `error`
- `lastAttemptAt`
- `lastSuccessAt`
- `url`
- `postNo`
- `docType`

## How crawling works

Run:

```bash
npm install
npm run crawl
```

Crawler behavior:

1. Reads static sources from `data/sources.json`.
2. Backs up each source post itself as searchable `source` doc.
3. Extracts DCInside links from source content (`a[href]` first, regex fallback).
4. Normalizes absolute URLs and deduplicates linked docs by `no` (post number).
5. Prioritizes links from same gallery id when ordering.
6. Backs up each linked guide as `guide` doc.
7. Stores dated file + updates `latest.json`.
8. Rebuilds `data/search-index.json` from all latest docs.
9. Updates `data/crawl-status.json` for both successes and failures.

If a crawl fails on a later run, older backed-up documents remain searchable because the search index is generated from existing `latest.json` files.

## Frontend (GitHub Pages)

Static UI in `public/` provides:

- Search input + button.
- Result list (title, doc type, post number, backup date, snippet, original link).
- Empty-results message.
- Doc type badge (`source` / `guide`).
- Problematic backup panel based on `data/crawl-status.json`.
- URL query preservation (`?q=...`) and keyword highlighting (`<mark>`).

### Local preview

From repository root:

```bash
python3 -m http.server 4173
```

Open:

- `http://localhost:4173/public/` (frontend)
- `http://localhost:4173/data/` (backup data JSON)

## GitHub Actions weekly backup

Workflow: `.github/workflows/weekly-backup.yml`

Triggers:

- `workflow_dispatch`
- weekly schedule

Workflow steps:

1. Checkout repository.
2. Setup Node.js 24.
3. Install dependencies.
4. Run crawler.
5. Commit/push changed files under `data/`.

## GitHub Pages setup (Static HTML workflow)

This repo uses a dedicated Pages workflow (`.github/workflows/deploy-pages.yml`) with GitHub Actions.

Deployment behavior:
- Triggered automatically by `workflow_run` after **Weekly DCInside Backup** completes successfully
- Also supports manual `workflow_dispatch`

Pages actions used:
- `actions/configure-pages`
- `actions/upload-pages-artifact`
- `actions/deploy-pages`

How deployment works:

1. Workflow checks out the repo.
2. Copies `data/` into `public/data/` in CI (no Jekyll conversion).
3. Uploads `public/` as the Pages artifact.
4. Deploys artifact to GitHub Pages.

In GitHub settings, ensure Pages is configured to use **GitHub Actions** as the source.

Project site URL for this repository:

- `https://qwcol032.github.io/GuideSearch/`

## Notes / parser dependencies

DCInside HTML structure may change. Site-specific parsing selectors are isolated in `scripts/crawl.mjs`:

- `extractTitle()`
- `extractBody()`
- `extractGuideLinks()`

If parsing starts failing, update those functions first.
