#!/usr/bin/env node
/**
 * Import one folder per visit into `src/content/`.
 *
 *   npm run import:photos [top-folder] [--preview] [--apply] [--skip-save] [--report <file>]
 *
 * The top folder (default `incoming/`) holds one subfolder per visit — one
 * location, one date, any number of shows. Each visit folder has its own
 * `photos.yml`:
 *
 *   location: Auckland Art Gallery        # name or id, required
 *   name:                                 # optional, blank = location's name
 *   date: 2025-06-29                      # optional; folder override, else EXIF
 *   exhibitions:                          # a gallery can hold several shows
 *     - Fiona Pardington                  # a name…
 *     - name: Ancient Worlds              # …or { name, tags } for a common tag
 *       tags: [archaeology]
 *   tags: [painting]                      # fanned into every photo in the visit
 *   photos:
 *     IMG_7302.jpeg:
 *       exhibition: Fiona Pardington      # only when the visit has >1 show
 *       artists: [Fiona Pardington]
 *       works: [A Beautiful Hesitation]
 *       tags: [photography]
 *       alt: ...
 *       note: ...
 *
 * The manifest is the source of truth: a key you set there overwrites the
 * photo's metadata on re-run; a key you leave unset only fills gaps from EXIF,
 * captions and file keywords. Visit tags and exhibition tags fan out into each
 * photo's `tags` at import — the Astro model stays flat, tags live on photos.
 *
 * Prompts ask only for what the manifest is missing (location, exhibitions),
 * then write the manifest back, so you can abort, edit by hand, and re-run.
 * `--apply` runs from the manifest alone with no prompts or confirm.
 * `--preview` prints the plan and writes nothing. `--skip-save` does not write
 * the manifest back.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	SUPPORTED,
	MEDIA_EXTENSIONS,
	captionSegments,
	datestampFromDate,
	hashFile,
	isoDate,
	matchRecord,
	normalizeTag,
	parseDatestamp,
	readFrontmatter,
	scanMedia,
	slugify,
	walkMarkdown,
} from './lib/photos.mjs';

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, 'src', 'content');

const argv = process.argv.slice(2);
const options = {
	top: 'incoming',
	preview: false,
	apply: false,
	save: true,
	report: undefined,
};

for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	const next = () => argv[(index += 1)];
	if (arg === '--preview') options.preview = true;
	else if (arg === '--apply') options.apply = true;
	else if (arg === '--skip-save') options.save = false;
	else if (arg === '--report') options.report = next();
	else if (arg === '--help' || arg === '-h') {
		console.log(await readFile(new URL(import.meta.url), 'utf8').then(helpText));
		process.exit(0);
	} else if (!arg.startsWith('--') && options.top === 'incoming') options.top = arg;
	else throw new Error(`Unknown argument: ${arg}`);
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

/** Read a manifest as yaml, whether it is plain or wrapped in `---`. */
async function readManifest(file) {
	try {
		const contents = await readFile(file, 'utf8');
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(contents);
		return parseYaml(frontmatter ? frontmatter[1] : contents) ?? {};
	} catch {
		return {};
	}
}

/**
 * A record reference in the manifest: a plain name, or an object whose extra
 * keys mirror the record's frontmatter (links, url, address, dates, …). `tags`
 * fans out to photos and never lands on the record; `url` is a shorthand for
 * `links: [{ url }]`.
 */
function recordRef(raw) {
	if (typeof raw === 'string') return { name: raw, tags: [], extra: {} };
	if (!raw || typeof raw !== 'object') return { name: '', tags: [], extra: {} };
	const { name = raw.id ?? '', tags = [], url, ...extra } = raw;
	if (url && !extra.links) extra.links = [{ url }];
	return { name: String(name), tags: Array.isArray(tags) ? tags : [], extra };
}

const plan = {
	images: [],
	sidecars: [],
	sidecarUpdates: [],
	entities: [],
	skipped: [],
	warnings: [],
};

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
		for (const alias of metadata?.aliases ?? []) tagAliases.set(normalizeTag(alias), canonical);
	}
} catch {
	// Optional file.
}

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

const interactive = !options.apply && Boolean(process.stdin.isTTY);
const KIND_PATH = { locations: 'locations', artists: 'artists', works: 'works', exhibitions: 'exhibitions' };

