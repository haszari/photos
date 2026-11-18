import { getCollection, type CollectionEntry } from 'astro:content';

export type Artist = CollectionEntry<'artists'>;
export type Gallery = CollectionEntry<'galleries'>;
export type Exhibition = CollectionEntry<'exhibitions'>;
export type Work = CollectionEntry<'works'>;
export type Visit = CollectionEntry<'visits'>;

export interface ContentIndex {
	artists: Artist[];
	galleries: Gallery[];
	exhibitions: Exhibition[];
	works: Work[];
	visits: Visit[];
	artistById: Map<string, Artist>;
	galleryById: Map<string, Gallery>;
	exhibitionById: Map<string, Exhibition>;
	workById: Map<string, Work>;
	visitById: Map<string, Visit>;
}

let cache: Promise<ContentIndex> | undefined;

export function getIndex(): Promise<ContentIndex> {
	cache ??= loadIndex();
	return cache;
}

async function loadIndex(): Promise<ContentIndex> {
	const [artists, galleries, exhibitions, works, visits] = await Promise.all([
		getCollection('artists'),
		getCollection('galleries'),
		getCollection('exhibitions'),
		getCollection('works'),
		getCollection('visits'),
	]);

	const byId = <T extends { id: string }>(entries: T[]) =>
		new Map(entries.map((entry) => [entry.id, entry]));

	return {
		artists: [...artists].sort((a, b) => a.data.name.localeCompare(b.data.name)),
		galleries: [...galleries].sort((a, b) => a.data.name.localeCompare(b.data.name)),
		exhibitions: [...exhibitions].sort((a, b) => a.data.title.localeCompare(b.data.title)),
		works: [...works].sort((a, b) => a.data.title.localeCompare(b.data.title)),
		visits: [...visits],
		artistById: byId(artists),
		galleryById: byId(galleries),
		exhibitionById: byId(exhibitions),
		workById: byId(works),
		visitById: byId(visits),
	};
}

/** Artist ids referenced by a work, via either `artist` or `artists`. */
export function workArtistIds(work: Work): string[] {
	const ids = new Set<string>();
	if (work.data.artist) ids.add(work.data.artist.id);
	for (const artist of work.data.artists ?? []) ids.add(artist.id);
	return [...ids];
}

/** Gallery for a visit, if the visit points at one. */
export function visitGallery(index: ContentIndex, visit: Visit): Gallery | undefined {
	const gallery = visit.data.gallery;
	return gallery ? index.galleryById.get(gallery.id) : undefined;
}
