# Photos

Astro photo gallery. Each photo is a page; photos join optional metadata
sidecars to artists, works, galleries, visits, exhibitions, and tags at build
time. No database, no runtime lookup, no client-side data fetching.

Deployed to `https://lab.cartoonbeats.com/photos/` (GitHub Pages project site
under a user custom domain), so every internal link goes through
`src/lib/url.ts`.

## Commands

```sh
npm install
npm run dev                    # astro dev --background is fine too
npm run build                  # runs the photo-access guard, then astro build
npm run preview
npm run scaffold:photos -- <source-dir> [--date yyyymmdd] [--yes] [--dry-run]
```

## Adding photos

1. Export JPEGs from Apple Photos into a folder, e.g. `incoming/20261118/`.
   HEIC and video are rejected by the scaffolder — export JPEG.
2. Optionally add `incoming/20261118/photos.yml` describing the visit and any
   per-photo metadata.
3. Run the scaffolder, review `git diff`, commit images and records together.

```sh
npm run scaffold:photos -- ./incoming/20261118 --date 20261118
```

The scaffolder copies images unchanged and writes a metadata sidecar only when
there is metadata. Existing files are never overwritten: identical files are
skipped, different files get a `-2` suffix.

### `photos.yml`

```yaml
visit:
  gallery: City Gallery Wellington
  visitedAt: 2026-11-18
  exhibitions: [Some Exhibition]
defaults:
  tags: [painting]
photos:
  IMG_4984.jpg:
    artists: [Colin McCahon]
    works:
      - title: Landscape with Too Few Details
        date: "1964"
    tags: [oil-paint]
    takenAt: 2026-11-18T14:32:00+13:00
    alt: McCahon painting, room view
    note: |
      Room view from the south end.
```

The file is optional. Without it, dates come from EXIF, and the scaffolder
prompts for anything missing.

## Content layout

```text
src/content/
  artists/<id>.md
  galleries/<id>.md
  exhibitions/<id>.md
  works/<id>.md
  visits/<year>/<yyyymmdd>-<gallery>.md
  tag-metadata/tags.yml
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.jpg      # committed full quality
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.md       # optional metadata
```

Sidecars do **not** store an image path: the image is discovered by basename in
`src/lib/photos.ts`. References use bare entry ids (`colin-mccahon`,
`2026/20261118-city-gallery-wellington`), not collection-prefixed paths.

A photo's gallery resolves as `photo.visit.gallery` first, then
`photo.gallery`. Photos group by visit when one is recorded, otherwise by date
directory.

## Licensing

- **Photos, captions and notes** — [CC BY 4.0](LICENSE). Attribution: Rua Haszard (haszari), https://cartoonbeats.com, source https://lab.cartoonbeats.com/photos/.
- **Site code** — [MIT](LICENSE-CODE).

Constants live in `src/lib/license.ts`. Every page emits `<link rel="license">`, a canonical URL, and JSON-LD with `creator` and `license`; photo pages emit an additional `ImageObject`. Nothing is visible on the page — a future `/about/` page can render `ATTRIBUTION_LINE` from the same module.

Per-photo creator attribution is not implemented yet. When other people commit photos, the intended rule is to credit the git committer of each image, so a per-photo `credit` field can be derived from history rather than typed by hand.

### Incremental runs

The loop is: run → review → abort or accept → edit `photos.yml` → run again.

```sh
npm run scaffold:photos -- ./incoming/20261118 --dry-run   # review plan, no writes
npm run scaffold:photos -- ./incoming/20261118             # prompts + import
```

- Missing answers are prompted: directory date, gallery, visit date, tags, whether to import Photos keywords.
- Prompted answers are written back into `./incoming/20261118/photos.yml` before the confirm step, so an aborted run still keeps your answers. Disable with `--no-save`.
- Already-imported images are recognised by content hash and skipped, but their metadata is still processed.
- An existing sidecar only gains keys it is missing. Hand edits are never overwritten.
- Nothing left to do prints `Nothing to import` and exits 0.

### When no sidecar is written

A sidecar is created only for information worth keeping: `artists`, `works`, `tags`, `alt`, `sourceCaption`, `visit`, `gallery`, `exhibition`, or a note. A capture time or source filename on its own is not enough — both are recoverable, so those photos get an image and no Markdown file.

Captions: Apple's `Export Photos…` writes the caption to XMP `dc:description`, which appears as `sourceCaption`. Segments that exactly match a known artist name or alias are linked automatically; anything else stays as source text with a warning. `Export Unmodified Original` and drag-and-drop can drop captions entirely.

## Guard

`npm run build` runs `scripts/check-photo-access.mjs`, which fails if
`getCollection('photos')` or `getEntry('photos')` appears outside
`src/lib/photos.ts`. Reading the collection directly returns sidecars only, so
photos without metadata would silently disappear from that page.

## Routes

| Route | Page |
|---|---|
| `/` | all photos, reverse-chronological, grouped, masonry |
| `/photos/{yyyymmdd}/{slug}/` | photo with metadata box |
| `/artists/`, `/galleries/`, `/tags/` | indexes |
| `/artists/{id}/`, `/works/{id}/`, `/galleries/{id}/`, `/visits/{id}/`, `/exhibitions/{id}/`, `/tags/{tag}/` | entity pages |

`<ClientRouter />` handles soft navigation. That is the only client-side script.