/** Resolve a typed name against a collection, creating it when nothing matches. */
async function resolveNamed(kind, records, name, extra = {}) {
	if (!name) return undefined;
	const result = matchRecord(records, name);
	if (result.exact) return { id: result.exact.id, created: false };
	if (result.close) {
		if (result.close.length === 1) {
			console.log(`  ${name} → ${result.close[0].id}`);
			return { id: result.close[0].id, created: false };
		}
		if (interactive) {
			console.log(`  Ambiguous "${name}":`);
			result.close.forEach((record, index) =>
				console.log(`    ${index + 1}. ${record.data?.name ?? record.id}`),
			);
			const answer = await ask('  Pick a number, type a name, or [c]reate new: ');
			const trimmed = answer.trim();
			const number = Number.parseInt(trimmed, 10);
			if (Number.isInteger(number) && result.close[number - 1]) {
				return { id: result.close[number - 1].id, created: false };
			}
			if (/^c/i.test(trimmed)) return createNamed(kind, records, name, extra);
			if (trimmed) return resolveNamed(kind, records, trimmed, extra);
			return createNamed(kind, records, name, extra);
		}
		console.log(`  ${name}: several close matches; creating a new ${kind.slice(0, -1)}.`);
	}
	return createNamed(kind, records, name, extra);
}

function createNamed(kind, records, name, extra = {}) {
	const id = slugify(name);
	const existing = records.find((record) => record.id === id);
	if (existing) return { id: existing.id, created: false };
	records.push({ id, data: { name, ...extra } });
	plan.entities.push(`${KIND_PATH[kind]}/${id}.md`);
	return { id, created: true };
}

/** A folder is a visit if it holds media; the top folder may itself be one. */
async function discoverVisitFolders(top) {
	const entries = await readdir(top, { withFileTypes: true });
	const hasMedia = entries.some(
		(entry) => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()),
	);
	if (hasMedia) return [top];
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => path.join(top, entry.name));
}

