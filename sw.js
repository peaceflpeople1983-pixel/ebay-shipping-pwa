/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-9: ツールバーのボタン押下を touchstart 経由でも動かす（iOS click抑止対策）
 * 商品画像はブラウザ標準のHTTPキャッシュに任せる（iOS Safari互換性のため）
 */
const STATIC_CACHE = 'ebay-ship-v3-9';

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
  e.waitUntil(caches.open(STATIC_CACHE).then(c => c.addAll(STATIC_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // eBay画像CDN: SWで一切触らない（ブラウザ標準処理）
  if (url.hostname.indexOf('ebay') !== -1 || url.hostname.indexOf('ebaystatic') !== -1) {
    return;
  }

  // Apps Script API・CDNはネットワーク優先
  if (url.hostname.includes('script.google.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // 静的ファイルはキャッシュ優先
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
