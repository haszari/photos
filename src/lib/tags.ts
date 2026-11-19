import { getCollection } from 'astro:content';
import { getPhotos } from './photos';
import { tagLabel } from './format';

export interface TagInfo {
	slug: string;
	label: string;
	description?: string;
	count: number;
}

interface TagMetadata {
	label?: string;
	description?: string;
	aliases?: string[];
}

/**
 * Tags that describe the medium or the delivery format rather than the subject.
 * They stay in the photo's sidecar (the import writes them, and they are useful
 * when searching the archive) but are hidden from every view: no pill in the
 * metadata card, no entry in the cloud, no page of their own.
 *
 * Slugs, i.e. after `normalizeTag()`.
 */
export const HIDDEN_TAGS = new Set(['art', 'desktop', 'wallpaper', 'mobile']);

export interface TagRegistry {
	/** Canonical slug -> display metadata. */
	metadata: Map<string, TagMetadata>;
	/** Alias slug -> canonical slug. */
	aliases: Map<string, string>;
}

export function normalizeTag(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[_\s]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function canonicalTag(value: string, registry: TagRegistry): string {
	const slug = normalizeTag(value);
	return registry.aliases.get(slug) ?? slug;
}

export function tagMetadataFor(slug: string, registry: TagRegistry): TagMetadata | undefined {
	return registry.metadata.get(canonicalTag(slug, registry));
}

let registryCache: Promise<TagRegistry> | undefined;

export function getTagRegistry(): Promise<TagRegistry> {
	registryCache ??= loadRegistry();
	return registryCache;
}

async function loadRegistry(): Promise<TagRegistry> {
	const registry: TagRegistry = { metadata: new Map(), aliases: new Map() };

	let entries: Awaited<ReturnType<typeof getCollection<'tagMetadata'>>> = [];
	try {
		entries = await getCollection('tagMetadata');
	} catch {
		// tags.yml is optional.
	}

	for (const entry of entries) {
		for (const [rawSlug, metadata] of Object.entries(entry.data.tags ?? {})) {
			const slug = normalizeTag(rawSlug);
			if (!slug) continue;
			registry.metadata.set(slug, metadata);
			for (const alias of metadata.aliases ?? []) {
				const aliasSlug = normalizeTag(alias);
				if (aliasSlug && aliasSlug !== slug) registry.aliases.set(aliasSlug, slug);
			}
		}
	}

	return registry;
}

/** Canonical tag slugs for a photo, de-duplicated. */
export function photoTags(
	tags: string[] | undefined,
	registry: TagRegistry,
): string[] {
	const slugs = new Set<string>();
	for (const tag of tags ?? []) {
		const slug = canonicalTag(tag, registry);
		if (slug) slugs.add(slug);
	}
	return [...slugs];
}

/** All tags in use, with counts and display metadata. Hidden tags are excluded. */
export async function getTags(): Promise<TagInfo[]> {
	const [photos, registry] = await Promise.all([getPhotos(), getTagRegistry()]);
	const counts = new Map<string, number>();

	for (const photo of photos) {
		for (const slug of photoTags(photo.entry?.data.tags, registry)) {
			if (HIDDEN_TAGS.has(slug)) continue;
			counts.set(slug, (counts.get(slug) ?? 0) + 1);
		}
	}

	return [...counts.entries()]
		.map(([slug, count]) => ({
			slug,
			label: registry.metadata.get(slug)?.label ?? tagLabel(slug),
			description: registry.metadata.get(slug)?.description,
			count,
		}))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function getTag(slug: string): Promise<TagInfo | undefined> {
	const [tags, registry] = await Promise.all([getTags(), getTagRegistry()]);
	const canonical = canonicalTag(slug, registry);
	return tags.find((tag) => tag.slug === canonical);
}
