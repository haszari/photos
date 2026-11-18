#!/usr/bin/env node
/**
 * Import photos into `src/content/photos/<year>/<yyyymmdd>/`.
 *
 *   npm run scaffold:photos -- ./incoming/20261118 --date 20261118
 *
 * Options:
 *   --date <yyyymmdd>     Directory/filename date for this run
 *   --gallery <name>      Default gallery for the run
 *   --visit-date <date>   Default visit date (YYYY-MM-DD)
 *   --tags <a,b>          Default tags for the run
 *   --manifest <file>     Metadata file (defaults to <source>/photos.yml)
 *   --yes                 Accept the plan without confirming
 *   --dry-run             Print the plan and exit
 *
 * Images are copied unchanged. A metadata sidecar is written only when there is
 * metadata for that image. Nothing is ever overwritten.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import exifr from 'exifr';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, 'src', 'content');
const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MEDIA_EXTENSIONS = new Set([
	'.heic',
	'.heif',
	'.tif',
	'.tiff',
	'.gif',
	'.mov',
	'.mp4',
	'.m4v',
	'.avi',
]);

const argv = process.argv.slice(2);
const options = {
	source: undefined,
	date: undefined,
	gallery: undefined,
	visitDate: undefined,
	tags: [],
	manifest: undefined,
	yes: false,
	dryRun: false,
};

for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	const next = () => argv[(index += 1)];
	if (arg === '--date') options.date = next();
	else if (arg === '--gallery') options.gallery = next();
	else if (arg === '--visit-date') options.visitDate = next();
	else if (arg === '--tags') options.tags = splitList(next());
	else if (arg === '--manifest') options.manifest = next();
	else if (arg === '--yes' || arg === '-y') options.yes = true;
	else if (arg === '--dry-run') options.dryRun = true;
	else if (arg === '--help' || arg === '-h') {
		console.log(await readFile(new URL(import.meta.url), 'utf8').then(helpText));
		process.exit(0);
	} else if (!arg.startsWith('--') && !options.source) options.source = arg;
	else throw new Error(`Unknown argument: ${arg}`);
}

if (!options.source) {
	console.error('Usage: npm run scaffold:photos -- <source-dir> [--date yyyymmdd] [--yes] [--dry-run]');
	process.exit(1);
}

function helpText(contents) {
	const start = contents.indexOf('/**');
	const end = contents.indexOf('*/');
	return contents.slice(start + 3, end).replace(/^ \* ?/gm, '');
}

