/**
 * Storytel as a BookOrbit indexer plugin.
 *
 * Audiobooks only, from the subscription of the account configured here. Search runs against
 * Storytel's public catalogue and never touches the account; the account is used only when a
 * release is grabbed, to put the book on the bookshelf (Storytel refuses the audio otherwise), to
 * read the chapter list and to get a signed link to the audio file.
 *
 * The file is a single MP3 or AAC stream with no chapters in it. Turning it into an m4b with
 * chapters, series, narrators and cover is done by BookOrbit after the download, from the details
 * this plugin attaches to the resolved file; that needs the `audiobook-assembly` patch, without
 * which the details are ignored and the bare file is imported.
 *
 * Careful with the account. Storytel invalidates every session and emails the owner about
 * suspicious activity when its audio endpoint is hit too often, and Cloudflare blocks clients that
 * look automated. So: one login reused for as long as Storytel accepts it, grabs serialized and
 * capped per day, a cooldown after any block or rejected login rather than a retry, and nothing at
 * all sent to the account outside a grab.
 *
 * Dependency free and single file, like every BookOrbit plugin: it runs inside the BookOrbit
 * process, so it has to be something a person can read start to finish before trusting it.
 */

import { createCipheriv, randomUUID } from 'node:crypto';

const API = 'https://api.storytel.net';
const LOGIN_URL = 'https://www.storytel.com/api/login.action';

/**
 * Storytel's login expects the password AES-128-CBC encrypted with a key and IV baked into its
 * apps. Public knowledge since storytel-tui; every third-party client uses the same pair.
 */
const PASSWORD_KEY = Buffer.from('VQZBJ6TD8M9WBUWT', 'latin1');
const PASSWORD_IV = Buffer.from('joiwef08u23j341a', 'latin1');

/**
 * The Android app's agent and version. Storytel's login answers other agents with a Cloudflare
 * challenge often enough that audiobook-dl settled on this one, and it has held since 2024.
 */
const APP_VERSION = '24.22';
const USER_AGENT = `Storytel/${APP_VERSION} (Android 14; Google Pixel 8 Pro) Release/2288629`;

const ACCEPT_SEARCH = 'application/vnd.storytel.search-v10+json';
const ACCEPT_DETAILS = 'application/vnd.storytel.bookdetails-v5+json';
const ACCEPT_LIBRARY = 'application/vnd.storytel.library-delta+json;v=1.4';
/** Offering AAC first is what gets an m4a where Storytel has one, which assembles without a transcode. */
const MEDIA_ACCEPT = 'audio/mp4;codecs=mp4a.40.2,audio/mpeg';
/** A resource version the bookshelf endpoint accepts from a client that has never synced. */
const EMPTY_RESOURCE_VERSION = 'AAUAAAaaaaaaaaaaaaaAAAAaaaaaaaAaAAaAAAaaaaaaaaAAAAaaaaaaAAAAAAaaaaa=';

/** Ten per page; two pages is plenty for one request and still only two anonymous calls. */
const MAX_SEARCH_PAGES = 2;
const DEFAULT_STORE = 'STHP-SE';
const DEFAULT_LANGUAGES = 'sv';
const DEFAULT_MAX_GRABS_PER_DAY = 10;
const DEFAULT_MIN_SECONDS_BETWEEN_GRABS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long Storytel is left alone after Cloudflare blocks us or the session endpoint objects. */
const BLOCK_COOLDOWN_MS = 60 * 60 * 1000;
/** How long a rejected password is left alone, so a typo cannot hammer the login into a lockout. */
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000;

/** Per indexer row: the live session, the grab history and any cooldown. In memory on purpose. */
const accounts = new Map();

function account(config) {
  let state = accounts.get(config.id);
  const email = String(config.settings?.email ?? '').trim();
  if (!state || state.email !== email || state.password !== config.credential) {
    state = { email, password: config.credential, jwt: null, grabs: [], cooldownUntil: 0, cooldownReason: '', queue: Promise.resolve() };
    accounts.set(config.id, state);
  }
  return state;
}

