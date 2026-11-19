import { defineCollection, reference, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { country, entitySchema, featuredPhoto, links } from './lib/schema';

/* Named entities (artist, location, work, exhibition, visit) are all built with
   entitySchema(), so every one of them carries the same required `name` field. */

const artists = defineCollection({
	loader: glob({ base: './src/content/artists', pattern: '**/*.md' }),
	schema: entitySchema({
		country: country.optional(),
		aliases: z.array(z.string()).optional(),
		featuredPhoto,
		links,
	}),
});

const locations = defineCollection({
	loader: glob({ base: './src/content/locations', pattern: '**/*.md' }),
	schema: entitySchema({
		/** Street address or area, e.g. `Civic Square` or `Cuba Street`. */
		address: z.string().optional(),
		city: z.string().optional(),
		country: country.optional(),
		featuredPhoto,
		links,
	}),
});

const exhibitions = defineCollection({
	loader: glob({ base: './src/content/exhibitions', pattern: '**/*.md' }),
	schema: entitySchema({
		startDate: z.coerce.date().optional(),
		endDate: z.coerce.date().optional(),
		links,
	}),
});

const works = defineCollection({
	loader: glob({ base: './src/content/works', pattern: '**/*.md' }),
	schema: entitySchema({
		/** Art dates are often uncertain or non-ISO, e.g. `c. 1974` or `1974–75`. */
		date: z.string().optional(),
		artist: reference('artists').optional(),
		artists: z.array(reference('artists')).optional(),
		links,
	}).refine(({ artist, artists }) => !(artist && artists), {
			message: 'Use either artist or artists, not both.',
		}),
});

const visits = defineCollection({
	loader: glob({ base: './src/content/visits', pattern: '**/*.md' }),
	schema: entitySchema({
		/** Visits may be named, but often take the location's name. */
		name: z.string().optional(),
		location: reference('locations').optional(),
		visitedAt: z.coerce.date().optional(),
		exhibitions: z.array(reference('exhibitions')).optional(),
		links,
	}),
});

const tagMetadata = defineCollection({
	loader: glob({ base: './src/content/tag-metadata', pattern: 'tags.yml' }),
	schema: z.object({
		tags: z.record(
			z.string(),
			z.object({
				label: z.string().optional(),
				description: z.string().optional(),
				aliases: z.array(z.string()).optional(),
			}),
		),
	}),
});

/**
 * Metadata sidecars that sit beside an image in `src/content/photos/<year>/<yyyymmdd>/`.
 *
 * The image itself is *not* stored here: images are discovered by basename in
 * `src/lib/photos.ts`. A sidecar is optional, and its id must match the image
 * filename stem, e.g. `2026/20261118/20261118-IMG_4984`.
 */
const photos = defineCollection({
	loader: glob({ base: './src/content/photos', pattern: '**/*.md' }),
	schema: z.object({
		takenAt: z.coerce.date().optional(),
		visit: reference('visits').optional(),
		location: reference('locations').optional(),
		exhibition: reference('exhibitions').optional(),
		artists: z.array(reference('artists')).optional(),
		works: z.array(reference('works')).optional(),
		tags: z.array(z.string()).optional(),
		sourceFilename: z.string().optional(),
		sourceCaption: z.string().optional(),
		alt: z.string().optional(),
	}),
});

export const collections = {
	artists,
	locations,
	exhibitions,
	works,
	visits,
	tagMetadata,
	photos,
};