function splitList(value) {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function slugify(value) {
	return value
		.normalize('NFC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizeTag(value) {
	return slugify(value);
}

function datestampFromDate(date) {
	const year = date.getUTCFullYear();
	const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
	const day = `${date.getUTCDate()}`.padStart(2, '0');
	return `${year}${month}${day}`;
}

function isoDate(date) {
	return date.toISOString().slice(0, 10);
}

function parseDatestamp(value) {
	if (!/^\d{8}$/.test(value ?? '')) return undefined;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	return Number.isNaN(date.getTime()) ? undefined : date;
}

async function readFrontmatter(file) {
	const contents = await readFile(file, 'utf8');
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(contents);
	if (!match) return { data: {}, body: contents };
	return { data: parseYaml(match[1]) ?? {}, body: match[2] ?? '' };
}

async function walkMarkdown(directory) {
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
		const id = path
			.relative(directory, full)
			.replace(/\.md$/, '')
			.split(path.sep)
			.join('/');
		results.push({ id, file: full, ...(await readFrontmatter(full)) });
	}
	return results;
}

const plan = {
	images: [],
	sidecars: [],
	entities: [],
	skipped: [],
	warnings: [],
};

async function hashFile(file) {
	return createHash('sha256').update(await readFile(file)).digest('hex');
}

const [galleries, artists, works, exhibitions, visits] = await Promise.all([
	walkMarkdown(path.join(CONTENT, 'galleries')),
	walkMarkdown(path.join(CONTENT, 'artists')),
	walkMarkdown(path.join(CONTENT, 'works')),
	walkMarkdown(path.join(CONTENT, 'exhibitions')),
	walkMarkdown(path.join(CONTENT, 'visits')),
]);

const tagAliases = new Map();
try {
	const tagFile = await readFile(path.join(CONTENT, 'tag-metadata', 'tags.yml'), 'utf8');
	for (const [slug, metadata] of Object.entries(parseYaml(tagFile)?.tags ?? {})) {
		const canonical = normalizeTag(slug);
		for (const alias of metadata?.aliases ?? []) {
			tagAliases.set(normalizeTag(alias), canonical);
		}
	}
} catch {
	// Optional file.
}

function resolveGallery(name) {
	if (!name) return undefined;
	const slug = slugify(name);
	const existing = galleries.find(
		(gallery) => gallery.id === slug || gallery.data.name?.toLowerCase() === name.toLowerCase(),
	);
	if (existing) return { id: existing.id, created: false };
	const id = slug;
	galleries.push({ id, data: { name } });
	plan.entities.push(`galleries/${id}.md`);
	return { id, created: true };
}

function resolveArtist(name) {
	if (!name) return undefined;
	const slug = slugify(name);
	const existing = artists.find(
		(artist) =>
			artist.id === slug ||
			artist.data.name?.toLowerCase() === name.toLowerCase() ||
			(artist.data.aliases ?? []).some((alias) => alias.toLowerCase() === name.toLowerCase()),
	);
	if (existing) return { id: existing.id, created: false };
	artists.push({ id: slug, data: { name } });
	plan.entities.push(`artists/${slug}.md`);
	return { id: slug, created: true };
}

function resolveWork(work, fallbackArtists = []) {
	if (!work?.title) return undefined;
	const title = String(work.title);
	const slug = slugify(title);
	const existing = works.find(
		(entry) => entry.id === slug || entry.data.title?.toLowerCase() === title.toLowerCase(),
	);
	const artistNames = work.artists ?? fallbackArtists;
	const artistIds = artistNames.map((name) => resolveArtist(name)?.id).filter(Boolean);

	if (existing) {
		if (artistIds.length > 0 && !existing.data.artists && !existing.data.artist) {
			existing.data.artists = artistIds.map((id) => id);
		}
		return { id: existing.id, created: false };
	}

	const data = { title };
	if (artistIds.length > 0) data.artists = artistIds;
	if (work.date) data.date = String(work.date);
	works.push({ id: slug, data });
	plan.entities.push(`works/${slug}.md`);
	return { id: slug, created: true };
}

function resolveExhibition(title) {
	if (!title) return undefined;
	const slug = slugify(String(title));
	const existing = exhibitions.find(
		(entry) => entry.id === slug || entry.data.title?.toLowerCase() === String(title).toLowerCase(),
	);
	if (existing) return { id: existing.id, created: false };
	exhibitions.push({ id: slug, data: { title: String(title) } });
	plan.entities.push(`exhibitions/${slug}.md`);
	return { id: slug, created: true };
}

function resolveVisit({ datestamp, galleryId, visitedAt, title, exhibitionTitles }) {
	const visitDate = visitedAt ?? datestamp;
	const existing = visits.find((visit) => {
		const sameGallery = (visit.data.gallery ?? '') === (galleryId ?? '');
		const sameDate = visit.data.visitedAt
			? isoDate(new Date(visit.data.visitedAt)) === visitDate
			: visit.id.startsWith(visitedAt ? visitedAt.replaceAll('-', '') : '');
		return sameGallery && sameDate;
	});
	if (existing) return { id: existing.id, created: false };

	const year = visitDate.slice(0, 4);
	const prefix = visitDate.replaceAll('-', '');
	const galleryPart = galleryId ?? slugify(title ?? 'visit');
	const id = `${year}/${prefix}-${galleryPart}`;
	const data = {};
	if (galleryId) data.gallery = galleryId;
	data.visitedAt = visitDate;
	if (title) data.title = title;

	const exhibitionIds = (exhibitionTitles ?? [])
		.map((exhibitionTitle) => resolveExhibition(exhibitionTitle)?.id)
		.filter(Boolean);
	if (exhibitionIds.length > 0) data.exhibitions = exhibitionIds;

	visits.push({ id, data });
	plan.entities.push(`visits/${id}.md`);
	return { id, created: true };
}

function resolveTags(values) {
	const seen = new Set();
	for (const value of values ?? []) {
		const slug = normalizeTag(value);
		if (slug) seen.add(tagAliases.get(slug) ?? slug);
	}
	return [...seen];
}

// --- Read source folder ----------------------------------------------------

const sourceDir = path.resolve(ROOT, options.source);
const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
const files = sourceEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const images = files.filter((name) => SUPPORTED.has(path.extname(name).toLowerCase()));
const unsupported = files.filter((name) => {
	const extension = path.extname(name).toLowerCase();
	return MEDIA_EXTENSIONS.has(extension) && !SUPPORTED.has(extension);
});

for (const name of unsupported) {
	plan.warnings.push(`unsupported file, not imported: ${name}`);
}
if (unsupported.length === 0 && files.length === 0) {
	plan.warnings.push(`${sourceDir} contains no files.`);
}

// --- Manifest --------------------------------------------------------------

const manifestPath = options.manifest
	? path.resolve(ROOT, options.manifest)
	: path.join(sourceDir, 'photos.yml');
let manifest = {};
try {
	manifest = parseYaml(await readFile(manifestPath, 'utf8')) ?? {};
} catch (error) {
	if (options.manifest) throw error;
}

const manifestVisit = manifest.visit ?? {};
const manifestDefaults = manifest.defaults ?? {};
const manifestPhotos = manifest.photos ?? {};

let runDatestamp = options.date;
let runVisitDate = options.visitDate ?? manifestVisit.visitedAt;
if (!runDatestamp && runVisitDate) runDatestamp = runVisitDate.replaceAll('-', '');
if (!runDatestamp) {
	const firstDate = Object.values(manifestPhotos)
		.map((entry) => entry?.takenAt)
		.find(Boolean);
	if (firstDate) runDatestamp = datestampFromDate(new Date(firstDate));
}

const galleryName = options.gallery ?? manifestVisit.gallery;
const runGallery = resolveGallery(galleryName);
const runTags = [...options.tags, ...(manifestDefaults.tags ?? [])];

// --- Build the plan -------------------------------------------------------

const prompt = createInterface({ input: process.stdin, output: process.stdout });

if (!runDatestamp) {
	const answer = await prompt.question('Directory date for this run (YYYYMMDD): ');
	runDatestamp = answer.trim();
}
const datestamp = runDatestamp;
if (!parseDatestamp(datestamp)) {
	throw new Error(`Invalid date "${datestamp}". Expected YYYYMMDD.`);
}

const year = datestamp.slice(0, 4);
const destinationDir = path.join(CONTENT, 'photos', year, datestamp);

for (const name of images) {
	const sourcePath = path.join(sourceDir, name);
	const metadata = manifestPhotos[name] ?? {};
	const extension = path.extname(name).toLowerCase();
	const stem = path.basename(name, path.extname(name));
	const safeStem = stem.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '');

	let takenAt;
	if (metadata.takenAt) takenAt = new Date(metadata.takenAt);
	else {
		try {
			const exif = await exifr.parse(sourcePath, {
				pick: ['DateTimeOriginal', 'CreateDate'],
			});
			takenAt = exif?.DateTimeOriginal ?? exif?.CreateDate;
		} catch {
			takenAt = undefined;
		}
	}

	let caption;
	let subjectTags = [];
	try {
		const exif = await exifr.parse(sourcePath, { xmp: true, iptc: true });
		caption = exif?.Description ?? exif?.Caption ?? exif?.ImageDescription ?? undefined;
		const subject = exif?.Subject ?? exif?.Keywords;
		if (Array.isArray(subject)) subjectTags = subject.map(String);
		else if (typeof subject === 'string') subjectTags = [subject];
	} catch {
		// No readable IPTC/XMP.
	}

	const artistsForPhoto = (metadata.artists ?? manifestDefaults.artists ?? []).map((artist) =>
		resolveArtist(artist),
	);
	const workEntries = (metadata.works ?? manifestDefaults.works ?? []).map((work) =>
		resolveWork(work, metadata.artists ?? manifestDefaults.artists ?? []),
	);
	const visitWanted = Boolean(
		metadata.gallery ||
			metadata.visitDate ||
			metadata.visitTitle ||
			metadata.exhibitions ||
			runGallery ||
			runVisitDate ||
			manifestVisit.title,
	);
	const visit = visitWanted
		? resolveVisit({
				datestamp,
				galleryId: metadata.gallery ? resolveGallery(metadata.gallery)?.id : runGallery?.id,
				visitedAt: metadata.visitDate ?? runVisitDate ?? isoFromDatestamp(datestamp),
				title: metadata.visitTitle ?? manifestVisit.title,
				exhibitionTitles: metadata.exhibitions ?? manifestVisit.exhibitions,
			})
		: undefined;
	const tags = resolveTags([
		...runTags,
		...(metadata.tags ?? []),
		...subjectTags,
	]);

	const baseFilename = `${datestamp}-${safeStem}`;
	let filename = `${baseFilename}${extension}`;
	let counter = 2;
	// Collisions are resolved against the destination, never by overwriting.
	for (;;) {
		try {
			await readFile(path.join(destinationDir, filename));
		} catch {
			break;
		}
		const same = await hashFile(path.join(destinationDir, filename)).catch(() => undefined);
		if (same && same === (await hashFile(sourcePath))) {
			plan.skipped.push(`${filename} (identical)`);
			filename = undefined;
			break;
		}
		filename = `${baseFilename}-${counter}${extension}`;
		counter += 1;
	}
	if (filename === undefined) continue;

	const imageId = `${year}/${datestamp}/${path.basename(filename, extension)}`;
	plan.images.push({ sourcePath, destination: path.join(destinationDir, filename) });

	const sidecarData = {};
	if (takenAt) sidecarData.takenAt = new Date(takenAt).toISOString();
	if (artistsForPhoto.length > 0) sidecarData.artists = artistsForPhoto.map((artist) => artist.id);
	if (workEntries.length > 0) sidecarData.works = workEntries.map((work) => work.id);
	if (metadata.alt) sidecarData.alt = String(metadata.alt);
	if (tags.length > 0) sidecarData.tags = tags;
	sidecarData.sourceFilename = name;
	if (caption) sidecarData.sourceCaption = String(caption).trim();

	const hasMetadata =
		Object.keys(sidecarData).filter((key) => key !== 'sourceFilename').length > 0 ||
		metadata.note;
	if (!hasMetadata) continue;

	// Per the precedence rule, gallery only appears on a photo with no visit.
	if (visit) sidecarData.visit = visit.id;

	plan.sidecars.push({
		file: path.join(destinationDir, `${path.basename(filename, extension)}.md`),
		id: imageId,
		data: sidecarData,
		body: metadata.note ? `${String(metadata.note).trim()}\n` : '',
	});
}

