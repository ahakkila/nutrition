const CACHE_NAME = 'rooted-v4';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './version.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  const isRevisionCheck = requestUrl.pathname.endsWith('/version.json');
  event.respondWith(
    fetch(event.request, isRevisionCheck ? { cache: 'no-store' } : undefined).then((response) => {
      if (event.request.url.startsWith(self.location.origin) && !isRevisionCheck) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => isRevisionCheck
      ? caches.match(new URL('./version.json', self.registration.scope).toString())
      : caches.match(event.request))
  );
});
