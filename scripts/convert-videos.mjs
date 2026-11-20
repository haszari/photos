#!/usr/bin/env node
/**
 * Convert phone videos into silent web loops.
 *
 *   npm run convert:videos -- ./incoming/20261118      # folder and its subfolders
 *   npm run convert:videos -- ./incoming/IMG_4821.mov   # single file
 *   npm run convert:videos -- ./incoming/20261118 --mode loop --width 960
 *
 * Options:
 *   --mode <boomerang|loop>   boomerang: forward then reversed, seamless loop
 *                             loop: straight trimmed clip (default boomerang)
 *   --max-width <px>         Only downscale if wider than this (default 3840, 4K)
 *   --fps <n>                Resample frame rate (default: keep source)
 *   --crf <n>                x264 quality, lower is better (default 18)
 *   --max-duration <secs>    Trim the source to this many seconds (default: full duration)
 *   --force                  Re-encode files that already exist
 *   --dry-run                Print what would happen
 *
 * Output: `<stem>.mp4` beside the source (H.264, yuv420p, faststart, no audio).
 * The scaffolder then treats it like any other photo asset.
 */
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm']);
const MODES = new Set(['boomerang', 'loop']);

const argv = process.argv.slice(2);
const options = {
	source: undefined,
	mode: 'boomerang',
	maxWidth: 3840,
	fps: 0,
	crf: 18,
	maxDuration: undefined,
	force: false,
	dryRun: false,
};

for (let index = 0; index < argv.length; index += 1) {
	const arg = argv[index];
	const next = () => argv[(index += 1)];
	if (arg === '--mode') options.mode = next();
	else if (arg === '--max-width' || arg === '--width') options.maxWidth = Number(next());
	else if (arg === '--fps') options.fps = Number(next());
	else if (arg === '--crf') options.crf = Number(next());
	else if (arg === '--max-duration') options.maxDuration = Number(next());
	else if (arg === '--force') options.force = true;
	else if (arg === '--dry-run') options.dryRun = true;
	else if (arg === '--help' || arg === '-h') {
		console.log('Usage: npm run convert:videos -- <file-or-dir> [--mode boomerang|loop] [--max-width 3840] [--fps n] [--crf 18] [--max-duration 6] [--force] [--dry-run]');
		process.exit(0);
	} else if (!arg.startsWith('--') && !options.source) options.source = arg;
	else throw new Error(`Unknown argument: ${arg}`);
}

if (!options.source) {
	console.error('Usage: npm run convert:videos -- <file-or-dir> [--mode boomerang|loop]');
	process.exit(1);
}
if (!MODES.has(options.mode)) throw new Error(`Unknown mode "${options.mode}".`);
if (!Number.isFinite(options.maxWidth) || options.maxWidth < 2) throw new Error('Invalid --max-width.');
if (!Number.isFinite(options.fps) || options.fps < 0) throw new Error('Invalid --fps.');
if (!Number.isFinite(options.crf) || options.crf < 0 || options.crf > 51) throw new Error('Invalid --crf.');
if (options.maxDuration !== undefined && (!Number.isFinite(options.maxDuration) || options.maxDuration <= 0)) {
	throw new Error('Invalid --max-duration.');
}

const source = path.resolve(process.cwd(), options.source);
const sourceStat = await stat(source);
const isVideo = (name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());

/** A file is processed alone; a directory contributes its video files. */
const targets = sourceStat.isFile()
	? isVideo(source)
		? [{ dir: path.dirname(source), name: path.basename(source) }]
		: []
	: (await readdir(source, { withFileTypes: true, recursive: true }))
			.filter((entry) => entry.isFile() && isVideo(entry.name))
			.map((entry) => ({ dir: entry.parentPath ?? source, name: entry.name }))
			.sort((a, b) => path.join(a.dir, a.name).localeCompare(path.join(b.dir, b.name)));

if (targets.length === 0) {
	console.log(`No video files in ${options.source}.`);
	process.exit(0);
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`${command} exited ${code}\n${stderr.slice(-800)}`));
		});
	});
}

/** Rotation metadata is common on phone video; bake it into the pixels. */
async function probe(file) {
	const raw = await run('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height,duration:stream_tags=rotate:format=duration:format_tags=creation_time',
		'-of',
		'json',
		file,
	]);
	const data = JSON.parse(raw);
	const stream = data.streams?.[0] ?? {};
	return {
		width: Number(stream.width) || 0,
		height: Number(stream.height) || 0,
		createdAt: data.format?.tags?.creation_time,
	};
}

const workDir = await mkdtemp(path.join(tmpdir(), 'convert-videos-'));
let converted = 0;
let skipped = 0;

try {
	for (const { dir, name } of targets) {
		const sourcePath = path.join(dir, name);
		const stem = path.basename(name, path.extname(name));
		const outputPath = path.join(dir, `${stem}.mp4`);

		let exists = true;
		try {
			await access(outputPath);
		} catch {
			exists = false;
		}
		if (exists && !options.force) {
			console.log(`skip   ${name} (${path.basename(outputPath)} exists, use --force)`);
			skipped += 1;
			continue;
		}

		const info = await probe(sourcePath);
		const cap = Math.round(options.maxWidth / 2) * 2;
		// Resolution and frame rate are preserved. The only scaling is a
		// downscale when the source is wider than the 4K cap.
		const filters = [];
		if (options.fps > 0) filters.push(`fps=${options.fps}`);
		if (info.width > cap) filters.push(`scale=w='trunc(min(iw,${cap})/2)*2':h=-2:flags=lanczos`);
		const chain = filters.join(',');

		const args = ['-y', '-i', sourcePath];
		if (options.maxDuration !== undefined) args.push('-t', String(options.maxDuration));
		if (options.mode === 'boomerang') {
			// Build a palindrome: forward, then reversed, concatenated.
			args.push(
				'-filter_complex',
				`[0:v]${chain ? `${chain},` : ''}split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[out]`,
				'-map',
				'[out]',
			);
		} else if (chain) {
			args.push('-vf', chain);
		}
		args.push(
			'-an',
			'-c:v',
			'libx264',
			'-preset',
			'slow',
			'-crf',
			String(options.crf),
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			outputPath,
		);

		console.log(
			`encode ${name} -> ${path.basename(outputPath)} (${options.mode}, ${info.width}x${info.height} -> ${info.width > cap ? `${cap}px wide` : 'unchanged'}${info.createdAt ? `, shot ${info.createdAt}` : ''})`,
		);
		if (!options.dryRun) await run('ffmpeg', args);
		converted += 1;
	}
} finally {
	await rm(workDir, { recursive: true, force: true });
}

console.log(
	`\n${options.dryRun ? 'Would convert' : 'Converted'} ${converted}, skipped ${skipped}. Mode: ${options.mode}.`,
);
