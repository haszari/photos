#!/usr/bin/env node
/**
 * Import photos into `src/content/photos/<year>/<yyyymmdd>/`.
 *
 *   npm run scaffold:photos -- ./incoming/20261118 --date 20261118
 *
 * Options:
 *   --date <yyyymmdd>     Force the directory/filename date (default: each
 *                         photo's EXIF capture date)
 *   --location <name>     Default location for the run (--gallery is an alias)
 *   --visit-date <date>   Default visit date (YYYY-MM-DD)
 *   --tags <a,b>          Default tags for the run
 *   --manifest <file>     Metadata file (defaults to <source>/photos.yml)
 *   --no-save             Do not write prompted answers back to the manifest
 *   --update              Overwrite sidecar fields from the manifest/EXIF
 *                         (default: only add fields that are missing)
 *   --yes                 Accept the plan without confirming
 *   --dry-run             Print the plan and exit
 *
 * Images are copied unchanged. Prompts ask for the directory date, location,
 * visit date and tags unless flags or `photos.yml` already answer them (skip
 * prompts with --yes). Prompted answers are saved back into `photos.yml`, so a
 * run can be aborted, the manifest edited by hand, then re-run: imported
 * images are recognised by content hash, and existing sidecars only gain keys
 * they are missing.
 *
 * A metadata sidecar is written only when there is information worth keeping —
 * artist, work, tags, caption, alt text, visit, exhibition, or a note. A
 * capture time or source filename alone is not enough. Nothing is ever
 * overwritten.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import exifr from 'exifr';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CONTENT = path.join(ROOT, 'src', 'content');
const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.mp4', '.webm']);
const VIDEO = new Set(['.mp4', '.webm']);
const MEDIA_EXTENSIONS = new Set([
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

const argv = process.argv.slice(2);
const options = {
	source: undefined,
	date: undefined,
	location: undefined,
	visitDate: undefined,
	tags: [],
	manifest: undefined,
	yes: false,
	dryRun: false,
	save: true,
	update: false,
};

for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	const next = () => argv[(index += 1)];
	if (arg === '--date') options.date = next();
	else if (arg === '--location' || arg === '--gallery') options.location = next();
	else if (arg === '--visit-date') options.visitDate = next();
	else if (arg === '--tags') options.tags = splitList(next());
	else if (arg === '--manifest') options.manifest = next();
	else if (arg === '--no-save') options.save = false;
	else if (arg === '--update') options.update = true;
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

function normalise(value) {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(normalise);
	return value;
}

function sameValue(a, b) {
	return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function compact(object) {
	for (const [key, value] of Object.entries(object)) {
		const emptyObject =
			value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
		const emptyArray = Array.isArray(value) && value.length === 0;
		if (value === undefined || value === null || value === '' || emptyObject || emptyArray) {
			delete object[key];
		}
	}
	return object;
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
	sidecarUpdates: [],
	entities: [],
	skipped: [],
	warnings: [],
};

async function hashFile(file) {
	return createHash('sha256').update(await readFile(file)).digest('hex');
}

const [locations, artists, works, exhibitions, visits] = await Promise.all([
	walkMarkdown(path.join(CONTENT, 'locations')),
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

function resolveLocation(name) {
	if (!name) return undefined;
	const slug = slugify(name);
	const existing = locations.find(
		(entry) => entry.id === slug || entry.data.name?.toLowerCase() === name.toLowerCase(),
	);
	if (existing) return { id: existing.id, created: false };
	const id = slug;
	locations.push({ id, data: { name } });
	plan.entities.push(`locations/${id}.md`);
	return { id, created: true };
}

function matchArtist(name) {
	if (!name) return undefined;
	const slug = slugify(name);
	return artists.find(
		(artist) =>
			artist.id === slug ||
			artist.data.name?.toLowerCase() === name.toLowerCase() ||
			(artist.data.aliases ?? []).some((alias) => alias.toLowerCase() === name.toLowerCase()),
	);
}

function resolveArtist(name) {
	if (!name) return undefined;
	const existing = matchArtist(name);
	if (existing) return { id: existing.id, created: false };
	const slug = slugify(name);
	artists.push({ id: slug, data: { name } });
	plan.entities.push(`artists/${slug}.md`);
	return { id: slug, created: true };
}

/** Videos have no EXIF; ffprobe often has a creation_time. */
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

