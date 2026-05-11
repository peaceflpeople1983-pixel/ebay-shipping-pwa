/**
 * Service Worker - 静的ファイル & eBay商品画像のオフラインキャッシュ
 * バージョンを変更すると古いキャッシュが破棄され、強制的に最新のJS/CSSを取得する
 */
const STATIC_CACHE = 'ebay-ship-v3-2'; // バージョン更新で旧キャッシュ強制破棄
const IMAGE_CACHE = 'ebay-ship-images-v2'; // 画像キャッシュも刷新
const IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
 
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
 
// eBay商品画像CDNホスト
const EBAY_IMG_HOSTS = ['i.ebayimg.com', 'thumbs.ebaystatic.com', 'pics.ebaystatic.com'];
 
self.addEventListener('install', e => {
  e.waitUntil(caches.open(STATIC_CACHE).then(c => c.addAll(STATIC_FILES)));
  self.skipWaiting();
});
 
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(
      keys.filter(k => k !== STATIC_CACHE && k !== IMAGE_CACHE)
          .map(k => caches.delete(k))
    )
  ));
  self.clients.claim();
});
 
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
 
  // eBay商品画像：キャッシュ優先（30日TTL）
  if (EBAY_IMG_HOSTS.includes(url.hostname)) {
    e.respondWith(handleImageRequest(e.request));
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
 
async function handleImageRequest(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // TTL チェック
    const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
    if (cachedAt && (Date.now() - cachedAt) < IMAGE_TTL_MS) {
      return cached;
    }
  }
  try {
    const network = await fetch(request, { mode: 'no-cors' });
    // Response を複製してキャッシュ用ヘッダ付与
    const headers = new Headers(network.headers);
    headers.set('x-cached-at', String(Date.now()));
    const body = await network.clone().blob();
    const cacheable = new Response(body, {
      status: network.status,
      statusText: network.statusText,
      headers: headers
    });
    cache.put(request, cacheable).catch(() => {});
    return network;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
 
