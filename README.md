# Photos

A photo archive: every photo is its own page, and each photo is linked to the
artist, work, location, visit, exhibition and tags it belongs to. Everything is
static — built into plain files at deploy time, no database, no client-side
data fetching.

Live at **<https://lab.cartoonbeats.com/photos/>**.

## Importing photos

An import is a folder of photos that make up **one visit** — one place on one
day. Apple Photos exports "moments" that are exactly that.

1. **Export from Apple Photos** — File → Export → Export Photos…, JPEG at
   maximum quality, and tick **Caption** and **Keywords**.
2. **Put each moment folder into `incoming/`.** One folder = one visit. The
   folder name is only a label, e.g. `Auckland, 29 June 2025`.
3. **Sort, only if you have a flat pile of mixed dates:**
   ```sh
   npm run sort:photos -- ~/Desktop/raw-export
   ```
   This splits it into dated folders under `incoming/` with a draft
   `photos.yml` in each.
4. **Import.** It asks once per folder for the location and exhibitions, writes
   those answers into that folder's `photos.yml`, and imports the photos:
   ```sh
   npm run import:photos
   ```
   Import again after editing `photos.yml` — already-imported photos are
   recognised, and only your changed answers are applied.

The loop is: export → answer location and shows → import → review → edit
`photos.yml` → import again. `--preview` shows the plan without writing;
`--apply` skips all prompts.

### The manifest (`photos.yml`)

One per folder, written by the importer and hand-editable:

```yaml
location: Auckland Art Gallery
date: 2025-06-29
exhibitions:
  - Fiona Pardington
  - name: Ancient Worlds
    tags: [archaeology]
tags: [gallery]
photos:
  IMG_7302.jpeg:
    exhibition: Fiona Pardington
    artists: [Fiona Pardington]
    tags: [photography]
```

- `location` and `exhibitions` take a name or an id; a close-match typo is
  corrected, an unmatched name becomes a new record.
- `tags` and each exhibition's `tags` are added to the photos of that
  visit/show — tags live only on photos, never on records.
- Dates come from the photos themselves; `date` overrides for the whole folder.

### Videos

Phones export `.mov`; browsers want `.mp4`. Convert before importing:

```sh
npm run convert:videos -- ./incoming/20261114
```

Default is a boomerang (forward + reversed, seamless loop); `--mode loop` for a
straight clip.

## Content model

```text
src/content/
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.jpg   # the image
  photos/<year>/<yyyymmdd>/<yyyymmdd>-<stem>.md    # its metadata
  artists/<id>.md
  locations/<id>.md
  exhibitions/<id>.md
  works/<id>.md
  visits/<year>/<yyyymmdd>-<location>.md
  tag-metadata/tags.yml
```

In plain terms:

- A **photo** belongs to a **visit** — a place on a day — and a visit belongs
  to a **location**.
- A visit can list several **exhibitions**; a photo can name the one show it
  depicts.
- A photo credits **artists** and **works**, and carries **tags**.
- **Tags** belong only to photos. Visit and exhibition tags are added to the
  photos at import, so the site model stays flat.

Every record with its own page has a `name` and optional `links` (external
pages such as gallery sites). A record with a single link renders its title as
that link.

**Hidden tags** — `art`, `desktop`, `wallpaper`, `mobile` — stay on the photo
but appear nowhere: they describe the file's medium, not its subject.

## Developing

```sh
npm install
npm run dev
npm run build
```

Deploys to GitHub Pages automatically on every push to `main` (GitHub Actions;
enable Pages → Source: GitHub Actions once per repo).

Licensing: photos [CC BY 4.0](LICENSE), site code [MIT](LICENSE-CODE).