export default {
  apiVersion: 1,
  version: '0.1.0',
  type: 'storytel',
  label: 'Storytel',
  requiresCredential: true,
  credentialKind: 'apiKey',
  mediaKinds: ['audiobook'],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://www.storytel.com',
  baseUrlHint: 'Not used for anything; leave it as it is. Put your Storytel password in the API key field.',
  settingsFields: [
    { key: 'email', type: 'string', label: 'Storytel e-mail', hint: 'The account to download with. Its password goes in the API key field.' },
    {
      key: 'store',
      type: 'string',
      label: 'Storytel store',
      hint: 'The market your subscription belongs to, e.g. STHP-SE, STHP-NO, STHP-DK, STHP-FI, STHP-NL, STHP-DE.',
      default: DEFAULT_STORE,
    },
    {
      key: 'languages',
      type: 'string',
      label: 'Languages to search',
      hint: 'Two-letter codes, used when a request does not name a language.',
      format: 'list',
      default: DEFAULT_LANGUAGES,
    },
    {
      key: 'maxGrabsPerDay',
      type: 'number',
      label: 'Downloads per 24 hours',
      hint: 'Storytel locks the account after too many audio requests. Further grabs are refused until the window clears.',
      default: DEFAULT_MAX_GRABS_PER_DAY,
    },
    {
      key: 'minSecondsBetweenGrabs',
      type: 'number',
      label: 'Seconds between downloads',
      default: DEFAULT_MIN_SECONDS_BETWEEN_GRABS,
    },
  ],

  async search(query, config, host, signal) {
    const store = storeOf(config);
    const languages = query.language ? [query.language] : listSetting(config.settings?.languages, DEFAULT_LANGUAGES);
    const limit = Math.max(1, Math.min(query.limit, 10 * MAX_SEARCH_PAGES));

    let items = [];
    if (query.isbn13) items = await searchCatalogue(host, store, query.isbn13, languages, limit, signal);
    if (items.length === 0) {
      const text = [stripEdition(query.title), query.author].filter(Boolean).join(' ');
      items = await searchCatalogue(host, store, text, languages, limit, signal);
    }

    const releases = [];
    for (const item of items) {
      const release = toRelease(item);
      if (release) releases.push(release);
    }
    return releases;
  },

  async test(config, host) {
    try {
      const state = account(config);
      requireAccount(config, host, state);
      state.jwt = null;
      await login(config, host, state);
      return { success: true, indexerName: `Storytel (${state.email})` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Serialized per account: two approvals at once would otherwise be two near-simultaneous audio
   * requests, the pattern Storytel's rate limit watches for.
   */
  async resolveFile(release, config, host) {
    const state = account(config);
    const run = state.queue.then(() =>
      resolveOne(release, config, host, state).catch((error) => {
        if (error?.storytelBlocked || error?.storytelStatus === 429) {
          state.cooldownUntil = Date.now() + BLOCK_COOLDOWN_MS;
          state.cooldownReason = 'Storytel blocked or rate limited the last request.';
          state.jwt = null;
        }
        throw error;
      }),
    );
    state.queue = run.catch(() => undefined);
    return run;
  },
};

async function resolveOne(release, config, host, state) {
  requireAccount(config, host, state);
  const consumableId = String(release.guid ?? '').trim();
  if (!/^\d+$/.test(consumableId)) throw host.fail('error', `"${release.title}" carries no Storytel id`);

  const now = Date.now();
  if (state.cooldownUntil > now) {
    throw host.fail('throttled', `${state.cooldownReason} Waiting until ${new Date(state.cooldownUntil).toISOString()} before contacting Storytel again.`);
  }
  state.grabs = state.grabs.filter((at) => at > now - DAY_MS);
  const maxPerDay = positiveSetting(config.settings?.maxGrabsPerDay, DEFAULT_MAX_GRABS_PER_DAY);
  if (state.grabs.length >= maxPerDay) {
    const freeAt = new Date(state.grabs[0] + DAY_MS).toISOString();
    throw host.fail('throttled', `the limit of ${maxPerDay} downloads per 24 hours is reached; the next one is allowed after ${freeAt}`);
  }
  const gapMs = positiveSetting(config.settings?.minSecondsBetweenGrabs, DEFAULT_MIN_SECONDS_BETWEEN_GRABS) * 1000;
  const last = state.grabs[state.grabs.length - 1];
  if (last !== undefined && now - last < gapMs) {
    throw host.fail('throttled', `the last download was ${Math.round((now - last) / 1000)}s ago; wait ${Math.ceil((gapMs - (now - last)) / 1000)}s more`);
  }

  const details = await getJson(host, `${API}/book-details/consumables/${consumableId}?kidsMode=false&configVariant=default&store=${encodeURIComponent(storeOf(config))}`, {
    Accept: ACCEPT_DETAILS,
  });
  const abook = audiobookFormat(details?.formats);
  if (!abook) throw host.fail('error', `"${release.title}" has no released audiobook on Storytel`);

  await authorized(config, host, state, (jwt) => ensureOnBookshelf(host, jwt, consumableId));
  // Counted from here: the audio request is the one Storytel rate limits.
  state.grabs.push(Date.now());
  const signedUrl = await authorized(config, host, state, (jwt) => signedAudioUrl(host, jwt, consumableId));
  const chapters = await authorized(config, host, state, (jwt) => chapterList(host, jwt, consumableId)).catch((error) => {
    host.logger.warn(`chapters for ${consumableId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });

  const title = text(details.title) ?? release.bookTitle ?? release.title;
  const { extension, sizeBytes } = await probeAudio(host, signedUrl);
  host.logger.log(`resolved ${consumableId} as ${extension} with ${chapters.length} chapters`);

  return {
    url: signedUrl,
    fileName: `${sanitizeName(title)}.${extension}`,
    sizeBytes,
    format: extension,
    audiobook: {
      title,
      authors: people(details.authors),
      narrators: people(details.narrators),
      seriesName: text(details.seriesInfo?.name) ?? undefined,
      seriesIndex: details.seriesInfo?.orderInSeries ?? undefined,
      publisher: text(abook.publisher?.name) ?? undefined,
      publishedDate: dateOnly(abook.releaseDate),
      description: text(details.description) ?? undefined,
      genres: text(details.category?.name) ? [details.category.name] : [],
      language: text(details.language) ?? undefined,
      chapters,
      coverUrl: text(details.cover?.url) ?? undefined,
    },
  };
}

async function searchCatalogue(host, store, text, languages, limit, signal) {
  const items = [];
  let page = '';
  for (let pageCount = 0; pageCount < MAX_SEARCH_PAGES && items.length < limit; pageCount++) {
    if (signal.aborted) break;
    const params = new URLSearchParams({
      configVariant: 'baseline',
      searchFor: 'books',
      includeFormats: 'abook',
      kidsMode: 'false',
      query: text,
      v2: 'true',
      store,
    });
    if (languages.length > 0) params.set('includeLanguages', languages.join(','));
    if (page) params.set('page', page);

    const body = await getJson(host, `${API}/search/client?${params}`, { Accept: ACCEPT_SEARCH });
    items.push(...(Array.isArray(body?.items) ? body.items : []));

    page = body?.nextPageToken ? String(body.nextPageToken) : '';
    if (!page || Number(page) >= Number(body?.totalCount ?? 0)) break;
  }
  return items.slice(0, limit);
}

function toRelease(item) {
  if (item?.resultType !== 'book') return null;
  const id = item.id === undefined || item.id === null ? '' : String(item.id).trim();
  const title = text(item.title);
  const abook = audiobookFormat(item.formats);
  if (!/^\d+$/.test(id) || !title || !abook) return null;

  const authors = people(item.authors);
  const narrators = people(item.narrators);
  const series = text(item.seriesInfo?.name);
  const position = item.seriesInfo?.orderInSeries;
  const durationSeconds = durationOf(item.duration);

  const decorations = [
    series ? `${series}${position ? ` ${position}` : ''}` : null,
    narrators.length > 0 ? `read by ${narrators.slice(0, 2).join(', ')}` : null,
    item.language ? String(item.language) : null,
  ].filter(Boolean);
  const byline = authors.length > 0 ? ` - ${authors.join(', ')}` : '';

  return {
    guid: id,
    title: `${title}${byline}${decorations.length > 0 ? ` (${decorations.join(', ')})` : ''}`,
    bookTitle: title,
    author: authors[0],
    language: text(item.language) ?? undefined,
    // What lands in the library once the audiobook-assembly patch has built it, not what Storytel sends.
    format: 'm4b',
    sizeBytes: null,
    seeders: null,
    leechers: null,
    publishedAt: text(abook.releaseDate) ?? undefined,
    audio: { bitrateKbps: null, bitrateMode: null, channels: null, samplingRateHz: null, durationSeconds, chapterCount: null },
    primaryFileCount: 1,
  };
}

/**
 * The session is reused until Storytel rejects it; only then is it replaced, once. A second
 * rejection is not retried, because a login loop is exactly what gets an account flagged.
 */
async function authorized(config, host, state, call) {
  if (!state.jwt) await login(config, host, state);
  try {
    return await call(state.jwt);
  } catch (error) {
    if (error?.storytelStatus !== 401) throw error;
    state.jwt = null;
    await login(config, host, state);
    return call(state.jwt);
  }
}

async function login(config, host, state) {
  const params = new URLSearchParams({
    m: '1',
    token: 'guestsv',
    userid: '-1',
    version: APP_VERSION,
    terminal: 'android',
    locale: 'sv',
    // Fresh per login: a fixed id was what Cloudflare started blocking in January 2025.
    deviceId: randomUUID(),
    kidsMode: 'false',
  });
  const body = new URLSearchParams({ uid: state.email, pwd: encryptPassword(state.password) }).toString();

  const response = await send(host, `${LOGIN_URL}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    body,
  });
  if (await isCloudflare(response)) cooldown(host, state, BLOCK_COOLDOWN_MS, 'Cloudflare blocked the Storytel login.', 'throttled');
  if (!response.ok) {
    cooldown(host, state, LOGIN_COOLDOWN_MS, `Storytel refused the login (${response.status}). Check the e-mail and password.`, 'unauthorized');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw host.fail('error', 'Storytel answered the login with something that is not JSON');
  }
  const jwt = payload?.accountInfo?.jwt;
  if (typeof jwt !== 'string' || jwt.length === 0) {
    cooldown(host, state, LOGIN_COOLDOWN_MS, 'Storytel refused the login. Check the e-mail and password.', 'unauthorized');
  }
  state.jwt = jwt;
}

/**
 * Storytel will not hand out the audio for a book that is not on the account's bookshelf. The
 * shelf is read first and the book only added when missing, so a book already being listened to
 * keeps its state instead of being reset to "want to read". The write's answer is checked rather
 * than trusted: the endpoint replies 200 even to a write it ignored.
 */
async function ensureOnBookshelf(host, jwt, consumableId) {
  const shelf = await bookshelf(host, jwt, {});
  if (onShelf(shelf, consumableId)) return;

  const write = await bookshelf(host, jwt, {
    resourceVersion: typeof shelf?.resourceVersion === 'string' && shelf.resourceVersion ? shelf.resourceVersion : EMPTY_RESOURCE_VERSION,
    followingItems: {},
    items: { [consumableId]: { action: 'SET', state: 'WILL_CONSUME', millisecondsSinceEvent: 10 } },
  });
  const entry = write?.items?.[consumableId];
  if (entry?.action === 'SET' || onShelf(write, consumableId)) {
    host.logger.log(`added ${consumableId} to the Storytel bookshelf`);
    return;
  }
  throw host.fail('error', 'Storytel did not accept the book onto the bookshelf, so it will not serve the audio');
}

async function bookshelf(host, jwt, payload) {
  return requestJson(host, `${API}/libraries/bookshelf`, {
    method: 'POST',
    headers: { Accept: ACCEPT_LIBRARY, 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
  });
}

function onShelf(shelf, consumableId) {
  const entry = shelf?.items?.[consumableId];
  return Boolean(entry && entry.action !== 'DELETE' && (entry.model?.state ?? entry.state));
}

/**
 * The newer endpoint answers JSON with a signed URL and honours the format preference; the older
 * one only redirects to an MP3. The older one is the fallback, since it is what audiobook-dl has
 * relied on for years.
 */
async function signedAudioUrl(host, jwt, consumableId) {
  const headers = { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT, 'storytel-media-accept': MEDIA_ACCEPT, Accept: 'application/json' };
  try {
    const body = await requestJson(host, `${API}/assets/v2/consumables/${consumableId}/url`, { headers });
    const url = body?.result?.signedUrl;
    if (typeof url === 'string' && url.startsWith('https://')) return url;
  } catch (error) {
    if (error?.storytelStatus === 401 || error?.storytelStatus === 429 || error?.storytelBlocked) throw error;
  }

  const response = await send(host, `${API}/assets/v2/consumables/${consumableId}/abook`, { headers, redirect: 'manual' });
  await refuseOnFailure(host, response);
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location?.startsWith('https://')) return location;
  throw host.fail('error', `Storytel answered ${response.status} without a link to the audio`);
}

async function chapterList(host, jwt, consumableId) {
  const body = await requestJson(host, `${API}/playback-metadata/consumable/${consumableId}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const raw = audiobookFormat(body?.formats, { requireReleased: false })?.chapters;
  if (!Array.isArray(raw)) return [];

  const chapters = [];
  let startMs = 0;
  for (const [index, chapter] of raw.entries()) {
    const durationMs = Number(chapter?.durationInMilliseconds ?? Number(chapter?.durationInSeconds) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) break;
    chapters.push({ title: text(chapter?.title) ?? `Chapter ${chapter?.number ?? index + 1}`, startMs });
    startMs += durationMs;
  }
  return chapters;
}

async function getJson(host, url, headers) {
  return requestJson(host, url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
}

async function requestJson(host, url, init) {
  const response = await send(host, url, init);
  await refuseOnFailure(host, response);
  try {
    return await response.json();
  } catch {
    throw host.fail('error', 'Storytel answered with something that is not JSON');
  }
}

async function send(host, url, init) {
  try {
    return await host.fetch(url, init);
  } catch (error) {
    if (error && typeof error === 'object' && 'failure' in error) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw host.fail('timeout', 'Storytel did not answer in time');
    throw host.fail('unreachable', `Storytel could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function refuseOnFailure(host, response) {
  if (response.ok || (response.status >= 300 && response.status < 400)) return;
  if (await isCloudflare(response)) {
    throw Object.assign(host.fail('throttled', 'Cloudflare is blocking requests to Storytel'), { storytelBlocked: true });
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(host.fail('unauthorized', `Storytel refused the request (${response.status})`), { storytelStatus: 401 });
  }
  if (response.status === 404) throw host.fail('error', 'Storytel does not have that book in this store');
  if (response.status === 429) throw Object.assign(host.fail('throttled', 'Storytel is rate limiting us'), { storytelStatus: 429 });
  throw host.fail('error', `Storytel answered ${response.status}`);
}

async function isCloudflare(response) {
  if (response.status !== 403 && response.status !== 503) return false;
  const body = await response
    .clone()
    .text()
    .catch(() => '');
  return /Attention Required|cloudflare/i.test(body);
}

function cooldown(host, state, ms, reason, failure) {
  state.cooldownUntil = Date.now() + ms;
  state.cooldownReason = reason;
  state.jwt = null;
  throw host.fail(failure, reason);
}

function requireAccount(config, host, state) {
  if (!state.email || !config.credential) {
    throw host.fail('unauthorized', 'Storytel needs the account e-mail in its settings and the password in the API key field');
  }
}

function encryptPassword(password) {
  const cipher = createCipheriv('aes-128-cbc', PASSWORD_KEY, PASSWORD_IV);
  return Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]).toString('hex');
}

function audiobookFormat(formats, { requireReleased = true } = {}) {
  if (!Array.isArray(formats)) return null;
  const abook = formats.find((format) => format?.type === 'abook');
  if (!abook) return null;
  if (requireReleased && (abook.isReleased === false || abook.isLockedContent === true)) return null;
  return abook;
}

function people(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((person) => text(person?.name)).filter(Boolean))];
}

function durationOf(duration) {
  if (!duration || typeof duration !== 'object') return null;
  const seconds = Number(duration.hours ?? 0) * 3600 + Number(duration.minutes ?? 0) * 60 + Number(duration.seconds ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The signed link names no format, and with AAC offered first Storytel usually sends an m4a, so the
 * CDN is asked for two bytes. It goes to the CDN, not the rate-limited API, and costs nothing if it
 * fails: the link's own path is the fallback.
 */
async function probeAudio(host, url) {
  try {
    const response = await host.fetch(url, { headers: { Range: 'bytes=0-1', 'User-Agent': USER_AGENT } });
    void response.body?.cancel().catch(() => undefined);
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
    const extension = type.startsWith('audio/mp4') || type.startsWith('audio/aac') ? 'm4a' : type.startsWith('audio/mpeg') ? 'mp3' : audioExtension(url);
    return { extension, sizeBytes: Number.isSafeInteger(total) && total > 0 ? total : null };
  } catch {
    return { extension: audioExtension(url), sizeBytes: null };
  }
}

function audioExtension(url) {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'mp3';
  }
  if (path.endsWith('.m4a') || path.endsWith('.mp4') || path.endsWith('.aac')) return 'm4a';
  return 'mp3';
}

function dateOnly(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(typeof value === 'string' ? value : '');
  return match ? match[1] : undefined;
}

/** A metadata provider routinely appends "(Unabridged)" and the like, which no Storytel title carries. */
function stripEdition(title) {
  const stripped = String(title ?? '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || String(title ?? '').trim();
}

function storeOf(config) {
  const store = String(config.settings?.store ?? '').trim().toUpperCase();
  return /^[A-Z0-9-]{2,20}$/.test(store) ? store : DEFAULT_STORE;
}

function listSetting(value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value : fallback;
  return raw
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter((code) => /^[a-z]{2}$/.test(code));
}

function positiveSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** The title reaches a filesystem path, so it is reduced to something a filename can hold. */
function sanitizeName(title) {
  return (
    String(title)
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'audiobook'
  );
}
