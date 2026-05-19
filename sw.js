/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-17-1: v3.17.0 の印刷レイアウト崩れを修正
 *          - カード高 148.5mm → 140mm (2 × 140 = 280mm、A4 内に 17mm 安全余白)
 *          - SHIP TO を position:absolute で底面固定 (iOS Safari の margin-top:auto 不安定対策)
 *          - .print-pair を印刷時 display:contents で透過 + .print-page:nth-of-type(2n) で改ページ
 *          - アカウント名カラム 58→80px に拡張、フォント縮小で1行収まり
 *          - flex 廃止 → block 配置 (iOS Safari 印刷モードの flex 不安定対策)
 * v3-17-0: 発送期日 (eBay shipByDate) を一覧・印刷に表示 + 印刷モードを 1ページ2商品に固定
 *          - 一覧右上に色付き期日バッジ (緊急度4段階 + 期限不明)
 *          - 期限フィルタ ⛔超過のみ / ⚠24h以内のみ を追加
 *          - 印刷ヘッダ3カラム (タイトル | 発送期日 | 日付) を1行収まり
 *          - .print-pair で A4 1枚 = 2カード (148.5mm × 2) を構成
 *          - 奇数末尾は上カードのみ・下半分は空白
 *          - SHIP TO を margin-top:auto で最下部固定 (見切れ防止 + フル住所表示)
 * v3-16-6: ブラウザのヘッダ/フッタ(URL・日付・ページ番号)を CSS で抑制
 * v3-16-5: カードを A4 上半分 140mm 固定 (将来 1ページ2商品印刷の準備)
 * v3-16-4: iOS の累積ドリフト対策 (固定 height 撤廃・page-break-after のみで制御)
 * v3-16-3: iOS Safari 印刷の 2ページ化を修正 (.print-page を 250mm + break-after プリフィックス追加)
 * v3-16-2: 印刷時に 1注文が 2ページに分かれる問題を修正 (.print-page サイズ調整)
 * v3-16-1: Apps Script API を SW intercept から除外 (FetchEvent.respondWith null エラー対策)
 *          Keepa API URL も intercept しない
 * v3-16: ピックアップシート印刷機能 (1商品1ページ, A4縦, OCR対応OrderID, Amazon商品名)
 * v3-15: PWA に CPaSS バナー + [取込実行] ボタン + 未取込警告 + 6時間メールリマインダ
 * v3-14: CPaSS パッケージ番号/ASIN 表示 (注文一覧 + 入力画面)
 * v3-13: 発送追跡番号の自動取得 / 発送済バッジ / 発送済を隠すトグル / 発送日+追跡番号表示
 * v3-12: 重量 kg/g 単位ミスマッチを自動補正（過去注文オープン時 + 計算時の救済確認）
 * v3-11: 候補外配送会社の理由を画面表示（ePacket除外原因切り分け）
 * v3-10: shipping policy に応じた推奨配送会社ハイライト（ゴールド塗りつぶし）
 * v3-9: ツールバーのボタン押下を touchstart 経由でも動かす（iOS click抑止対策）
 * 商品画像はブラウザ標準のHTTPキャッシュに任せる（iOS Safari互換性のため）
 */
const CACHE_NAME = 'ebay-ship-v3-17-1';

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

  // eBay画像CDN: SWで一切触らない（ブラウザ標準処理）
  if (url.hostname.indexOf('ebay') !== -1 || url.hostname.indexOf('ebaystatic') !== -1) {
    return;
  }

  // v3.16.1: Apps Script API は SW で一切触らない (リダイレクト処理 + null Response 防止)
  // script.google.com → script.googleusercontent.com の redirect を SW で intercept すると壊れる
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('keepa.com')) {
    return;
  }

  // CDN はネットワーク優先 (失敗時はキャッシュ、それも無ければ最小エラー Response)
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(r => r || new Response('', { status: 503, statusText: 'Offline' }))
      )
    );
    return;
  }

  // 静的ファイルはキャッシュ優先 (キャッシュ無ければネットワーク、それも失敗時はエラー Response)
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    )
  );
});
