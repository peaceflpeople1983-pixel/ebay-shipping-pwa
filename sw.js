/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-18-15-z16: ★ 2スリップ/A4ページ復活 + 全要素コンパクト化 (画像20mm, フォント圧縮)
 * v3-18-15-z15: 設計シンプル化 (1スリップ/A4ページ) → 仕様変更で却下
 * v3-18-15-z14: A4 1ページ固定化 (2スリップ縦並び + 高さ制約)
 * v3-18-15-z13: 印刷白紙バグ再修正 (動的CSS注入方式 + 診断ログ追加)
 * v3-18-15-z12: 印刷プレビュー白紙バグ修正 (ポータル方式に変更)
 * v3-18-15-z11: キャンセル通知機能追加
 */
const CACHE_NAME = 'ebay-ship-v3-18-15-z16';
 
const STATIC_FILES = [
  './',
  './index.html',
  './style.css',
  './zonos.css',
  './tracking_scan.css',
  './cancel_notice.css',
  './app.js',
  './api.js',
  './calculator.js',
  './ocr.js',
  './zonos.js',
  './tracking_scan.js',
  './cancel_notice.js',
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
 
  if (url.hostname.indexOf('ebay') !== -1 || url.hostname.indexOf('ebaystatic') !== -1) {
    return;
  }
 
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('keepa.com')) {
    return;
  }
 
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
