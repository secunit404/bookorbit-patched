/**
 * One real grab against your own Storytel account, outside BookOrbit, to confirm the parts
 * verify.mjs can only stub: login, bookshelf, audio link and chapters.
 *
 *   STORYTEL_EMAIL=you@example.com STORYTEL_PASSWORD='…' node try-account.mjs <consumableId> [--download] [--store STHP-SE]
 *
 * The consumable id is the number at the end of a Storytel book URL, e.g. .../mördare-utan-ansikte-10392381.
 * --download also fetches the audio and builds the m4b the way the audiobook-assembly patch does,
 * into ./storytel-test-<id>/, so the chapters and cover can be checked in a player.
 *
 * Costs one login and one audio request. Request paths and statuses are printed; credentials,
 * tokens and signed URLs are not.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import plugin from './index.mjs';

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
const consumableId = args.find((arg) => /^\d+$/.test(arg));
const download = args.includes('--download');
const storeIndex = args.indexOf('--store');
const store = storeIndex >= 0 ? args[storeIndex + 1] : (process.env.STORYTEL_STORE ?? 'STHP-SE');
const email = process.env.STORYTEL_EMAIL;
const password = process.env.STORYTEL_PASSWORD;

if (!consumableId || !email || !password) {
  console.error('usage: STORYTEL_EMAIL=… STORYTEL_PASSWORD=… node try-account.mjs <consumableId> [--download] [--store STHP-SE]');
  process.exit(2);
}

const host = {
  async fetch(url, init = {}) {
    const response = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, redirect: init.redirect ?? 'follow' });
    const { hostname, pathname } = new URL(url);
    console.log(`  ${(init.method ?? 'GET').padEnd(4)} ${hostname}${pathname} -> ${response.status}`);
    return response;
  },
  logger: { log: (message) => console.log(`  plugin: ${message}`), warn: (message) => console.log(`  plugin WARN: ${message}`) },
  buildSearchText: (query) => [query.title, query.author].filter(Boolean).join(' '),
  saveCredential: async () => {},
  fail: (failure, message) => Object.assign(new Error(message), { failure }),
};

const config = {
  id: 1,
  name: 'Storytel',
  baseUrl: 'https://www.storytel.com',
  credential: password,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: { email, store, languages: 'sv', maxGrabsPerDay: 10, minSecondsBetweenGrabs: 1 },
};

console.log(`Grabbing ${consumableId} from ${store}`);
let file;
try {
  file = await plugin.resolveFile({ guid: consumableId, title: consumableId, sizeBytes: null, seeders: null, leechers: null }, config, host, AbortSignal.timeout(60_000));
} catch (error) {
  console.error(`\nFAILED (${error.failure ?? 'error'}): ${error.message}`);
  process.exit(1);
}

const book = file.audiobook;
console.log('\nResolved');
console.log(`  file       ${file.fileName} (${file.format})`);
console.log(`  link       ${new URL(file.url).hostname} (signed, not shown)`);
console.log(`  title      ${book.title}`);
console.log(`  authors    ${book.authors.join(', ')}`);
console.log(`  narrators  ${book.narrators.join(', ')}`);
console.log(`  series     ${book.seriesName ?? '-'} ${book.seriesIndex ?? ''}`);
console.log(`  publisher  ${book.publisher ?? '-'}, ${book.publishedDate ?? '-'}, ${book.language ?? '-'}`);
console.log(`  chapters   ${book.chapters.length}${book.chapters.length ? `: ${book.chapters.slice(0, 3).map((c) => c.title).join(' | ')}${book.chapters.length > 3 ? ' | …' : ''}` : ''}`);
console.log(`  cover      ${book.coverUrl ? 'yes' : 'no'}`);

if (!download) {
  console.log('\nOK. Run again with --download to fetch the audio and build the m4b.');
  process.exit(0);
}

const directory = resolve(`storytel-test-${consumableId}`);
await mkdir(directory, { recursive: true });
const source = join(directory, file.fileName);
console.log(`\nDownloading to ${source}`);
const audio = await fetch(file.url, { headers: { 'User-Agent': 'BookOrbit' } });
if (!audio.ok || !audio.body) {
  console.error(`FAILED: the signed link answered ${audio.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(audio.body), createWriteStream(source));
console.log(`  ${audio.headers.get('content-type')}, ${audio.headers.get('content-length') ?? '?'} bytes`);

const probe = JSON.parse(
  (await execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate:format=duration,bit_rate', '-of', 'json', source]))
    .stdout,
);
const codec = probe.streams?.[0]?.codec_name;
const kbps = Math.round(Number(probe.streams?.[0]?.bit_rate ?? probe.format?.bit_rate) / 1000) || 64;
const durationMs = Math.round(Number(probe.format?.duration) * 1000);
console.log(`  codec ${codec}, ${kbps} kbps, ${(durationMs / 3_600_000).toFixed(2)} h`);

const escape = (value) => String(value).replace(/[\\=;#\n]/g, (char) => `\\${char}`);
const lines = [';FFMETADATA1'];
const tag = (key, value) => value && lines.push(`${key}=${escape(value)}`);
tag('title', book.title);
tag('album', book.title);
tag('artist', book.authors.join(', '));
tag('album_artist', book.authors.join(', '));
tag('composer', book.narrators.join(', '));
tag('show', book.seriesName);
tag('episode_id', book.seriesName ? book.seriesIndex : null);
tag('date', book.publishedDate);
tag('genre', book.genres.join(';'));
tag('description', book.description);
tag('comment', book.description);
tag('media_type', '2');
book.chapters.forEach((chapter, index) => {
  const end = book.chapters[index + 1]?.startMs ?? durationMs;
  if (end > chapter.startMs) lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${chapter.startMs}`, `END=${end}`, `title=${escape(chapter.title)}`);
});
const metadataPath = join(directory, 'ffmetadata.txt');
await writeFile(metadataPath, `${lines.join('\n')}\n`);

let coverPath = null;
if (book.coverUrl) {
  const cover = await fetch(book.coverUrl);
  if (cover.ok) {
    coverPath = join(directory, 'cover.jpg');
    await writeFile(coverPath, Buffer.from(await cover.arrayBuffer()));
  }
}

const output = join(directory, file.fileName.replace(/\.[^.]+$/, '.m4b'));
const ffmpegArgs = ['-v', 'error', '-nostdin', '-y', '-i', source, '-f', 'ffmetadata', '-i', metadataPath];
if (coverPath) ffmpegArgs.push('-i', coverPath);
ffmpegArgs.push('-map', '0:a:0');
if (coverPath) ffmpegArgs.push('-map', '2:v:0');
ffmpegArgs.push('-map_metadata', '1', '-map_chapters', '1');
ffmpegArgs.push(...(codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${Math.min(128, Math.max(32, kbps))}k`]));
if (coverPath) ffmpegArgs.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
ffmpegArgs.push('-movflags', '+faststart', '-f', 'mp4', output);

console.log(`\nBuilding ${output}${codec === 'aac' ? ' (stream copy)' : ' (transcoding, takes a few minutes)'}`);
const started = Date.now();
await execFile('ffmpeg', ffmpegArgs, { maxBuffer: 10 * 1024 * 1024 });
console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s`);

const check = JSON.parse((await execFile('ffprobe', ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', output])).stdout);
console.log(`  chapters in file: ${check.chapters?.length ?? 0}`);
console.log(`  tags: ${['album', 'artist', 'composer', 'show', 'episode_id', 'genre'].map((key) => `${key}=${check.format?.tags?.[key] ?? '-'}`).join(', ')}`);
console.log('\nOK. Open the m4b in a player to check chapters and cover.');
