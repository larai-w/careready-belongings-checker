// sw.js — オフライン対応 Service Worker
// 方針: アプリシェルはインストール時にプリキャッシュ。
// 以降のGETリクエストは「キャッシュ優先 + 裏でネットワーク更新」(stale-while-revalidate)。

const CACHE_NAME = 'careready-v85';

const PRECACHE_URLS = [
    './',
    './index.html',
    './privacy.html',
    './app.js',
    './lib/ocr-match.js',
    './lib/share.js',
    './lib/backup.js',
    './lib/backup-ui.js',
    './lib/checklist.js',
    './storage.js',
    './data.json',
    './manifest.webmanifest',
    './icons/careready-logo.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
];

// The first page is not controlled yet, so its CDN request never reaches fetch below.
// Save the styling runtime during installation as well, for the first offline reload.
const STYLE_RUNTIME_URL = 'https://cdn.tailwindcss.com';
async function cacheStyleRuntime(cache) {
    const previous = await caches.match(STYLE_RUNTIME_URL);
    if (previous) await cache.put(STYLE_RUNTIME_URL, previous);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(new Request(STYLE_RUNTIME_URL, {
            mode: 'no-cors', credentials: 'omit', cache: 'reload', signal: controller.signal,
        }));
        if (response.ok || response.type === 'opaque') await cache.put(STYLE_RUNTIME_URL, response);
    } catch {
        // A CDN outage must not prevent the local application shell from installing.
        // An existing runtime is retained if available.
    } finally { clearTimeout(timer); }
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all([cache.addAll(PRECACHE_URLS), cacheStyleRuntime(cache)]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k.startsWith('careready-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ---------- Web Push(予定リマインド) ----------
// 予定日はサーバに送らない。サーバは「確認プッシュ」を送るだけで、
// 通知するかどうかは この SW が端末内の specialOutings を見て判断する。

function _idbGet(key) {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open('careready');
            req.onsuccess = () => {
                try {
                    const tx = req.result.transaction('kv', 'readonly');
                    const g = tx.objectStore('kv').get(key);
                    g.onsuccess = () => resolve(g.result);
                    g.onerror = () => resolve(undefined);
                } catch (e) {
                    resolve(undefined);
                }
            };
            req.onerror = () => resolve(undefined);
        } catch (e) {
            resolve(undefined);
        }
    });
}

const _PRESET_NAMES = { shortstay: 'ショートステイ', facility: '施設入所', roken: '老健入所', hospital: '入院' };

async function _maybeNotifyOuting() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let best = null;
    const consider = (name, dateStr) => {
        if (!name || !dateStr) return;
        const d = new Date(`${dateStr}T00:00:00`);
        if (isNaN(d)) return;
        const days = Math.round((d - today) / 86400000);
        if (days >= 0 && days <= 2 && (!best || days < best.days)) best = { name, days };
    };
    const outings = await _idbGet('specialOutings');
    if (Array.isArray(outings)) { for (const o of outings) { if (o) consider(o.name, o.date); } }
    const dates = await _idbGet('locationDates');
    if (dates && typeof dates === 'object') { for (const id of Object.keys(dates)) consider(_PRESET_NAMES[id] || id, dates[id]); }
    if (!best) return;
    const body = best.days === 0
        ? `${best.name} は きょうです。準備はできていますか？`
        : `${best.name} まで ${best.days === 1 ? 'あした' : `あと${best.days}日`}。準備をはじめませんか？`;
    await self.registration.showNotification('CareReady', {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'careready-outing',
    });
}

self.addEventListener('push', (event) => {
    event.waitUntil(_maybeNotifyOuting());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then((cs) => {
            for (const c of cs) {
                if ('focus' in c) return c.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow('./');
        })
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
