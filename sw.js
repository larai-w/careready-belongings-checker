// sw.js — オフライン対応 Service Worker
// 方針: アプリシェルはインストール時にプリキャッシュ。
// 以降のGETリクエストは「キャッシュ優先 + 裏でネットワーク更新」(stale-while-revalidate)。

const CACHE_NAME = 'careready-v8';

const PRECACHE_URLS = [
    './',
    './index.html',
    './app.js',
    './storage.js',
    './data.json',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetched = fetch(event.request)
                .then((response) => {
                    // 正常応答(またはCDN等のopaque応答)はキャッシュを更新する
                    if (response && (response.ok || response.type === 'opaque')) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || fetched;
        })
    );
});
