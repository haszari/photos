/**
 * Shared helpers for the photo passes (sort + import).
 *
 * Both passes read the same media, dates, names and manifests, so the small
 * pieces live here rather than duplicated or in one bloated script.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import exifr from 'exifr';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const execFileAsync = promisify(execFile);

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
export const SUPPORTED = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
export const MEDIA_EXTENSIONS = new Set([
	...SUPPORTED,
	'.heic',
	'.heif',
	'.tif',
	'.tiff',
	'.gif',
	'.mov',
	'.m4v',
	'.avi',
	'.mkv',
]);

export { parseYaml, stringifyYaml };

export function slugify(value) {
	return value
		.normalize('NFC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

export function normalizeTag(value) {
	return slugify(value);
}

/** Fold case and accents and punctuation so two names compare on sound. */
export function normalizeName(value) {
	return (value ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export function levenshtein(a, b) {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const row = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i += 1) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= n; j += 1) {
			const top = row[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
			previous = top;
		}
	}
	return row[n];
}

/**
 * Match a typed name against records (`{ id, data: { name, aliases? } }`).
 *
 * Returns `{ exact }` for an id or normalised-name match, `{ close }` for the
 * nearest records within a small edit distance (a typo), or `{ none: true }`.
 * The caller decides whether "close" is good enough or needs a prompt.
 */
export function matchRecord(records, name) {
	const slug = slugify(name);
	const target = normalizeName(name);
	const exact = records.find(
		(record) =>
			record.id === slug ||
			normalizeName(record.data?.name) === target ||
			(record.data?.aliases ?? []).some((alias) => normalizeName(alias) === target),
	);
	if (exact) return { exact };

	const close = records
		.filter((record) => {
			const candidate = normalizeName(record.data?.name);
			if (!candidate) return false;
			const nameDistance = levenshtein(target, candidate);
			const aliasDistance = Math.min(
				...(record.data?.aliases ?? []).map((alias) => levenshtein(target, normalizeName(alias))),
				Number.POSITIVE_INFINITY,
			);
			return nameDistance <= 2 || aliasDistance <= 2;
		})
		.sort(
			(a, b) =>
				levenshtein(target, normalizeName(a.data?.name)) -
				levenshtein(target, normalizeName(b.data?.name)),
		);
	return close.length > 0 ? { close } : { none: true };
}

export function datestampFromDate(date) {
	const year = date.getUTCFullYear();
	const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
	const day = `${date.getUTCDate()}`.padStart(2, '0');
	return `${year}${month}${day}`;
}

export function isoDate(date) {
	return date.toISOString().slice(0, 10);
}

export function parseDatestamp(value) {
	if (!/^\d{8}$/.test(value ?? '')) return undefined;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Apple captions read `Artist | Artist`; split into the names. */
export function captionSegments(captionText) {
	return (captionText ?? '')
		.split('|')
		.map((part) => part.trim())
		.filter(Boolean);
}

export async function hashFile(file) {
	return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function readFrontmatter(file) {
	const contents = await readFile(file, 'utf8');
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(contents);
	if (!match) return { data: {}, body: contents };
	return { data: parseYaml(match[1]) ?? {}, body: match[2] ?? '' };
}

/** Every `.md` under a collection directory, id relative to it. */
export async function walkMarkdown(directory) {
	const results = [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true, recursive: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		const full = path.join(entry.parentPath ?? directory, entry.name);
		const id = path.relative(directory, full).replace(/\.md$/, '').split(path.sep).join('/');
		results.push({ id, file: full, ...(await readFrontmatter(full)) });
	}
	return results;
}

/** Videos carry no EXIF; ffprobe often has a creation_time. */
async function videoTakenAt(file) {
	try {
		const { stdout } = await execFileAsync('ffprobe', [
			'-v',
			'error',
			'-show_entries',
			'format_tags=creation_time',
			'-of',
			'json',
			file,
		]);
		const created = JSON.parse(stdout)?.format?.tags?.creation_time;
		return created ? new Date(created) : undefined;
	} catch {
		return undefined;
	}
}

/** Capture time, caption and keyword tags embedded in an image or video. */
export async function scanMedia(file) {
	const info = { takenAt: undefined, captionText: undefined, keywordTags: [] };
	if (VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) {
		info.takenAt = await videoTakenAt(file);
		return info;
	}
	try {
		const exif = await exifr.parse(file, {
			xmp: true,
			iptc: true,
			exif: true,
			tiff: true,
		});
		info.takenAt = exif?.DateTimeOriginal ?? exif?.CreateDate;
		const caption = exif?.ImageDescription ?? exif?.Description ?? exif?.Caption;
		if (typeof caption === 'string') {
			info.captionText = caption.replace(/[|\s]+$/u, '').trim() || undefined;
		}
		const subject = exif?.Subject ?? exif?.subject ?? exif?.Keywords;
		if (Array.isArray(subject)) info.keywordTags = subject.map(String);
		else if (typeof subject === 'string') info.keywordTags = [subject];
	} catch {
		// No readable EXIF/XMP.
	}
	return info;
}
