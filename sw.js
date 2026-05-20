/**
 * Service Worker - 静的ファイルのオフラインキャッシュ
 * v3-17-7: 「The string did not match the expected pattern」エラー対策
 *          - computeDeadlineMeta/_formatDeadlineJst/_buildDeadlineBadge を完全防御化
 *          - YYYY/MM/DD や space 区切り日時を ISO に正規化してから new Date()
 *          - renderOrders を try/catch で囲み、エラー時もエラー表示で継続
 *          - loadAll の各ステップに識別子を付与し、エラー時にどの段階で失敗したか分かる
 * v3-17-6: DHL/FedEx を全 shipping policy で常時ゴールド推奨化
 *          - getRecommendedCarrierTypes に DHL/FedEx を追加
 *          - eBay SpeedPAK Economy → ['speedpak','dhl','fedex']
 *          - Economy International Shipping → ['epacket','dhl','fedex']
 *          - Expedited 系は元々 ['dhl','fedex'] なので変更なし
 * v3-17-5: v3.17.4 までの「ペアラッパー依存」を撤回し、位置クラス方式に変更
 *          - 奇数カード=.top に page-break-before:always (A4 先頭強制)
 *          - 偶数カード=.bottom に page-break-before:avoid (上カードと同ページ・148.5mm 位置)
 *          - .print-pair から height/overflow/page-break を撤去 (iOS Safari 破綻の原因排除)
 *          - 各カード height:148.5mm + overflow:hidden で物理的に半分占有
 *          - 折り目ガイド破線は維持
 * v3-17-4: v3.17.3 で CSS Grid が iOS Safari 印刷で機能せず 4商品が3ページに分散した問題を修正
 *          - Grid 撤回 → block レイアウト + .print-page { height: 148.5mm } で均等2分割実現
 *          - 折り目ガイド破線を印刷時も表示 (border-bottom: 1px dashed #999)
 *          - .print-pair に overflow:hidden 追加で 297mm 厳守 (オーバーフロー時はクリップ)
 *          - 個別カードに page-break-inside: avoid は付けない (過剰ページ分割回避)
 * v3-17-3: A4縦幅を 148.5mm × 2 で均等割付 (半分折り/カット運用対応)
 *          - CSS Grid (grid-template-rows: 148.5mm 148.5mm) で .print-pair を完全均等2分割
 *          - 上半分=カード1、下半分=カード2 が物理的に固定 → 折り目位置が明確
 *          - 各カードに height: 148.5mm + overflow: hidden で厳密制限
 *          - 奇数最終ページの下半分セルは空白として残す (display: none せず)
 * v3-17-2: v3.17.1 で「各カード1ページ・SHIP TO周辺に大きな空白」になった問題を修正
 *          - display:contents + nth-of-type(2n) を撤回 (iOS Safari で機能せず)
 *          - .print-pair を A4 1枚の page-break 単位に戻す (v3.16時代と同方式)
 *          - カードの固定高 140mm を撤廃 → ナチュラル高さ (コンテンツ依存 ~95mm)
 *          - SHIP TO を position:absolute から自然フローに戻す (空白なし)
 *          - page-break-inside: avoid は .print-pair のみ (個別カードには付けず過剰ページ分割回避)
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
const CACHE_NAME = 'ebay-ship-v3-18-4';

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
