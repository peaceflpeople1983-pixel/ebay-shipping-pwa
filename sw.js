/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-3-2: ★ Non-Dangerous欄はASCIIのみ(Zonosが日本語を除去)→ NDGは「(CPaSS番号) no battery, no glue」。日本語はPWA表示専用。「Others」選択ヒント追加
 * v3-3-1: ★ Zonos修正: PCで画像をDL(Web Share回避) / 日本語訳はAmazon商品名から取得
 * v3-3-0: ★ Zonos PC受け渡し: web版を開く / 申告価格=Amazon仕入値(JPY) / Non-Dangerous Goods Reason(CPaSS番号+注記+日本語) / Made in=Japan / Description 30字メーター / 画像DL
 * v3-2-5: ★ Amazon仕入値: 設定画面に手動取得ボタン+メタ表示 / 自動19:00追加(7:00+19:00)
 * v3-2-2: ★ 「キャンセル済を隠す」で通知印刷済(対応完了)のキャンセルも隠す
 * v3-2-1: ★ 仕入値未取得の注文を一括印刷から除外(個別印刷は可)+ 仕入値未取得バナー
 * v3-18-15-z21: ★ 手動「キャンセル済にする/解除」長押しアクション (app.js 更新)
 * v3-18-15-z20: Phase B 発送済(FULFILLED)/キャンセル済 表示 + 手動「発送済にする」
 * v3-18-15-z19: 注文取得リカバリ機能 + ヘッダー縦積み是正
 */
const CACHE_NAME = 'ebay-ship-v3-3-2';

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
