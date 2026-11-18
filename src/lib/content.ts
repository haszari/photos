import { getCollection, type CollectionEntry } from 'astro:content';

export type Artist = CollectionEntry<'artists'>;
export type Location = CollectionEntry<'locations'>;
export type Exhibition = CollectionEntry<'exhibitions'>;
export type Work = CollectionEntry<'works'>;
export type Visit = CollectionEntry<'visits'>;

export interface ContentIndex {
	artists: Artist[];
	locations: Location[];
	exhibitions: Exhibition[];
	works: Work[];
	visits: Visit[];
	artistById: Map<string, Artist>;
	locationById: Map<string, Location>;
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
	const [artists, locations, exhibitions, works, visits] = await Promise.all([
		getCollection('artists'),
		getCollection('locations'),
		getCollection('exhibitions'),
		getCollection('works'),
		getCollection('visits'),
	]);

	const byId = <T extends { id: string }>(entries: T[]) =>
		new Map(entries.map((entry) => [entry.id, entry]));

	return {
		artists: [...artists].sort((a, b) => a.data.name.localeCompare(b.data.name)),
		locations: [...locations].sort((a, b) => a.data.name.localeCompare(b.data.name)),
		exhibitions: [...exhibitions].sort((a, b) => a.data.title.localeCompare(b.data.title)),
		works: [...works].sort((a, b) => a.data.title.localeCompare(b.data.title)),
		visits: [...visits],
		artistById: byId(artists),
		locationById: byId(locations),
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

/** Location for a visit, if the visit points at one. */
export function visitLocation(index: ContentIndex, visit: Visit): Location | undefined {
	const location = visit.data.location;
	return location ? index.locationById.get(location.id) : undefined;
}
