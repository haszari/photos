#!/usr/bin/env node
/**
 * Guard against reading the `photos` collection directly.
 *
 * Images are discovered in `src/lib/photos.ts`, which joins optional metadata
 * sidecars. `getCollection('photos')` returns sidecars only, so any call
 * outside that module would silently drop photos without metadata.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SRC = path.resolve(process.cwd(), 'src');
const ALLOWED = new Set([path.join(SRC, 'lib', 'photos.ts'), path.join(SRC, 'content.config.ts')]);
const PATTERNS = [
	/getCollection\(\s*['"]photos['"]/g,
	/getEntry\(\s*['"]photos['"]/g,
	/getEntries\(\s*['"]photos['"]/g,
];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.astro', '.tsx', '.jsx']);

const offences = [];

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			await walk(full);
			continue;
		}
		if (!EXTENSIONS.has(path.extname(entry.name))) continue;
		if (ALLOWED.has(full)) continue;

		const contents = await readFile(full, 'utf8');
		const lines = contents.split('\n');
		for (const [index, line] of lines.entries()) {
			if (PATTERNS.some((pattern) => pattern.test(line))) {
				offences.push(`${path.relative(process.cwd(), full)}:${index + 1}: ${line.trim()}`);
			}
		}
	}
}

await walk(SRC);

if (offences.length > 0) {
	console.error(
		'Reading the `photos` collection outside src/lib/photos.ts drops photos with no metadata sidecar.\n' +
			'Use getPhotos(), getPhoto(id) and photoHref(photo) instead.\n',
	);
	for (const offence of offences) console.error(`  ${offence}`);
	process.exit(1);
}