async function importFolder(folder) {
	const images = (await readdir(folder, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()))
		.map((entry) => entry.name)
		.sort();
	if (images.length === 0) return;

	const manifestPath = path.join(folder, 'photos.yml');
	const manifest = await readManifest(manifestPath);
	const manifestPhotos = manifest.photos ?? {};

	console.log(`\n── ${path.relative(ROOT, folder)}`);

	// --- Location (required) -------------------------------------------------
	const locationRef = recordRef(manifest.location);
	let locationName = locationRef.name || undefined;
	const locationExtra = locationRef.extra;
	if (interactive) {
		const answer = await ask(`Location${locationName ? ` (${locationName})` : ''}: `);
		if (answer.trim()) locationName = answer.trim();
	}
	if (!locationName) {
		plan.warnings.push(`${path.relative(ROOT, folder)}: no location; imported without a visit.`);
	}

	// --- Exhibitions (optional) ------------------------------------------------
	// Entries are names, or `{ name, tags, ...record fields }` so a show can
	// carry tags that fan out plus its own links, dates, etc.
	const rawExhibitions = Array.isArray(manifest.exhibitions) ? manifest.exhibitions : [];
	let exhibitionEntries = rawExhibitions.map((entry) => {
		const ref = recordRef(entry);
		return { name: ref.name, tags: ref.tags, extra: ref.extra };
	});
	if (interactive) {
		const existing = exhibitionEntries.map((entry) => entry.name).join(', ');
		const answer = await ask(
			`Exhibitions, comma-separated${existing ? ` (${existing})` : ''} (blank for none): `,
		);
		if (answer.trim()) {
			exhibitionEntries = splitList(answer).map((name) => ({ name, tags: [], extra: {} }));
		}
	}

	// --- Visit-wide tags (fanned into every photo) ----------------------------
	let folderTags = [
		...(Array.isArray(manifest.tags) ? manifest.tags : []),
		...locationRef.tags,
	];
	if (interactive) {
		const answer = await ask(
			`Tags, comma-separated${folderTags.length > 0 ? ` (${folderTags.join(', ')})` : ''} (blank for none): `,
		);
		if (answer.trim()) folderTags = splitList(answer);
	}

	// Echo what this folder will use, whether it came from the manifest or was
	// just prompted, so a re-run confirms the already-entered answers.
	console.log(
		`  ${[
			locationName ?? 'no location',
			exhibitionEntries.length > 0
				? `exhibitions: ${exhibitionEntries.map((entry) => entry.name).join(', ')}`
				: null,
			folderTags.length > 0 ? `tags: ${folderTags.join(', ')}` : null,
		]
			.filter(Boolean)
			.join(' · ')}`,
	);

	// --- Save the completed manifest -----------------------------------------
	const nextManifest = compact({
		location: locationName
			? Object.keys(locationExtra).length > 0
				? { name: locationName, ...locationExtra }
				: locationName
			: manifest.location,
		name: manifest.name,
		date: manifest.date,
		exhibitions:
			exhibitionEntries.length > 0
				? exhibitionEntries.map((entry) => {
						const object = { name: entry.name };
						if (entry.tags.length > 0) object.tags = entry.tags;
						Object.assign(object, entry.extra);
						return Object.keys(object).length > 1 ? object : entry.name;
					})
				: undefined,
		tags: folderTags.length > 0 ? folderTags : undefined,
		photos: manifestPhotos,
	});
	if (options.save && Object.keys(nextManifest).length > 0) {
		const yaml = stringifyYaml(nextManifest);
		if (options.preview) {
			console.log(`\nWould save ${path.relative(ROOT, manifestPath)}:`);
			for (const line of yaml.trimEnd().split('\n')) console.log(`  ${line}`);
		} else {
			await mkdir(folder, { recursive: true });
			await writeFile(manifestPath, `${yaml.trimEnd()}\n`);
		}
	}

	// --- Resolve records ------------------------------------------------------
	const location = locationName
		? await resolveNamed('locations', locations, locationName, locationExtra)
		: undefined;
	const resolvedExhibitions = [];
	const exhibitionTags = new Map();
	for (const entry of exhibitionEntries) {
		const resolved = await resolveNamed('exhibitions', exhibitions, entry.name, entry.extra);
		if (resolved) {
			resolvedExhibitions.push(resolved);
			if (entry.tags.length > 0) exhibitionTags.set(resolved.id, entry.tags);
		}
	}

	// --- Date ---------------------------------------------------------------
	const folderDate = manifest.date ? String(manifest.date).replaceAll('-', '') : undefined;

	const scanned = new Map();
	for (const name of images) scanned.set(name, await scanMedia(path.join(folder, name)));

	const datestampFor = (name) => {
		const exif = scanned.get(name)?.takenAt;
		const value = folderDate ?? (exif ? datestampFromDate(new Date(exif)) : undefined);
		if (!value) return undefined;
		if (!parseDatestamp(value)) {
			throw new Error(`Invalid date "${value}" for ${name}. Expected YYYYMMDD or YYYY-MM-DD.`);
		}
		return value;
	};

	const visitDate = folderDate ?? (images.length > 0 ? datestampFor(images[0]) : undefined);
	const year = visitDate ? visitDate.slice(0, 4) : undefined;
	const visitId = location && visitDate
		? `${year}/${visitDate}-${location.id}`
		: undefined;

	let visit = undefined;
	if (location && visitId) {
		visit = visits.find((entry) => entry.id === visitId);
		if (!visit) {
			const data = {
				location: location.id,
				visitedAt: isoDate(new Date(
					Date.UTC(
						Number(visitDate.slice(0, 4)),
						Number(visitDate.slice(4, 6)) - 1,
						Number(visitDate.slice(6, 8)),
					),
				)),
			};
			if (manifest.name) data.name = manifest.name;
			if (resolvedExhibitions.length > 0) {
				data.exhibitions = resolvedExhibitions.map((exhibition) => exhibition.id);
			}
			visit = { id: visitId, data };
			visits.push(visit);
			plan.entities.push(`visits/${visitId}.md`);
		}
	}

	// --- Caption artists (prompt once per folder, before the photo loop) ---
	const unmatchedCaptions = [];
	for (const name of images) {
		const manifestPhoto = manifestPhotos[name] ?? {};
		if (manifestPhoto.artists?.length) continue;
		for (const captionName of captionSegments(scanned.get(name)?.captionText)) {
			const match = matchRecord(artists, captionName);
			if (!match.exact && !match.close?.length) unmatchedCaptions.push(captionName);
		}
	}
	if (unmatchedCaptions.length > 0 && interactive) {
		const unique = [...new Set(unmatchedCaptions)];
		console.log('\nCaption names with no artist record:');
		unique.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
		const answer = await ask('Create these artists? [Y] all, [n] none, or numbers e.g. 1,3: ');
		const reply = answer.trim();
		let chosen = unique;
		if (/^n/i.test(reply)) chosen = [];
		else if (reply && !/^y/i.test(reply)) {
			const indexes = reply
				.split(/[,\s]+/)
				.map((value) => Number.parseInt(value, 10))
				.filter((value) => Number.isInteger(value) && value > 0);
			chosen = indexes.map((index) => unique[index - 1]).filter(Boolean);
		}
		for (const name of chosen) await resolveNamed('artists', artists, name);
	}

	// --- Per-photo metadata ---------------------------------------------------
	for (const name of images) {
		const manifestPhoto = manifestPhotos[name] ?? {};
		const manifestKeys = new Set(
			Object.keys(manifestPhoto).filter((key) => manifestPhoto[key] !== undefined),
		);
		const info = scanned.get(name);
		const datestamp = datestampFor(name);
		if (!datestamp) {
			plan.warnings.push(`${name}: no capture date; skipped.`);
			continue;
		}

		// Caption names that already match an artist are linked automatically.
		const captionArtists = [];
		if (!manifestKeys.has('artists')) {
			for (const captionName of captionSegments(info.captionText)) {
				const match = matchRecord(artists, captionName);
				if (match.exact) captionArtists.push(match.exact);
			}
		}

		const manifestArtistIds = [];
		for (const artistName of manifestPhoto.artists ?? []) {
			const resolved = await resolveNamed('artists', artists, artistName);
			if (resolved) manifestArtistIds.push(resolved.id);
		}
		const artistIds = manifestKeys.has('artists')
			? manifestArtistIds
			: [...new Set([...captionArtists, ...manifestArtistIds].map((entry) => entry.id ?? entry))];

		const workIds = [];
		for (const workName of manifestPhoto.works ?? []) {
			const resolved = await resolveNamed('works', works, workName);
			if (resolved) workIds.push(resolved.id);
		}

		const photoExhibitionName = manifestPhoto.exhibition;
		const photoExhibition = photoExhibitionName
			? await resolveNamed('exhibitions', exhibitions, photoExhibitionName)
			: undefined;
		if (
			photoExhibition &&
			resolvedExhibitions.length > 0 &&
			!resolvedExhibitions.some((exhibition) => exhibition.id === photoExhibition.id)
		) {
			plan.warnings.push(
				`${name}: exhibition "${photoExhibitionName}" is not one of the visit's shows.`,
			);
		}

		// A show's tags fan out to photos of it; with a single show, that is every
		// photo in the visit, so no per-photo `exhibition` is needed.
		const exhibitTags = photoExhibition
			? (exhibitionTags.get(photoExhibition.id) ?? [])
			: resolvedExhibitions.length === 1
				? (exhibitionTags.get(resolvedExhibitions[0].id) ?? [])
				: [];
		const keywordTags = info.keywordTags ?? [];
		const manifestTags = manifestPhoto.tags ?? [];
		const seen = new Set();
		const tags = [];
		for (const tag of [...folderTags, ...exhibitTags, ...keywordTags, ...manifestTags]) {
			const slug = normalizeTag(tag);
			if (!slug) continue;
			const canonical = tagAliases.get(slug) ?? slug;
			if (!seen.has(canonical)) {
				seen.add(canonical);
				tags.push(canonical);
			}
		}

		const takenAt = manifestPhoto.takenAt ?? info.takenAt;

		const sidecarData = {
			takenAt: takenAt ? new Date(takenAt).toISOString() : undefined,
			artists: artistIds.length > 0 ? artistIds : undefined,
			works: workIds.length > 0 ? workIds : undefined,
			tags: tags.length > 0 ? tags : undefined,
			alt: manifestPhoto.alt,
			sourceFilename: name,
			sourceCaption: info.captionText,
			exhibition: photoExhibition?.id,
			visit: visit?.id,
		};
		for (const key of Object.keys(sidecarData)) {
			if (sidecarData[key] === undefined) delete sidecarData[key];
		}

		// --- destination ---------------------------------------------------
		const extension = path.extname(name).toLowerCase();
		const safeStem = path.basename(name, extension).replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '');
		const destinationDir = path.join(CONTENT, 'photos', year, datestamp);
		let filename = `${datestamp}-${safeStem}${extension}`;
		let counter = 2;
		let alreadyImported = false;
		for (;;) {
			const candidate = path.join(destinationDir, filename);
			try {
				if ((await hashFile(candidate)) === (await hashFile(path.join(folder, name)))) {
					alreadyImported = true;
					break;
				}
				filename = `${datestamp}-${safeStem}-${counter}${extension}`;
				counter += 1;
			} catch {
				break;
			}
		}

		if (alreadyImported) plan.skipped.push(`${name} (already imported)`);
		else plan.images.push({ sourcePath: path.join(folder, name), destination: path.join(destinationDir, filename) });

		const sidecarStem = filename.slice(0, filename.length - extension.length);
		const sidecarFile = path.join(destinationDir, `${sidecarStem}.md`);

		const usefulKeys = ['artists', 'works', 'tags', 'alt', 'sourceCaption', 'exhibition', 'visit'];
		const hasMetadata = usefulKeys.some((key) => sidecarData[key] !== undefined && sidecarData[key] !== '') ||
			Boolean(manifestPhoto.note);

		let existingSidecar;
		try {
			existingSidecar = await readFrontmatter(sidecarFile);
		} catch {
			existingSidecar = undefined;
		}

		if (existingSidecar) {
			const merged = { ...existingSidecar.data };
			const authoritativeKeys = new Set([
				'visit',
				'sourceFilename',
				...(manifestKeys.has('artists') ? ['artists'] : []),
				...(manifestKeys.has('works') ? ['works'] : []),
				...(manifestKeys.has('tags') ? ['tags'] : []),
				...(manifestKeys.has('exhibition') ? ['exhibition'] : []),
				...(manifestKeys.has('alt') ? ['alt'] : []),
				...(manifestKeys.has('takenAt') ? ['takenAt'] : []),
			]);
			for (const key of Object.keys(sidecarData)) {
				if (authoritativeKeys.has(key) || existingSidecar.data[key] === undefined) {
					merged[key] = sidecarData[key];
				}
			}
			plan.sidecarUpdates.push({
				file: sidecarFile,
				data: merged,
				body: manifestPhoto.note ? `${String(manifestPhoto.note).trim()}\n` : existingSidecar.body,
			});
			continue;
		}

		if (!hasMetadata) continue;
		plan.sidecars.push({
			file: sidecarFile,
			data: sidecarData,
			body: manifestPhoto.note ? `${String(manifestPhoto.note).trim()}\n` : '',
		});
	}
}

