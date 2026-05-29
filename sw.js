/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-18-14-z9: ★ フィルタトグル視覚化 (チップ型 + ✓マーク + 紺地選択中表示)
 * v3-18-14-z8: フィルタバー改修 (残2日/残4日削除 + 追跡スキャン待ち追加)
 * v3-18-14-z7: 追跡番号アップロード機能追加 (tracking_scan.js, tracking_scan.css)
 * v3-18-14-z6: Declaration ID 形式緩和 (zonos.js 更新)
 * v3-18-14-z5: 商品画像→写真ライブラリ保存機能
 * v3-18-14-z4: appsscript_tracking_sync.gs 更新反映
 * v3-18-14-z3: 新policy Economy Shipping from outside US 対応
 * v3-18-14-z2: 商品画像保存改善
 * v3-18-14-z1: Zonos PrePay 連携追加
 * (以前の v3-17-7 までのバージョン履歴は省略)
 */
const CACHE_NAME = 'ebay-ship-v3-18-14-z9';

const STATIC_FILES = [
  './',
  './index.html',
  './style.css',
  './zonos.css',
  './tracking_scan.css',
  './app.js',
  './api.js',
  './calculator.js',
  './ocr.js',
  './zonos.js',
  './tracking_scan.js',
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

  // eBay画像CDN: SWで一切触らない
  if (url.hostname.indexOf('ebay') !== -1 || url.hostname.indexOf('ebaystatic') !== -1) {
    return;
  }

  // Apps Script API は SW で一切触らない
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('keepa.com')) {
    return;
  }

  // CDN はネットワーク優先
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(r => r || new Response('', { status: 503, statusText: 'Offline' }))
      )
    );
    return;
  }

  // 静的ファイルはキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    )
  );
});
