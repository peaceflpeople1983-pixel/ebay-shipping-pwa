/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-18-15-z20: ★ Phase B 発送済(FULFILLED)/キャンセル済 表示 + 手動「発送済にする」(app.js/recovery.js 更新)
 * v3-18-15-z19: 注文取得リカバリ機能 (recovery.js/css) + ヘッダー縦積み是正
 * v3-18-15-z18: キャンセル済バッジ + フィルタ追加
 * v3-18-15-z17: DEFAULT_DAYS_BACK 15→60日
 */
const CACHE_NAME = 'ebay-ship-v3-18-15-z20';

const STATIC_FILES = [
  './',
  './index.html',
  './style.css',
  './zonos.css',
  './tracking_scan.css',
  './cancel_notice.css',
  './recovery.css',
  './app.js',
  './api.js',
  './calculator.js',
  './ocr.js',
  './zonos.js',
  './tracking_scan.js',
  './cancel_notice.js',
  './recovery.js',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.indexOf('ebay') !== -1 || url.hostname.indexOf('ebaystatic') !== -1) return;
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('keepa.com')) return;
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(r => r || new Response('', { status: 503, statusText: 'Offline' }))
      )
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    )
  );
});
