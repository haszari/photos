import type { Photo } from './photos';
import { byChronologicalOrder } from './photos';
import { getIndex, visitGallery, type Gallery, type Visit } from './content';

export interface PhotoGroup {
	/** `visit:<id>` for a visit group, `date:<yyyymmdd>` otherwise. */
	key: string;
	datestamp: string;
	date: Date;
	visit?: Visit;
	gallery?: Gallery;
	photos: Photo[];
}

/**
 * Group photos by visit when one is recorded, otherwise by date directory.
 * Two visits on the same day therefore produce two groups.
 */
export async function groupPhotos(photos: Photo[]): Promise<PhotoGroup[]> {
	const index = await getIndex();
	const groups = new Map<string, PhotoGroup>();

	for (const photo of photos) {
		const visitReference = photo.entry?.data.visit;
		const visit = visitReference ? index.visitById.get(visitReference.id) : undefined;
		const key = visit ? `visit:${visit.id}` : `date:${photo.datestamp}`;

		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				datestamp: photo.datestamp,
				date: visit?.data.visitedAt ?? photo.date,
				visit,
				gallery: visit ? visitGallery(index, visit) : undefined,
				photos: [],
			};
			groups.set(key, group);
		}
		group.photos.push(photo);
	}

	for (const group of groups.values()) {
		group.photos.sort(byChronologicalOrder);
	}

	return [...groups.values()].sort((a, b) => {
		const timeDiff = b.date.getTime() - a.date.getTime();
		if (timeDiff !== 0) return timeDiff;
		const aName = a.gallery?.data.name ?? a.visit?.data.title ?? a.datestamp;
		const bName = b.gallery?.data.name ?? b.visit?.data.title ?? b.datestamp;
		return aName.localeCompare(bName);
	});
}