/** Caption segments, e.g. `Nigel Wilson | Mary Jane Sneyd` -> two names. */
function captionSegments(captionText) {
	return (captionText ?? '')
		.split('|')
		.map((part) => part.trim())
		.filter(Boolean);
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

function resolveVisit({ datestamp, locationId, visitedAt, title, exhibitionTitles }) {
	const visitDate = visitedAt ?? datestamp;
	const existing = visits.find((visit) => {
		const sameLocation = (visit.data.location ?? '') === (locationId ?? '');
		const sameDate = visit.data.visitedAt
			? isoDate(new Date(visit.data.visitedAt)) === visitDate
			: visit.id.startsWith(visitedAt ? visitedAt.replaceAll('-', '') : '');
		return sameLocation && sameDate;
	});
	if (existing) return { id: existing.id, created: false };

	const year = visitDate.slice(0, 4);
	const prefix = visitDate.replaceAll('-', '');
	const locationPart = locationId ?? slugify(title ?? 'visit');
	const id = `${year}/${prefix}-${locationPart}`;
	const data = {};
	if (locationId) data.location = locationId;
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

// --- Peek at the images ---------------------------------------------------

// Read EXIF/XMP once per image. Capture dates come from the photos themselves;
// `--date` is an override, not a requirement.
const scanned = new Map();
for (const name of images) {
	const sourcePath = path.join(sourceDir, name);
	const info = { takenAt: undefined, captionText: undefined, keywordTags: [] };
	if (VIDEO.has(path.extname(name).toLowerCase())) {
		info.takenAt = await videoTakenAt(sourcePath);
		scanned.set(name, info);
		continue;
	}
	try {
		const exif = await exifr.parse(sourcePath, {
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
	scanned.set(name, info);
}

let runVisitDate = options.visitDate ?? manifestVisit.visitedAt;

/** `--date` override, per-photo `takenAt`, EXIF, then the visit date. */
function dateFor(name) {
	if (options.date) return options.date;
	const metadata = manifestPhotos[name] ?? {};
	const takenAt = metadata.takenAt ?? scanned.get(name)?.takenAt;
	if (takenAt) return datestampFromDate(new Date(takenAt));
	if (runVisitDate) return String(runVisitDate).replaceAll('-', '');
	return undefined;
}

const locationName = options.location ?? manifestVisit.location ?? manifestVisit.gallery;
let runLocationName = locationName;
let runLocation = resolveLocation(locationName);
const runTags = [...options.tags, ...(manifestDefaults.tags ?? [])];

// --- Prompts --------------------------------------------------------------

const prompt = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question) {
	try {
		return await prompt.question(question);
	} catch {
		console.log('\nAborted.');
		prompt.close();
		process.exit(0);
	}
}

const interactive = !options.yes && Boolean(process.stdin.isTTY);

const undated = images.filter((name) => !dateFor(name));
let fallbackDatestamp;

if (undated.length > 0) {
	if (!interactive) {
		throw new Error(
			`No capture date for: ${undated.join(', ')}. Pass --date yyyymmdd, or set takenAt in photos.yml.`,
		);
	}
	const answer = await ask(
		`No capture date for ${undated.length} photo(s). Date to use (YYYYMMDD): `,
	);
	fallbackDatestamp = answer.trim();
	if (!parseDatestamp(fallbackDatestamp)) {
		throw new Error(`Invalid date "${fallbackDatestamp}". Expected YYYYMMDD.`);
	}
}

function datestampFor(name) {
	const value = dateFor(name) ?? fallbackDatestamp;
	if (!parseDatestamp(value)) {
		throw new Error(`Invalid date "${value}" for ${name}. Expected YYYYMMDD.`);
	}
	return value;
}

let importKeywords = manifestDefaults.keywords !== false;

if (interactive) {
	if (!runLocation) {
		const answer = await ask('Location (blank for none): ');
		if (answer.trim()) {
			runLocationName = answer.trim();
			runLocation = resolveLocation(runLocationName);
		}
	}
	if (!runVisitDate) {
		const suggested = images.length > 0 ? isoFromDatestamp(datestampFor(images[0])) : undefined;
		const answer = await ask(
			`Visit date${suggested ? ` [${suggested}]` : ''}: `,
		);
		// Blank keeps per-photo dates; only an explicit answer sets one run date.
		if (answer.trim()) runVisitDate = answer.trim();
	}
	if (runTags.length === 0) {
		const answer = await ask('Tags, comma-separated (blank for none): ');
		runTags.push(...splitList(answer));
	}
	if (manifestDefaults.keywords === undefined) {
		const answer = await ask('Import Photos keywords as tags? [Y/n] ');
		importKeywords = !/^n/i.test(answer.trim());
	}

	// Apple captions often read `Artist | Artist`. Offer to create records for
	// caption names that do not match an existing artist, without assuming every
	// caption segment is a person.
	const unmatchedCaptionNames = [
		...new Set(
			[...scanned.values()]
				.flatMap((info) => captionSegments(info.captionText))
				.filter((name) => !matchArtist(name)),
		),
	];

	if (unmatchedCaptionNames.length > 0) {
		console.log('\nCaption names with no artist record:');
		unmatchedCaptionNames.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
		const answer = await ask(
			'Create these artists? [Y] all, [n] none, or numbers e.g. 1,3: ',
		);
		const reply = answer.trim();
		let chosen = unmatchedCaptionNames;
		if (/^n/i.test(reply)) chosen = [];
		else if (reply && !/^y/i.test(reply)) {
			const indexes = reply
				.split(/[,\s]+/)
				.map((value) => Number.parseInt(value, 10))
				.filter((value) => Number.isInteger(value) && value > 0);
			chosen = indexes
				.map((index) => unmatchedCaptionNames[index - 1])
				.filter(Boolean);
		}
		for (const name of chosen) resolveArtist(name);
	}

	// Keep prompted answers so the next run has them, and so they can be edited
	// by hand between an abort and a re-run.
	if (options.save) {
		const nextManifest = compact({
			...manifest,
			visit: compact({
				...(manifest.visit ?? {}),
				...(runLocationName ? { location: runLocationName } : {}),
				...(runVisitDate ? { visitedAt: runVisitDate } : {}),
			}),
			defaults: {
				...(manifest.defaults ?? {}),
				...(runTags.length > 0 ? { tags: runTags } : {}),
				keywords: importKeywords,
			},
		});
		if (options.dryRun) {
			console.log(`\nWould save answers to ${path.relative(ROOT, manifestPath)}:`);
			for (const line of stringifyYaml(nextManifest).trimEnd().split('\n')) {
				console.log(`  ${line}`);
			}
		} else {
			await writeFile(manifestPath, stringifyYaml(nextManifest));
			console.log(`\nSaved answers to ${path.relative(ROOT, manifestPath)}`);
		}
	}
}

const targetDatestamps = [...new Set(images.map((name) => datestampFor(name)))].sort();

/** Where a source file lands and whether that copy already exists. Cached. */
const destinations = new Map();
async function resolveDestination(name) {
	const cached = destinations.get(name);
	if (cached) return cached;

	const sourcePath = path.join(sourceDir, name);
	const extension = path.extname(name).toLowerCase();
	const stem = path.basename(name, path.extname(name));
	const safeStem = stem.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '');
	const datestamp = datestampFor(name);
	const year = datestamp.slice(0, 4);
	const destinationDir = path.join(CONTENT, 'photos', year, datestamp);

	const baseFilename = `${datestamp}-${safeStem}`;
	let filename = `${baseFilename}${extension}`;
	let counter = 2;
	let alreadyImported = false;
	for (;;) {
		const candidate = path.join(destinationDir, filename);
		let digest;
		try {
			digest = await hashFile(candidate);
		} catch {
			break; // free slot
		}
		if (digest === (await hashFile(sourcePath))) {
			alreadyImported = true;
			break;
		}
		filename = `${baseFilename}-${counter}${extension}`;
		counter += 1;
	}

	const resolved = {
		sourcePath,
		extension,
		datestamp,
		year,
		destinationDir,
		filename,
		alreadyImported,
	};
	destinations.set(name, resolved);
	return resolved;
}

const duplicates = [];
for (const name of images) {
	const resolved = await resolveDestination(name);
	if (resolved.alreadyImported) duplicates.push(name);
}

if (duplicates.length > 0) {
	if (interactive && !options.update) {
		const answer = await ask(
			`${duplicates.length} file(s) already imported. [s]kip or [u]pdate metadata: `,
		);
		if (/^u/i.test(answer.trim())) options.update = true;
	}
	console.log(
		`Already imported: ${duplicates.length} file(s)${options.update ? ', updating sidecars' : ', skipping'}.`,
	);
}

for (const name of images) {
	const { sourcePath, extension, datestamp, year, destinationDir, filename, alreadyImported } =
		await resolveDestination(name);
	const metadata = manifestPhotos[name] ?? {};

	const scannedInfo = scanned.get(name) ?? {};
	const takenAt = metadata.takenAt ?? scannedInfo.takenAt;
	const captionText = scannedInfo.captionText;
	const keywordTags = scannedInfo.keywordTags ?? [];

	// A caption segment that exactly matches a known artist name or alias is
	// linked automatically. Everything else stays source text.
	const segments = captionSegments(captionText);
	const captionArtists = [];
	for (const segment of segments) {
		const artist = matchArtist(segment);
		if (artist) captionArtists.push(artist);
		else plan.warnings.push(`${name}: caption kept as source text: ${segment}`);
	}

	const manifestArtists = (metadata.artists ?? manifestDefaults.artists ?? []).map((artist) =>
		resolveArtist(artist),
	);
	const artistIds = [
		...new Set(
			[...manifestArtists, ...captionArtists].filter(Boolean).map((artist) => artist.id),
		),
	];
	const workEntries = (metadata.works ?? manifestDefaults.works ?? []).map((work) =>
		resolveWork(work, metadata.artists ?? manifestDefaults.artists ?? []),
	);
	const visitWanted = Boolean(
		metadata.location ||
			metadata.visitDate ||
			metadata.visitTitle ||
			metadata.exhibitions ||
			runLocation ||
			runVisitDate ||
			manifestVisit.title,
	);
	const visit = visitWanted
		? resolveVisit({
				datestamp,
				locationId: metadata.location ? resolveLocation(metadata.location)?.id : runLocation?.id,
				visitedAt: metadata.visitDate ?? runVisitDate ?? isoFromDatestamp(datestamp),
				title: metadata.visitTitle ?? manifestVisit.title,
				exhibitionTitles: metadata.exhibitions ?? manifestVisit.exhibitions,
			})
		: undefined;
	const tags = resolveTags([
		...runTags,
		...(metadata.tags ?? []),
		...(importKeywords ? keywordTags : []),
	]);

	const sidecarStem = path.basename(filename, extension);
	const sidecarFile = path.join(destinationDir, `${sidecarStem}.md`);
	const imageId = `${year}/${datestamp}/${sidecarStem}`;

	if (alreadyImported) {
		plan.skipped.push(`${filename} (already imported)`);
	} else {
		plan.images.push({ sourcePath, destination: path.join(destinationDir, filename) });
	}

	const sidecarData = {};
	if (takenAt) sidecarData.takenAt = new Date(takenAt).toISOString();
	if (artistIds.length > 0) sidecarData.artists = artistIds;
	if (workEntries.length > 0) sidecarData.works = workEntries.map((work) => work.id);
	if (metadata.alt) sidecarData.alt = String(metadata.alt);
	if (tags.length > 0) sidecarData.tags = tags;
	sidecarData.sourceFilename = name;
	if (captionText) sidecarData.sourceCaption = captionText;

	// Per the precedence rule, location only appears on a photo with no visit.
	if (visit) sidecarData.visit = visit.id;

	// A sidecar exists only for information worth keeping. A capture time or a
	// source filename alone is not worth a file: both are derivable elsewhere.
	const usefulKeys = [
		'artists',
		'works',
		'tags',
		'alt',
		'sourceCaption',
		'visit',
		'location',
		'exhibition',
	];
	const hasMetadata =
		usefulKeys.some((key) => sidecarData[key] !== undefined && sidecarData[key] !== '') ||
		Boolean(metadata.note);

	let existingSidecar;
	try {
		existingSidecar = await readFrontmatter(sidecarFile);
	} catch {
		existingSidecar = undefined;
	}

	if (existingSidecar) {
		const computed = Object.fromEntries(
			Object.entries(sidecarData).filter(([, value]) => value !== undefined),
		);
		// By default existing sidecars only gain missing keys, so hand edits win.
		// --update lets the manifest/EXIF overwrite what is already there.
		const added = Object.keys(computed).filter((key) => existingSidecar.data[key] === undefined);
		const changed = options.update
			? Object.keys(computed).filter(
					(key) =>
						existingSidecar.data[key] !== undefined &&
						!sameValue(existingSidecar.data[key], computed[key]),
				)
			: [];

		if (added.length > 0 || changed.length > 0) {
			plan.sidecarUpdates.push({
				file: sidecarFile,
				id: imageId,
				data: options.update
					? { ...existingSidecar.data, ...computed }
					: { ...computed, ...existingSidecar.data },
				added,
				changed,
				body: existingSidecar.body,
			});
		}
		continue;
	}

	if (!hasMetadata) continue;

	plan.sidecars.push({
		file: sidecarFile,
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
console.log(
	`Target:  ${targetDatestamps
		.map((value) => `src/content/photos/${value.slice(0, 4)}/${value}`)
		.join(', ')}`,
);
console.log(`Images:  ${plan.images.length} to copy, ${plan.skipped.length} skipped`);
console.log(
	`Sidecars: ${plan.sidecars.length} new, ${plan.sidecarUpdates.length} updated (${plan.images.length - plan.sidecars.length} images need none)`,
);
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
if (plan.sidecarUpdates.length > 0) {
	console.log('\nSidecar updates:');
	for (const update of plan.sidecarUpdates) {
		const parts = [];
		if (update.added.length > 0) parts.push(`adds ${update.added.join(', ')}`);
		if (update.changed.length > 0) parts.push(`updates ${update.changed.join(', ')}`);
		console.log(`  ${path.relative(ROOT, update.file)} (${parts.join('; ')})`);
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

if (
	options.dryRun &&
	(plan.sidecars.length > 0 || plan.sidecarUpdates.length > 0)
) {
	console.log('\nSidecar preview:');
	for (const sidecar of [...plan.sidecars, ...plan.sidecarUpdates]) {
		console.log(`  ${path.relative(ROOT, sidecar.file)}`);
		for (const line of stringifyYaml(sidecar.data).trimEnd().split('\n')) {
			console.log(`    ${line}`);
		}
		if (sidecar.body) console.log(`    ${sidecar.body.trim()}`);
	}
}

if (options.dryRun) {
	console.log('\nDry run: nothing written.');
	prompt.close();
	process.exit(0);
}

const hasWork =
	plan.images.length > 0 ||
	plan.sidecars.length > 0 ||
	plan.sidecarUpdates.length > 0 ||
	plan.entities.length > 0;

if (!hasWork) {
	console.log('\nNothing to import.');
	prompt.close();
	process.exit(0);
}

if (!options.yes) {
	const answer = await ask('\nWrite these files? [y/N] ');
	if (!/^y(es)?$/i.test(answer.trim())) {
		console.log('Aborted.');
		prompt.close();
		process.exit(0);
	}
}
prompt.close();

// --- Write ----------------------------------------------------------------

for (const image of plan.images) {
	await mkdir(path.dirname(image.destination), { recursive: true });
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

for (const update of plan.sidecarUpdates) {
	const frontmatter = stringifyYaml(update.data).trimEnd();
	const body = (update.body ?? '').trim();
	await writeFile(update.file, `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`);
}

const written = new Set(plan.entities);
for (const entity of plan.entities) {
	const [collection, ...rest] = entity.split('/');
	const id = rest.join('/').replace(/\.md$/, '');
	const record =
		{
			locations: locations.find((entry) => entry.id === id),
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

console.log(
	`\nDone. ${written.size} records, ${plan.images.length} images, ${plan.sidecars.length} new sidecars, ${plan.sidecarUpdates.length} updated.`,
);
