import { getCollection, type CollectionEntry } from 'astro:content';

/**
 * Photo discovery.
 *
 * Assets live in `src/content/photos/<year>/<yyyymmdd>/`. An asset is either a
 * still image or a short silent video loop (boomerang, cinematograph). A
 * Markdown metadata sidecar may sit beside an asset with the same filename
 * stem. Sidecars are optional, so assets — not sidecars — are the source of
 * truth.
 *
 * This module is the *only* place allowed to read the `photos` collection.
 * `scripts/check-photo-access.mjs` fails the build otherwise.
 */

export type PhotoEntry = CollectionEntry<'photos'>;

export type PhotoMedia =
	| { kind: 'image'; image: ImageMetadata }
	| { kind: 'video'; src: string };

export interface Photo {
	/** `<year>/<yyyymmdd>/<stem>`, matching the sidecar id. */
	id: string;
	/** `yyyymmdd` directory name. */
	datestamp: string;
	/** Capture day in UTC, derived from the directory name. */
	date: Date;
	/** URL slug, e.g. `img-4984`. */
	slug: string;
	media: PhotoMedia;
	/** Metadata sidecar, when one exists. */
	entry?: PhotoEntry;
}

const ANY_EXT = /\.(jpe?g|png|webp|avif|mp4|webm)$/i;
const DATE_PREFIX = /^\d{8}-/;
const DATE_DIR = /^(\d{4})(\d{2})(\d{2})$/;

const stillModules = import.meta.glob<ImageMetadata>('/src/content/photos/**/*.{jpg,jpeg,png,webp,avif}', {
	eager: true,
	import: 'default',
});

const videoModules = import.meta.glob<string>('/src/content/photos/**/*.{mp4,webm}', {
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

	const add = (path: string, media: PhotoMedia) => {
		const relative = path.replace('/src/content/photos/', '');
		const segments = relative.split('/');
		if (segments.length !== 3) {
			console.warn(`[photos] skipped ${relative}: expected <year>/<yyyymmdd>/<file>.`);
			return;
		}

		const [year, datestamp, filename] = segments;
		const date = parseDatestamp(datestamp);
		if (!date) {
			console.warn(`[photos] skipped ${relative}: ${datestamp} is not a yyyymmdd directory.`);
			return;
		}

		const stem = filename.replace(ANY_EXT, '');
		const id = `${year}/${datestamp}/${stem}`;
		const entry = sidecars.get(key(id));
		if (entry) sidecars.delete(key(id));

		const slug = slugifyStem(stem);
		if (!slug) {
			console.warn(`[photos] skipped ${relative}: cannot derive a URL slug.`);
			return;
		}

		const slugKey = `${datestamp}/${slug}`;
		const existing = slugs.get(slugKey);
		if (existing) {
			console.warn(
				`[photos] skipped ${relative}: /photos/${datestamp}/${slug}/ is already used by ${existing}.`,
			);
			return;
		}
		slugs.set(slugKey, id);

		photos.push({ id, datestamp, date, slug, media, entry });
	};

	for (const [path, image] of Object.entries(stillModules)) {
		add(path, { kind: 'image', image });
	}
	for (const [path, src] of Object.entries(videoModules)) {
		add(path, { kind: 'video', src });
	}

	for (const orphan of sidecars.values()) {
		console.warn(`[photos] sidecar without asset: src/content/photos/${orphan.id}.md`);
	}

	return photos.sort(byCaptureOrder);
}

export async function getPhoto(id: string): Promise<Photo | undefined> {
	const photos = await getPhotos();
	return photos.find((photo) => photo.id === id);
}

/** Alt text for an image, or the accessible label for a video. */
export function altText(photo: Photo): string {
	return photo.entry?.data.alt ?? photo.entry?.data.sourceCaption ?? '';
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