function isoFromDatestamp(value) {
	return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

// --- Report ---------------------------------------------------------------

console.log(`\nSource:  ${path.relative(ROOT, sourceDir)}`);
console.log(`Target:  ${path.relative(ROOT, destinationDir)}`);
console.log(`Images:  ${plan.images.length} to copy, ${plan.skipped.length} skipped`);
console.log(`Sidecars: ${plan.sidecars.length}`);
console.log(`Records:  ${plan.entities.length}`);

if (plan.entities.length > 0) {
	console.log('\nRecords created:');
	for (const entity of plan.entities) console.log(`  ${entity}`);
}
if (plan.sidecars.length > 0) {
	console.log('\nSidecars:');
	for (const sidecar of plan.sidecars) {
		console.log(`  ${path.relative(ROOT, sidecar.file)}`);
	}
}
if (plan.skipped.length > 0) {
	console.log('\nSkipped:');
	for (const skipped of plan.skipped) console.log(`  ${skipped}`);
}
if (plan.warnings.length > 0) {
	console.log('\nWarnings:');
	for (const warning of plan.warnings) console.log(`  ${warning}`);
}

if (options.dryRun) {
	console.log('\nDry run: nothing written.');
	prompt.close();
	process.exit(0);
}

if (!options.yes) {
	const answer = await prompt.question('\nWrite these files? [y/N] ');
	if (!/^y(es)?$/i.test(answer.trim())) {
		console.log('Aborted.');
		prompt.close();
		process.exit(0);
	}
}
prompt.close();

// --- Write ----------------------------------------------------------------

await mkdir(destinationDir, { recursive: true });
for (const image of plan.images) {
	await copyFile(image.sourcePath, image.destination);
}
for (const sidecar of plan.sidecars) {
	const frontmatter = stringifyYaml(sidecar.data).trimEnd();
	const contents = `---\n${frontmatter}\n---\n${sidecar.body ? `\n${sidecar.body}` : ''}`;
	await writeFile(sidecar.file, contents, { flag: 'wx' }).catch(async (error) => {
		if (error.code !== 'EEXIST') throw error;
		plan.warnings.push(`sidecar already exists, left alone: ${path.relative(ROOT, sidecar.file)}`);
	});
}

const written = new Set(plan.entities);
for (const entity of plan.entities) {
	const [collection, ...rest] = entity.split('/');
	const id = rest.join('/').replace(/\.md$/, '');
	const record =
		{
			galleries: galleries.find((entry) => entry.id === id),
			artists: artists.find((entry) => entry.id === id),
			works: works.find((entry) => entry.id === id),
			exhibitions: exhibitions.find((entry) => entry.id === id),
			visits: visits.find((entry) => entry.id === id),
		}[collection] ?? undefined;
	if (!record) continue;
	const file = path.join(CONTENT, collection, `${id}.md`);
	await mkdir(path.dirname(file), { recursive: true });
	const frontmatter = stringifyYaml(record.data ?? {}).trimEnd();
	await writeFile(file, `---\n${frontmatter}\n---\n`, { flag: 'wx' }).catch((error) => {
		if (error.code !== 'EEXIST') throw error;
	});
}

console.log(`\nDone. ${written.size} records, ${plan.images.length} images, ${plan.sidecars.length} sidecars.`);
