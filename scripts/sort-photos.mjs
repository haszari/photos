#!/usr/bin/env node
/**
 * Sort a raw dump of photos into `incoming/<yyyymmdd>/` folders.
 *
 *   npm run sort:photos -- ~/Desktop/raw-export [--preview]
 *
 * Apple Photos already exports "moments" grouped by place and date, so this is
 * the fallback for a flat folder of images from several days. Each photo's
 * EXIF (or ffprobe) capture date chooses its folder; the folder gets a draft
 * `photos.yml` with `location` and `exhibitions` left blank. Rename the folder
 * to `Location, date` and fill the manifest, then run `npm run import:photos`.
 *
 * Files are copied unchanged. An identical file (same content hash) is skipped;
 * a different file with the same name gets a `-2` suffix. `--preview` prints
 * the plan and writes nothing.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { stringify as stringifyYaml } from 'yaml';
import {
	SUPPORTED,
	MEDIA_EXTENSIONS,
	datestampFromDate,
	hashFile,
	scanMedia,
} from './lib/photos.mjs';

const ROOT = process.cwd();
const INCOMING = path.join(ROOT, 'incoming');

const argv = process.argv.slice(2);
const options = { source: undefined, preview: false };

for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	if (arg === '--preview') options.preview = true;
	else if (arg === '--help' || arg === '-h') {
		console.log(await readFile(new URL(import.meta.url), 'utf8').then(helpText));
		process.exit(0);
	} else if (!arg.startsWith('--') && !options.source) options.source = arg;
	else throw new Error(`Unknown argument: ${arg}`);
}

if (!options.source) {
	console.error('Usage: npm run sort:photos -- <source-dir> [--preview]');
	process.exit(1);
}

function helpText(contents) {
	const start = contents.indexOf('/**');
	const end = contents.indexOf('*/');
	return contents.slice(start + 3, end).replace(/^ \* ?/gm, '');
}

const sourceDir = path.resolve(ROOT, options.source);
const entries = await readdir(sourceDir, { withFileTypes: true });
const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();

const groups = new Map();
const skipped = [];
const undated = [];

for (const name of names) {
	const extension = path.extname(name).toLowerCase();
	if (!SUPPORTED.has(extension)) {
		if (MEDIA_EXTENSIONS.has(extension)) skipped.push(`${name} (unsupported format)`);
		continue;
	}
	const info = await scanMedia(path.join(sourceDir, name));
	if (!info.takenAt) {
		undated.push(name);
		continue;
	}
	const datestamp = datestampFromDate(new Date(info.takenAt));
	if (!groups.has(datestamp)) groups.set(datestamp, []);
	groups.get(datestamp).push(name);
}

const plan = [];
for (const [datestamp, files] of [...groups.entries()].sort()) {
	const dir = path.join(INCOMING, datestamp);
	const copies = [];
	for (const name of files) {
		const sourcePath = path.join(sourceDir, name);
		const destination = path.join(dir, name);
		let resolved = destination;
		let counter = 2;
		let identical = false;
		for (;;) {
			try {
				if ((await hashFile(resolved)) === (await hashFile(sourcePath))) {
					identical = true;
					break;
				}
				resolved = path.join(dir, `${path.basename(name, path.extname(name))}-${counter}${path.extname(name)}`);
				counter += 1;
			} catch {
				break;
			}
		}
		copies.push({ sourcePath, destination: resolved, identical });
	}
	plan.push({ datestamp, dir, manifest: path.join(dir, 'photos.yml'), copies });
}

for (const group of plan) {
	console.log(`\n${path.relative(ROOT, group.dir)}/`);
	for (const copy of group.copies) {
		const mark = copy.identical ? '  (already imported)' : '';
		console.log(`  ${path.basename(copy.sourcePath)} -> ${path.relative(ROOT, copy.destination)}${mark}`);
	}
	if (undated.length > 0) console.log('  (no capture date: skipped)');
}

if (skipped.length > 0) {
	console.log('\nSkipped:');
	for (const item of skipped) console.log(`  ${item}`);
}
if (undated.length > 0) {
	console.log('\nNo capture date (pass --date later, or set `date:` in the manifest):');
	for (const name of undated) console.log(`  ${name}`);
}

if (options.preview) {
	console.log('\nPreview: nothing written.');
	process.exit(0);
}

let copies = 0;
for (const group of plan) {
	await mkdir(group.dir, { recursive: true });
	const manifest = group.manifest;
	try {
		await writeFile(
			manifest,
			`---\n${stringifyYaml({
				location: null,
				name: null,
				date: `${group.datestamp.slice(0, 4)}-${group.datestamp.slice(4, 6)}-${group.datestamp.slice(6, 8)}`,
				exhibitions: null,
				photos: {},
			}).trimEnd()}\n---\n`,
			{ flag: 'wx' },
		);
		console.log(`  wrote ${path.relative(ROOT, manifest)}`);
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}
	for (const copy of group.copies) {
		if (copy.identical) continue;
		await copyFile(copy.sourcePath, copy.destination);
		copies += 1;
	}
}

console.log(`\nDone. ${copies} file(s) copied into ${plan.length} folder(s).`);
