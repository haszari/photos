import type { Photo } from './photos';
import {
	getIndex,
	visitGallery,
	type Artist,
	type Exhibition,
	type Gallery,
	type Visit,
	type Work,
} from './content';

export interface PhotoRelations {
	visit?: Visit;
	gallery?: Gallery;
	exhibition?: Exhibition;
	artists: Artist[];
	works: Work[];
}

/**
 * Resolve every reference on a photo's sidecar. Gallery resolution follows the
 * documented precedence: the visit's gallery wins, `photo.gallery` is the
 * fallback for a gallery with no visit record.
 */
export async function getRelations(photo: Photo): Promise<PhotoRelations> {
	const index = await getIndex();
	const data = photo.entry?.data;

	const visit = data?.visit ? index.visitById.get(data.visit.id) : undefined;
	const gallery = visit
		? visitGallery(index, visit)
		: data?.gallery
			? index.galleryById.get(data.gallery.id)
			: undefined;
	const exhibition = data?.exhibition
		? index.exhibitionById.get(data.exhibition.id)
		: undefined;

	const artists = (data?.artists ?? [])
		.map((reference) => index.artistById.get(reference.id))
		.filter((artist): artist is Artist => Boolean(artist));

	const works = (data?.works ?? [])
		.map((reference) => index.workById.get(reference.id))
		.filter((work): work is Work => Boolean(work));

	return { visit, gallery, exhibition, artists, works };
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
