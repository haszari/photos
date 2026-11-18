# Photos

Astro photo site. Each photo is a page; photos join optional metadata sidecars
to artists, works, locations, visits, exhibitions, and tags at build
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
npm run scaffold:photos -- <source-dir> [--date yyyymmdd] [--yes] [--dry-run] [--update]
npm run convert:videos -- <file-or-dir> [--mode boomerang|loop] [--max-width 3840] [--fps n] [--crf 18] [--max-duration 6] [--force] [--dry-run]
```

## Adding photos

1. Export JPEGs from Apple Photos into a folder, e.g. `incoming/20261118/`.
   The folder name is only a label — each photo's directory date comes from its
   own EXIF capture time.
2. Optionally add `incoming/20261118/photos.yml` describing the visit and any
   per-photo metadata.
3. Run the scaffolder, review `git diff`, commit images and records together.

```sh
npm run scaffold:photos -- ./incoming/20261118
```

`--date yyyymmdd` is an override, not a requirement. Without it, dates come from
EXIF, so one folder may write to several date directories. Photos with no EXIF
date fall back to the visit date, then to a single prompt.

The scaffolder copies images unchanged and writes a metadata sidecar only when
there is metadata. Existing files are never overwritten: identical files are
skipped, different files get a `-2` suffix.

### Videos (boomerangs, cinematographs)

Phones export `.mov`; browsers want `.mp4`. Convert first, then scaffold:

```sh
npm run convert:videos -- ./incoming/20261114/IMG_9171.mov      # one file
npm run convert:videos -- ./incoming/20261114                   # whole folder

npm run scaffold:photos -- ./incoming/20261114
```

- **boomerang** (default): forward + reversed, so it loops seamlessly — the cinematograph look.
- **loop**: straight trimmed clip.
- Output is `<stem>.mp4` beside the source: H.264, `yuv420p`, `+faststart`, **no audio**, trimmed to `--max-duration` (default 6s).
- Resolution and frame rate are preserved. The only resizing is a downscale when the source is wider than `--max-width` (default 3840, i.e. 4K) — nothing is upscaled.
- Quality is `--crf 18` (x264, `preset slow`): visually near-lossless. Raise the CRF for smaller files, lower it for more fidelity. Existing outputs are skipped unless `--force`.
- The scaffolder treats `mp4`/`webm` like any other asset: copied unchanged into the date directory, optional sidecar, same date derivation (ffprobe `creation_time`, then manifest, then prompt).
- On the site the asset renders as `<video autoplay muted loop playsinline>` instead of an `<img>`, so it behaves as a live image in the masonry grid. This is the only autoplaying media on the site; there is no JS to pause it for `prefers-reduced-motion` — a known limitation if that matters later.

### Exporting from Apple Photos

Export in Photos with **File → Export → Export Photos…**, not `Export Unmodified
Original` and not drag-and-drop. In the export sheet set:

- **Photo Kind:** JPEG
- **Quality:** Maximum
- **Include:** tick **Caption**, **Keywords**, and any location/title fields you use

Why it matters:

| Export path | Caption | Keywords |
|---|---|---|
| Export Photos… with Include ticked | ✔ XMP `dc:description` | ✔ XMP `dc:subject` |
| Export Unmodified Original | usually dropped | usually dropped |
| Drag from Photos to Finder | dropped | dropped |

Captions are read as `sourceCaption`. A caption segment that exactly matches a
known artist name or alias links to that artist automatically; the rest is kept
as source text with a warning. Keywords become tags, and the scaffolder asks
whether to import them.

What the export cannot provide, and where it comes from instead:

| Metadata | Source |
|---|---|
| capture time | EXIF `DateTimeOriginal`, or `takenAt` in `photos.yml` |
| caption / artist hint | XMP `dc:description` → `sourceCaption`, then prompt or `photos.yml` |
| keywords / tags | XMP `dc:subject`, then prompt or `photos.yml` |
| location, visit, exhibition | prompt or `photos.yml` |
| work title and date | `photos.yml` only |
| alt text | `photos.yml` only |

HEIC, TIFF, GIF and video are listed as warnings and not imported. If captions
are missing from the exported files, the export path — not the script — dropped
them: check a file with `exiftool <file> | grep -i description` before
re-exporting, and if captions are unavailable, put the artist in `photos.yml`
or answer the prompts.

### `photos.yml`

```yaml
visit:
  location: City Gallery Wellington
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
  locations/<id>.md
  exhibitions/<id>.md
  works/<id>.md
  visits/<year>/<yyyymmdd>-<location>.md
  tag-metadata/tags.yml
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.jpg      # committed full quality
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.md       # optional metadata
```

Sidecars do **not** store an image path: the image is discovered by basename in
`src/lib/photos.ts`. References use bare entry ids (`colin-mccahon`,
`2026/20261118-city-gallery-wellington`), not collection-prefixed paths.

A photo's location resolves as `photo.visit.location` first, then
`photo.location`. Photos group by visit when one is recorded, otherwise by date
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

- Missing answers are prompted: directory date (only if EXIF has none), location, visit date, tags, whether to import Photos keywords, and which unmatched caption names should become artist records.
- Caption prompt lists every name in the run's captions that has no artist record: `[Y] all`, `[n] none`, or numbers like `1,3`. Accepted names become `artists/<slug>.md` and are linked in the sidecars; rejected names stay as `sourceCaption` text with a warning.
- Prompted answers are written back into `./incoming/20261118/photos.yml` before the confirm step, so an aborted run still keeps your answers. Disable with `--no-save`.
- Already-imported files are recognised by content hash. The run reports how many and, when interactive, asks `[s]kip` or `[u]pdate metadata`.
- By default an existing sidecar only gains keys it is missing, so hand edits are never overwritten. `--update` (or answering `u`) lets the manifest and EXIF overwrite existing fields.
- Nothing left to do prints `Nothing to import` and exits 0.

### When no sidecar is written

A sidecar is created only for information worth keeping: `artists`, `works`, `tags`, `alt`, `sourceCaption`, `visit`, `location`, `exhibition`, or a note. A capture time or source filename on its own is not enough — both are recoverable, so those photos get an image and no Markdown file.

Captions: Apple's `Export Photos…` writes the caption to XMP `dc:description`, which appears as `sourceCaption`. The caption is treated as `Artist | Artist` **only when a segment matches an existing artist name or alias**, or when you accept the create-artists prompt. Anything else stays as source text with a warning — a caption is not assumed to name a person. `Export Unmodified Original` and drag-and-drop can drop captions entirely.

## Guard

`npm run build` runs `scripts/check-photo-access.mjs`, which fails if
`getCollection('photos')` or `getEntry('photos')` appears outside
`src/lib/photos.ts`. Reading the collection directly returns sidecars only, so
photos without metadata would silently disappear from that page.

## Routes

| Route | Page |
|---|---|
| `/` | all photos, reverse-chronological, grouped, masonry |
| `/photos/{yyyymmdd}/{slug}/` | photo or video with metadata box |
| `/artists/`, `/locations/`, `/tags/` | indexes |
| `/artists/{id}/`, `/works/{id}/`, `/locations/{id}/`, `/visits/{id}/`, `/exhibitions/{id}/`, `/tags/{tag}/` | entity pages |

`<ClientRouter />` handles soft navigation. That is the only client-side script.
