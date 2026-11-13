// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/*
 * slogicweb service worker: the offline shell for the hosted build (docs/ARCHITECTURE.md
 * section 7.2). Hand-written on purpose - no workbox; the whole policy fits on a page.
 *
 * The build (src/pwa/shell.mjs, run from vite.config.ts) replaces the SHELL token
 * below with the list it enumerated from dist/. A template whose token was never
 * replaced throws at evaluation, so an unbuilt copy can never install.
 *
 * Policy:
 * - Only first-party, same-origin GETs are ever answered or stored. Cross-origin requests
 *   (there should be none) and non-GET requests go to the network untouched.
 * - Shell (precache, installed eagerly): index.html, the worker and lazy JS chunks, the
 *   locale catalogs, the decoder detail chunk, favicon, icons and the web manifest. Stored
 *   in `<prefix>shell-<version>`; activation deletes every other shell version of this
 *   scope, so at most one shell is kept (two while an update waits).
 * - index.html is cache-first: a reload serves the copy that belongs to the active shell,
 *   so F5 is fast and works offline. The page checks for a new worker immediately after
 *   registration; a new worker precaches a new index and waits for the user's Update
 *   click, never swapping a running capture. A network copy is NEVER written to the
 *   cache - it may refer to chunk names the current shell does not hold.
 * - Every other shell file has a content-hashed name (or is tiny and versioned by the
 *   shell), so it is cache-first.
 * - Runtime (Pyodide directory + decoders zip, ~14 MB, content-hashed): stored in the
 *   name-stable `<prefix>runtime` cache and answered cache-first; activation prunes entries
 *   the current build no longer names, so an unchanged runtime survives shell updates and
 *   a changed one replaces the old copy. It is cached **on first use**, never during
 *   install: a 14 MB fill must not keep the install event pending (Chrome marks a slow
 *   install redundant, which leaves the page uncontrolled and makes F5 hit the network).
 *   The decode worker's boot warm-up is the first user, so the next F5/offline start hits
 *   the cache.
 * - No skipWaiting on install. A new version waits until the page asks (the update notice
 *   in src/ui/pwaUpdate.ts posts SKIP_WAITING after the user clicks), so a running capture
 *   is never swapped to a different shell underneath the user.
 */

const SHELL = __SLOGICWEB_SHELL__;

const VERSION = SHELL.version;
const SCOPE = self.registration.scope;
const PREFIX = `slogicweb:${SCOPE}:`;
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const RUNTIME_CACHE = `${PREFIX}runtime`;

const abs = (rel) => new URL(rel, SCOPE).href;
const INDEX_URL = abs(SHELL.index);
const SHELL_URLS = new Set([INDEX_URL, ...SHELL.hashed.map(abs), ...SHELL.plain.map(abs)]);
const RUNTIME_URLS = new Set(SHELL.runtime.map(abs));

/** A response that may be stored: complete, same-origin, not opaque or redirected. */
const storable = (response) =>
  response && response.ok && response.status === 200 && response.type === 'basic' && !response.redirected;

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  // index.html: bypass every HTTP cache (a CDN may still hold the previous deploy) and
  // prove the copy belongs to this version before storing it. A stale copy fails the
  // install; the browser retries on a later navigation.
  const index = await fetch(`${INDEX_URL}?sw=${VERSION}`, { cache: 'reload' });
  if (!storable(index)) throw new Error(`shell index fetch failed: ${index.status}`);
  const html = await index.clone().text();
  if (!html.includes(`<meta name="slogicweb-build" content="${VERSION}">`)) {
    throw new Error('shell index.html is not this build (stale CDN copy?)');
  }
  await cache.put(INDEX_URL, index);
  // Hashed files are immutable by name: reuse a copy any older shell already holds.
  await Promise.all(SHELL.hashed.map(async (rel) => {
    const url = abs(rel);
    const old = await caches.match(url);
    if (old) return cache.put(url, old);
    // Default cache mode: any HTTP-cached copy of an immutable name is the right bytes.
    return cache.add(url);
  }));
  await Promise.all(SHELL.plain.map((rel) => cache.add(new Request(abs(rel), { cache: 'reload' }))));
}

async function rotate() {
  for (const name of await caches.keys()) {
    // `logicweb:` is the pre-rename (before 0.1.0) prefix: nothing reads those caches now.
    const legacy = name.startsWith('logicweb:');
    if (legacy || (name.startsWith(PREFIX) && name !== SHELL_CACHE && name !== RUNTIME_CACHE)) {
      await caches.delete(name);
    }
  }
  const runtime = await caches.open(RUNTIME_CACHE);
  for (const request of await runtime.keys()) {
    if (!RUNTIME_URLS.has(request.url)) await runtime.delete(request);
  }
}

self.addEventListener('install', (event) => {
  // Only the shell is a precondition. Runtime bytes are cached by the fetch handler
  // on first use; awaiting 14 MB here can make a slow install redundant.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(rotate().then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function navigate(request) {
  // Cache-first is the whole point of the shell: F5 must paint the active version
  // immediately, not wait for (or adopt) a newer document while the old chunks are
  // still the ones in this shell. A new version arrives only through a new worker
  // and the explicit Update click.
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(INDEX_URL);
  if (cached) return cached;
  // First visit (nothing installed yet): there is no shell to serve.
  return fetch(request);
}

/** `key` is the URL without its query: the build names files, not queries. */
async function cacheFirst(request, key, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) await cache.put(key, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Range requests (media seeking) would need partial responses; nothing first-party
  // issues them, so they pass through.
  if (request.headers.has('range')) return;
  const bare = `${url.origin}${url.pathname}`;

  if (request.mode === 'navigate') {
    // Only the app document itself; LICENSE.txt and friends are plain navigations.
    if (bare === SCOPE || bare === INDEX_URL) event.respondWith(navigate(request));
    return;
  }
  if (SHELL_URLS.has(bare)) {
    event.respondWith(cacheFirst(request, bare, SHELL_CACHE));
  } else if (RUNTIME_URLS.has(bare)) {
    event.respondWith(cacheFirst(request, bare, RUNTIME_CACHE));
  }
});
