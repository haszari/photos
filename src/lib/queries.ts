import { getPhotos, byCaptureOrder, type Photo } from './photos';
import { getIndex, workArtistIds, visitLocation } from './content';
import { canonicalTag, getTagRegistry, photoTags } from './tags';

/** Photos whose sidecar references the work. */
export async function photosForWork(workId: string): Promise<Photo[]> {
	const photos = await getPhotos();
	return photos.filter((photo) =>
		(photo.entry?.data.works ?? []).some((reference) => reference.id === workId),
	);
}

/**
 * Direct artist references, unioned with photos whose referenced works credit
 * the artist. A work photographed once and reused in many visit photos belongs
 * on the artist's page.
 */
export async function photosForArtist(artistId: string): Promise<Photo[]> {
	const [photos, index] = await Promise.all([getPhotos(), getIndex()]);
	const viaWork = new Set(
		index.works
			.filter((work) => workArtistIds(work).includes(artistId))
			.map((work) => work.id),
	);

	return photos.filter((photo) => {
		const data = photo.entry?.data;
		if (!data) return false;
		if ((data.artists ?? []).some((reference) => reference.id === artistId)) return true;
		return (data.works ?? []).some((reference) => viaWork.has(reference.id));
	});
}

/** Photos from a location: any visit there, plus direct location references. */
export async function photosForLocation(locationId: string): Promise<Photo[]> {
	const [photos, index] = await Promise.all([getPhotos(), getIndex()]);
	const visitIds = new Set(
		index.visits
			.filter((visit) => visitLocation(index, visit)?.id === locationId)
			.map((visit) => visit.id),
	);

	return photos.filter((photo) => {
		const data = photo.entry?.data;
		if (!data) return false;
		if (data.visit && visitIds.has(data.visit.id)) return true;
		return data.location?.id === locationId;
	});
}

export async function photosForVisit(visitId: string): Promise<Photo[]> {
	const photos = await getPhotos();
	return photos.filter((photo) => photo.entry?.data.visit?.id === visitId);
}

/** Photos tagged with an exhibition directly, or taken during a visit to it. */
export async function photosForExhibition(exhibitionId: string): Promise<Photo[]> {
	const [photos, index] = await Promise.all([getPhotos(), getIndex()]);
	const visitIds = new Set(
		index.visits
			.filter((visit) =>
				(visit.data.exhibitions ?? []).some((reference) => reference.id === exhibitionId),
			)
			.map((visit) => visit.id),
	);

	return photos.filter((photo) => {
		const data = photo.entry?.data;
		if (!data) return false;
		if (data.exhibition?.id === exhibitionId) return true;
		return Boolean(data.visit && visitIds.has(data.visit.id));
	});
}

export async function photosForTag(tag: string): Promise<Photo[]> {
	const [photos, registry] = await Promise.all([getPhotos(), getTagRegistry()]);
	const canonical = canonicalTag(tag, registry);
	return photos.filter((photo) =>
		photoTags(photo.entry?.data.tags, registry).includes(canonical),
	);
}

/**
 * Deterministic featured photo: an explicit `featuredPhoto` id wins, otherwise
 * the most recent photo is used.
 */
export function featuredPhoto(candidates: Photo[], preferredId?: string): Photo | undefined {
	if (preferredId) {
		const preferred = candidates.find((photo) => photo.id === preferredId);
		if (preferred) return preferred;
	}
	return [...candidates].sort(byCaptureOrder)[0];
}
