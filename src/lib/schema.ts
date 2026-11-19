import { z } from 'astro:content';

/**
 * Shared frontmatter fields.
 *
 * Every record that gets its own page is a *named* entity — artist, location,
 * work, exhibition, visit — and takes its display name from `name`. Build those
 * collections with `entitySchema()` so a new one cannot quietly invent `title`
 * and lose its heading (which is how the work relation once went missing).
 */

/** ISO 3166-1 alpha-2, uppercase: `NZ`, `AU`. */
export const country = z
	.string()
	.regex(/^[A-Z]{2}$/, 'Use an uppercase ISO 3166-1 alpha-2 country code, e.g. NZ.');

/** External pages for a record: artist profiles, gallery sites, listings. */
export const links = z
	.array(
		z.object({
			label: z.string().optional(),
			url: z.string().url(),
		}),
	)
	.optional();

/** Photo id of the image that stands for the record: `2026/20261118/20261118-IMG_4984`. */
export const featuredPhoto = z.string().optional();

/**
 * Schema for a named entity. The name comes first and is required; everything
 * else is the collection's own shape.
 */
export function entitySchema<Shape extends z.ZodRawShape>(shape: Shape) {
	return z.object({ name: z.string(), ...shape });
}
