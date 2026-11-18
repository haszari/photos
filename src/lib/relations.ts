import type { Photo } from './photos';
import {
	getIndex,
	visitLocation,
	type Artist,
	type Exhibition,
	type Location,
	type Visit,
	type Work,
} from './content';

export interface PhotoRelations {
	visit?: Visit;
	location?: Location;
	exhibition?: Exhibition;
	/** Photo's own exhibition plus any listed on its visit. */
	exhibitions: Exhibition[];
	artists: Artist[];
	works: Work[];
}

/**
 * Resolve every reference on a photo's sidecar. Gallery resolution follows the
 * documented precedence: the visit's location wins, `photo.location` is the
 * fallback for a location with no visit record.
 */
export async function getRelations(photo: Photo): Promise<PhotoRelations> {
	const index = await getIndex();
	const data = photo.entry?.data;

	const visit = data?.visit ? index.visitById.get(data.visit.id) : undefined;
	const location = visit
		? visitLocation(index, visit)
		: data?.location
			? index.locationById.get(data.location.id)
			: undefined;
	const exhibition = data?.exhibition
		? index.exhibitionById.get(data.exhibition.id)
		: undefined;

	const exhibitions = [
		exhibition,
		...(visit?.data.exhibitions ?? []).map((reference) =>
			index.exhibitionById.get(reference.id),
		),
	].filter((entry, position, list): entry is Exhibition => Boolean(entry) && list.indexOf(entry) === position);

	const artists = (data?.artists ?? [])
		.map((reference) => index.artistById.get(reference.id))
		.filter((artist): artist is Artist => Boolean(artist));

	const works = (data?.works ?? [])
		.map((reference) => index.workById.get(reference.id))
		.filter((work): work is Work => Boolean(work));

	return { visit, location, exhibition, exhibitions, artists, works };
}

/** Artists credited on a work, resolved through the index. */
export function workArtists(index: Awaited<ReturnType<typeof getIndex>>, work: Work): Artist[] {
	const ids = new Set<string>();
	if (work.data.artist) ids.add(work.data.artist.id);
	for (const artist of work.data.artists ?? []) ids.add(artist.id);
	return [...ids]
		.map((id) => index.artistById.get(id))
		.filter((artist): artist is Artist => Boolean(artist));
}
