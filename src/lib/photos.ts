import { getCollection, type CollectionEntry } from 'astro:content';

/**
 * Photo discovery.
 *
 * Images live in `src/content/photos/<year>/<yyyymmdd>/`. A Markdown metadata
 * sidecar may sit beside an image with the same filename stem. Sidecars are
 * optional, so images — not sidecars — are the source of truth.
 *
 * This module is the *only* place allowed to read the `photos` collection.
 * `scripts/check-photo-access.mjs` fails the build otherwise.
 */

export type PhotoEntry = CollectionEntry<'photos'>;

export interface Photo {
	/** `<year>/<yyyymmdd>/<stem>`, matching the sidecar id. */
	id: string;
	/** `yyyymmdd` directory name. */
	datestamp: string;
	/** Capture day in UTC, derived from the directory name. */
	date: Date;
	/** URL slug, e.g. `img-4984`. */
	slug: string;
	image: ImageMetadata;
	/** Metadata sidecar, when one exists. */
	entry?: PhotoEntry;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;
const DATE_PREFIX = /^\d{8}-/;
const DATE_DIR = /^(\d{4})(\d{2})(\d{2})$/;

const imageModules = import.meta.glob<ImageMetadata>('/src/content/photos/**/*.{jpg,jpeg,png,webp,avif}', {
	eager: true,
	import: 'default',
});

const key = (value: string) => value.toLowerCase();

export function slugifyStem(stem: string): string {
	return stem
		.replace(DATE_PREFIX, '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function parseDatestamp(datestamp: string): Date | undefined {
	const match = DATE_DIR.exec(datestamp);
	if (!match) return undefined;
	const [, year, month, day] = match;
	return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

export function photoHref(photo: Photo): string {
	return `/photos/${photo.datestamp}/${photo.slug}/`;
}

let photoCache: Promise<Photo[]> | undefined;

export async function getPhotos(): Promise<Photo[]> {
	photoCache ??= load();
	return photoCache;
}

async function load(): Promise<Photo[]> {
	const sidecars = new Map<string, PhotoEntry>();
	for (const entry of await getCollection('photos')) {
		sidecars.set(key(entry.id), entry);
	}

	const photos: Photo[] = [];
	const slugs = new Map<string, string>();

	for (const [path, module] of Object.entries(imageModules)) {
		const relative = path.replace('/src/content/photos/', '');
		const segments = relative.split('/');
		if (segments.length !== 3) {
			console.warn(
				`[photos] skipped ${relative}: expected <year>/<yyyymmdd>/<file>.`,
			);
			continue;
		}

		const [year, datestamp, filename] = segments;
		const date = parseDatestamp(datestamp);
		if (!date) {
			console.warn(`[photos] skipped ${relative}: ${datestamp} is not a yyyymmdd directory.`);
			continue;
		}

		const stem = filename.replace(IMAGE_EXT, '');
		const id = `${year}/${datestamp}/${stem}`;
		const entry = sidecars.get(key(id));
		if (entry) sidecars.delete(key(id));

		const slug = slugifyStem(stem);
		if (!slug) {
			console.warn(`[photos] skipped ${relative}: cannot derive a URL slug.`);
			continue;
		}

		const slugKey = `${datestamp}/${slug}`;
		const existing = slugs.get(slugKey);
		if (existing) {
			throw new Error(
				`[photos] duplicate photo route /photos/${datestamp}/${slug}/ from ${id} and ${existing}. Rename one of the images.`,
			);
		}
		slugs.set(slugKey, id);

		photos.push({ id, datestamp, date, slug, image: module, entry });
	}

	for (const orphan of sidecars.values()) {
		console.warn(`[photos] sidecar without image: src/content/photos/${orphan.id}.md`);
	}

	return photos.sort(byCaptureOrder);
}

export async function getPhoto(id: string): Promise<Photo | undefined> {
	const photos = await getPhotos();
	return photos.find((photo) => photo.id === id);
}

/** Newest first; `takenAt` wins over the directory date when present. */
export function byCaptureOrder(a: Photo, b: Photo): number {
	const aTime = a.entry?.data.takenAt?.getTime() ?? a.date.getTime();
	const bTime = b.entry?.data.takenAt?.getTime() ?? b.date.getTime();
	if (aTime !== bTime) return bTime - aTime;
	return a.id.localeCompare(b.id);
}

export function byChronologicalOrder(a: Photo, b: Photo): number {
	const aTime = a.entry?.data.takenAt?.getTime() ?? a.date.getTime();
	const bTime = b.entry?.data.takenAt?.getTime() ?? b.date.getTime();
	if (aTime !== bTime) return aTime - bTime;
	return a.id.localeCompare(b.id);
}