// --- Run ---------------------------------------------------------------------

const topDir = path.resolve(ROOT, options.top);
const folders = await discoverVisitFolders(topDir);
for (const folder of folders) await importFolder(folder);

// --- Report ------------------------------------------------------------------

console.log(`\nSource:  ${path.relative(ROOT, topDir)}`);
console.log(`Images:  ${plan.images.length} to copy, ${plan.skipped.length} skipped`);
console.log(`Sidecars: ${plan.sidecars.length} new, ${plan.sidecarUpdates.length} updated`);
console.log(`Records:  ${plan.entities.length}`);
for (const entity of plan.entities) console.log(`  ${entity}`);
for (const sidecar of plan.sidecars) console.log(`  ${path.relative(ROOT, sidecar.file)}`);
for (const update of plan.sidecarUpdates) console.log(`  ${path.relative(ROOT, update.file)} (update)`);
for (const skipped of plan.skipped) console.log(`  ${skipped}`);
for (const warning of plan.warnings) console.log(`  ! ${warning}`);

if (options.report) {
	const lines = [
		`Source: ${path.relative(ROOT, topDir)}`,
		`Images: ${plan.images.length} to copy, ${plan.skipped.length} skipped`,
		`Sidecars: ${plan.sidecars.length} new, ${plan.sidecarUpdates.length} updated`,
		`Records: ${plan.entities.length}`,
		...plan.entities.map((entity) => `  ${entity}`),
		...plan.sidecars.map((sidecar) => `  ${path.relative(ROOT, sidecar.file)}`),
		...plan.sidecarUpdates.map((update) => `  ${path.relative(ROOT, update.file)} (update)`),
		...plan.warnings.map((warning) => `  ! ${warning}`),
	];
	await writeFile(path.resolve(ROOT, options.report), lines.join('\n') + '\n');
	console.log(`\nReport written to ${options.report}`);
}

if (options.preview) {
	console.log('\nPreview: nothing written.');
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

if (!options.apply) {
	const answer = await ask('\nWrite these files? [y/N] ');
	if (!/^y(es)?$/i.test(answer.trim())) {
		console.log('Aborted.');
		prompt.close();
		process.exit(0);
	}
}
prompt.close();

// --- Write -------------------------------------------------------------------

for (const image of plan.images) {
	await mkdir(path.dirname(image.destination), { recursive: true });
	await copyFile(image.sourcePath, image.destination);
}
for (const sidecar of plan.sidecars) {
	await mkdir(path.dirname(sidecar.file), { recursive: true });
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
	`\nDone. ${plan.entities.length} records, ${plan.images.length} images, ${plan.sidecars.length} new sidecars, ${plan.sidecarUpdates.length} updated.`,
);
