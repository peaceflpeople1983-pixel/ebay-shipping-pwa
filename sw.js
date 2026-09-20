/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-7-0: ★ 料金後納郵便物差出票の出力: 確定済ePacketライトを重量帯×料金で集計し正式様式をA4印刷 (sashidashi.js 新規)
 * v3-6-1: ★ FedEx混雑時割増金(2026-09-21改定・国別kg単価×請求重量・最低37円) + NSSDS(非標準+770円) +
 *           燃料割増金の自動加算(FedEx=公表週率/DHL=公表×0.75・週次キャッシュ) + 米国MPF(2.69USD) +
 *           特別取扱料金の重複加算修正(寸法+重量→高い方1つ) + 特別取扱(寸法)の最低請求重量18kg (calculator.js)
 * v3-5-2: ★ DE二重管理解消: EcoのDE料金参照を料金_Eco_EUのDE列に一本化(料金_Eco_DEは凍結・フォールバック用) (calculator.js)
 * v3-5-1: ★ アプリ設定対応: 為替レートをマスタ「アプリ設定」シートから取得(フォールバック150円) (calculator.js)
 * v3-5-0: ★ SpeedPAK Economy EU27対応: EU26カ国の料金参照(料金_Eco_EU)+ DE/AU/EUの寸法・重量制限を2026-07-30版に更新 (calculator.js)
 * v3-4-1: ★ 同期エラーバナー: アカウント別の注文同期失敗(eBay認証切れ等)をPWAに警告表示(沈黙させない)
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
const CACHE_NAME = 'ebay-ship-v3-7-0'; // v3.7.0: 料金後納郵便物差出票の出力 (sashidashi.js)

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
  './sashidashi.js',
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
