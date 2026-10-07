/**
 * Exercises the plugin against a stubbed host. The search and book-details fixtures are real
 * Storytel responses saved on 2026-10-07; the account endpoints (login, bookshelf, audio link,
 * chapters) are shaped after audiobook-dl and Music Assistant, since they need a live account.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const SEARCH = fixture('search-mordare.json');
const DETAILS = fixture('details-10392381.json');
const SIGNED = 'https://cdn.storytel.example/10392381.mp3?sig=abc';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeHost(routes) {
  const reqs = [];
  return {
    reqs,
    fetch: async (url, init = {}) => {
      reqs.push({ url, init });
      for (const [match, respond] of routes) {
        if (url.includes(match)) return respond(url, init);
      }
      return json({ message: 'unrouted' }, 500);
    },
    logger: { log: () => {}, warn: () => {} },
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' '),
    saveCredential: async () => {},
    fail: (failure, message) => Object.assign(new Error(message), { failure }),
  };
}

function accountRoutes(over = {}) {
  return [
    ['/api/login.action', over.login ?? (() => json({ accountInfo: { jwt: 'jwt-1', singleSignToken: 'sst' } }))],
    ['/book-details/consumables/', () => json(DETAILS)],
    [
      '/libraries/bookshelf',
      over.bookshelf ??
        ((_url, init) => {
          const body = JSON.parse(init.body);
          const ids = Object.keys(body.items ?? {});
          return json({ resourceVersion: 'rv-2', items: Object.fromEntries(ids.map((id) => [id, { action: 'SET', model: { state: 'WILL_CONSUME' } }])) });
        }),
    ],
    ['/assets/v2/consumables/10392381/url', over.url ?? (() => json({ result: { signedUrl: SIGNED } }))],
    ['cdn.storytel.example', over.cdn ?? (() => json({}, 500))],
    [
      '/playback-metadata/consumable/',
      () =>
        json({
          formats: [
            {
              type: 'abook',
              chapters: [
                { number: 1, title: 'Kapitel 1', durationInMilliseconds: 600000 },
                { number: 2, title: '', durationInMilliseconds: 900000 },
              ],
            },
          ],
        }),
    ],
  ];
}

let nextId = 100;
const cfg = (over = {}) => ({
  id: nextId++,
  name: 'Storytel',
  baseUrl: 'https://www.storytel.com',
  credential: 'hunter2-lösen',
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: { email: 'me@example.com', store: 'STHP-SE', languages: 'sv', maxGrabsPerDay: 10, minSecondsBetweenGrabs: 1, ...over },
});
const query = (over = {}) => ({ title: 'Mördare utan ansikte (Unabridged)', author: 'Henning Mankell', isbn13: null, isbn13s: [], mediaKind: 'audiobook', language: 'sv', limit: 30, ...over });
const release = { guid: '10392381', title: 'Mördare utan ansikte - Henning Mankell', bookTitle: 'Mördare utan ansikte', sizeBytes: null, seeders: null, leechers: null };
const signal = () => AbortSignal.timeout(5000);

console.log('declaration');
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('carries audiobooks only', JSON.stringify(plugin.mediaKinds) === '["audiobook"]');
ok('serves files rather than torrents', typeof plugin.resolveFile === 'function' && plugin.fetchTorrentFile === undefined);
ok('needs an account', plugin.requiresCredential === true && plugin.credentialKind === 'apiKey');
ok('has a valid type slug', /^[a-z0-9][a-z0-9-]{0,29}$/.test(plugin.type));

console.log('search');
{
  const host = makeHost([['/search/client', () => json(SEARCH)]]);
  const found = await plugin.search(query(), cfg(), host, signal());
  const url = new URL(host.reqs[0].url);
  ok('asks the catalogue once for one page', host.reqs.length === 1);
  ok('strips edition qualifiers and appends the author', url.searchParams.get('query') === 'Mördare utan ansikte Henning Mankell', url.searchParams.get('query'));
  ok('names the store and the requested language', url.searchParams.get('store') === 'STHP-SE' && url.searchParams.get('includeLanguages') === 'sv');
  ok('never sends the account', !JSON.stringify(host.reqs[0].init).toLowerCase().includes('authorization'));
  ok('maps the real result', found.length === 1 && found[0].guid === '10392381' && found[0].bookTitle === 'Mördare utan ansikte', found);
  ok('states author, language and duration', found[0].author === 'Henning Mankell' && found[0].language === 'sv' && found[0].audio.durationSeconds === 32858);
  ok('decorates the title with series and narrator', found[0].title.includes('Wallander 1') && found[0].title.includes('Stefan Sauk'), found[0].title);
}
{
  const host = makeHost([['/search/client', (url) => json(new URL(url).searchParams.get('query') === '9789113139890' ? { items: [] } : SEARCH)]]);
  const found = await plugin.search(query({ isbn13: '9789113139890' }), cfg(), host, signal());
  ok('falls back to the title when the ISBN finds nothing', host.reqs.length === 2 && found.length === 1);
}
{
  const unreleased = JSON.parse(SEARCH);
  unreleased.items[0].formats = unreleased.items[0].formats.map((f) => (f.type === 'abook' ? { ...f, isReleased: false } : f));
  const found = await plugin.search(query(), cfg(), makeHost([['/search/client', () => json(unreleased)]]), signal());
  ok('drops a book whose audiobook is not released', found.length === 0);
}
{
  const host = makeHost([['/search/client', () => json(SEARCH)]]);
  await plugin.search(query({ language: null }), cfg({ languages: 'sv,en' }), host, signal());
  ok('falls back to the configured languages', new URL(host.reqs[0].url).searchParams.get('includeLanguages') === 'sv,en');
}

console.log('resolveFile');
{
  const host = makeHost(accountRoutes());
  const file = await plugin.resolveFile(release, cfg(), host, signal());
  const login = host.reqs.find((r) => r.url.includes('/api/login.action'));
  const shelfWrites = host.reqs.filter((r) => r.url.includes('/libraries/bookshelf'));
  ok('logs in with the password encrypted, in the body', login.init.body.includes('pwd=b29c84c70f53e485b5ea3a1b4a7ea5ec') && !login.url.includes('hunter2'), login.init.body);
  ok('reads the shelf, then adds the missing book', shelfWrites.length === 2 && JSON.parse(shelfWrites[1].init.body).items['10392381'].action === 'SET');
  ok('returns the signed link, named after its path when the CDN says nothing', file.url === SIGNED && file.fileName === 'Mördare utan ansikte.mp3' && file.format === 'mp3', file);
  ok('describes the book for assembly', file.audiobook.seriesName === 'Wallander' && file.audiobook.seriesIndex === 1 && file.audiobook.narrators[0] === 'Stefan Sauk');
  ok('carries publisher, date, language and cover', file.audiobook.publisher === 'Norstedts' && file.audiobook.publishedDate === '2025-01-24' && file.audiobook.language === 'sv' && file.audiobook.coverUrl.startsWith('https://covers.storytel.com/'));
  ok('lays chapters end to end', JSON.stringify(file.audiobook.chapters) === JSON.stringify([{ title: 'Kapitel 1', startMs: 0 }, { title: 'Chapter 2', startMs: 600000 }]), file.audiobook.chapters);
}
{
  const cdn = (_url, init) =>
    new Response('ab', { status: 206, headers: { 'content-type': 'audio/mp4;codecs=mp4a.40.2', 'content-range': 'bytes 0-1/492823922' } });
  const host = makeHost(accountRoutes({ cdn }));
  const file = await plugin.resolveFile(release, cfg(), host, signal());
  const probe = host.reqs.find((r) => r.url === SIGNED);
  ok('names AAC as m4a and states the size, from a two-byte probe', file.format === 'm4a' && file.fileName.endsWith('.m4a') && file.sizeBytes === 492823922, file);
  ok('probes the CDN without the account', probe.init.headers.Range === 'bytes=0-1' && !('Authorization' in probe.init.headers));
}
{
  const host = makeHost(accountRoutes({ bookshelf: () => json({ resourceVersion: 'rv', items: { 10392381: { action: 'SET', model: { state: 'CONSUMING' } } } }) }));
  await plugin.resolveFile(release, cfg(), host, signal());
  ok('leaves a book already on the shelf alone', host.reqs.filter((r) => r.url.includes('/libraries/bookshelf')).length === 1);
}
{
  const config = cfg({ maxGrabsPerDay: 1 });
  const host = makeHost(accountRoutes());
  await plugin.resolveFile(release, config, host, signal());
  const before = host.reqs.length;
  const refused = await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  ok('refuses past the daily cap without contacting Storytel', refused.failure === 'throttled' && host.reqs.length === before, refused.message);
}
{
  const config = cfg({ minSecondsBetweenGrabs: 3600 });
  const host = makeHost(accountRoutes());
  await plugin.resolveFile(release, config, host, signal());
  const refused = await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  ok('spaces grabs out', refused.failure === 'throttled' && /wait/.test(refused.message), refused.message);
}
{
  const config = cfg();
  const host = makeHost(accountRoutes());
  await plugin.resolveFile(release, config, host, signal());
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await plugin.resolveFile(release, config, host, signal());
  ok('reuses the session across grabs', host.reqs.filter((r) => r.url.includes('/api/login.action')).length === 1);
}
{
  let calls = 0;
  const host = makeHost(accountRoutes({ url: () => (calls++ === 0 ? json({}, 401) : json({ result: { signedUrl: SIGNED } })) }));
  const file = await plugin.resolveFile(release, cfg(), host, signal());
  ok('logs in again once when the session expires', file.url === SIGNED && host.reqs.filter((r) => r.url.includes('/api/login.action')).length === 2);
}
{
  const config = cfg();
  const blocked = () => new Response('<title>Attention Required! | Cloudflare</title>', { status: 403 });
  const host = makeHost(accountRoutes({ login: blocked }));
  const first = await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  const count = host.reqs.length;
  const second = await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  ok('backs off after a Cloudflare block', first.failure === 'throttled' && second.failure === 'throttled' && host.reqs.length === count, [first.message, second.message]);
}
{
  const config = cfg();
  const host = makeHost(accountRoutes({ login: () => json({ message: 'wrong' }) }));
  const first = await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  const logins = host.reqs.filter((r) => r.url.includes('/api/login.action')).length;
  await plugin.resolveFile(release, config, host, signal()).catch((e) => e);
  ok('does not retry a rejected password', first.failure === 'unauthorized' && host.reqs.filter((r) => r.url.includes('/api/login.action')).length === logins);
}
{
  const host = makeHost(accountRoutes({ url: () => json({}, 500) }));
  host.fetch = ((inner) => async (url, init = {}) => {
    if (url.endsWith('/abook')) {
      host.reqs.push({ url, init });
      return new Response(null, { status: 302, headers: { location: SIGNED } });
    }
    return inner(url, init);
  })(host.fetch);
  const file = await plugin.resolveFile(release, cfg(), host, signal());
  const legacy = host.reqs.find((r) => r.url.endsWith('/abook'));
  ok('falls back to the redirecting endpoint', file.url === SIGNED && legacy.init.redirect === 'manual');
}
{
  const refused = await plugin.resolveFile(release, cfg({ email: '' }), makeHost([]), signal()).catch((e) => e);
  ok('refuses without an e-mail', refused.failure === 'unauthorized');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
