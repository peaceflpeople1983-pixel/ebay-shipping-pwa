/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * バージョンを変更すると古いキャッシュが破棄され、強制的に最新のJS/CSSを取得する
 */
const CACHE_NAME = 'ebay-ship-v1';
const STATIC_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './api.js',
  './calculator.js',
  './ocr.js',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Apps Script API・tesseract.jsはネットワーク優先
  if (url.hostname.includes('script.google.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // 静的ファイルはキャッシュ優先
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
