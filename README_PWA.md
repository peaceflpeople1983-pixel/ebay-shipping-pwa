# eBay発送最適化PWA - 公開＆セットアップ手順

## このアプリについて

eBayの発送先国・梱包後重量・3辺サイズを入力すると、3社（ePacketライト・SpeedPAK Economy・Ship via DHL）から最適な発送方法を提案するPWA（Webアプリ）です。iPhoneのホーム画面に追加することで、通常のアプリのように使えます。

## ファイル一覧

```
ebay-shipping-pwa/
├── index.html              メイン画面（HTML構造）
├── style.css               スタイル
├── app.js                  UI制御
├── api.js                  Apps Script API呼び出し
├── calculator.js           発送計算ロジック
├── ocr.js                  カメラ・OCR・バーコード
├── manifest.webmanifest    PWA設定
├── sw.js                   Service Worker（オフライン）
├── icon-192.png            アイコン（小）
├── icon-512.png            アイコン（大）
└── README_PWA.md           本ファイル
```

## 公開手順（GitHub Pages）

### Step 1：GitHubアカウントの作成

1. ブラウザで [https://github.com](https://github.com) を開く
2. 「Sign up」から無料アカウントを作成
3. メール認証を完了

### Step 2：リポジトリの作成

1. 右上の「+」→「New repository」をクリック
2. 設定：
   - **Repository name**：`ebay-shipping-pwa`
   - **Public** を選択（GitHub Pages無料プランの条件）
   - **Add a README file** にチェック
3. 「Create repository」をクリック

### Step 3：PWAファイルをアップロード

1. リポジトリのトップで「Add file」→「Upload files」をクリック
2. outputs/pwa/ 配下の **以下11ファイル**を選択してドラッグ＆ドロップ：
   - `index.html`
   - `style.css`
   - `app.js`
   - `api.js`
   - `calculator.js`
   - `ocr.js`
   - `manifest.webmanifest`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`
   - `README_PWA.md`
3. 下部の「Commit changes」をクリック

### Step 4：GitHub Pages を有効化

1. リポジトリの「Settings」タブをクリック
2. 左メニュー「Pages」をクリック
3. 「Source」を「Deploy from a branch」に設定
4. Branch を「main」「/ (root)」に設定し「Save」をクリック
5. 1〜2分待つと、ページ上部にURLが表示される

```
https://【あなたのGitHubユーザー名】.github.io/ebay-shipping-pwa/
```

### Step 5：iPhoneで開いてホーム画面に追加

1. iPhoneのSafariで上記URLを開く
2. 画面下部の「共有」ボタン（四角形+矢印）をタップ
3. 「ホーム画面に追加」を選択
4. 名前を「eBay Ship」など好きな名前にして「追加」

ホーム画面のアイコンから起動すると、アプリ風に全画面で動作します。

## 初回セットアップ

PWAを最初に開くと「初期設定」画面が表示されます。

1. **Apps Script Web App URL**：Apps Scriptで取得したWeb App URLを貼り付け（例：`https://script.google.com/macros/s/.../exec`）
2. **共有シークレット**：Apps Scriptで`PWA_SHARED_SECRET`をセットしている場合のみ入力（任意）
3. 「保存して開始」をタップ

設定はiPhoneのlocalStorageに保存されるため、次回以降は不要です。

## 使い方

### 注文一覧 → 発送方法を確定する流れ

1. ホーム画面でアプリを起動 → 注文一覧が表示
2. 同期したい場合は右上の「⟳」をタップ（eBayから最新注文を取得）
3. 発送する注文をタップ → 入力画面へ
4. 重量・寸法を入力（注文IDはeBayから自動で入力済み）
5. 「最適な発送方法を提案」をタップ
6. 候補が安い順に表示される。希望する発送会社をタップ → 「この発送方法で確定」

### OCRで注文IDを読み取る

1. 入力画面で注文ID欄の右の「📷」アイコンをタップ
2. カメラ起動 → eBayラベルの注文ID部分を撮影
3. 自動的に注文IDが入力欄に転記される

バーコードがある場合はカメラを向けるだけで自動検出されます。

## 更新方法

PWAのコードを修正したい場合：

1. GitHubリポジトリで該当ファイルをクリック
2. 鉛筆アイコン（編集）をクリック
3. 内容を編集して「Commit changes」
4. 1〜2分でGitHub Pagesに反映される

iPhone側でキャッシュが残る場合は：
- アプリを終了して再起動
- それでも更新されなければ Safari → 設定 → 履歴とWebサイトデータを消去

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| 注文一覧が空 | Apps Script Web App URLが間違っている／Sheetsに注文がない | 設定⚙でURLを確認、Apps Scriptで `syncAllOrders` を実行 |
| 「読み込みエラー」 | Apps Script側で例外発生 | Apps Scriptの実行ログを確認 |
| カメラが起動しない | HTTPS未対応 or 権限拒否 | URLが`https://`であることを確認、Safariのカメラ権限を許可 |
| OCRが動かない | tesseract.jsの読み込み失敗 | ネット接続を確認、初回読み込みは数十MBダウンロード |
| ホーム画面追加後に画面が真っ白 | Service Workerのキャッシュ不整合 | アプリ削除→Safariキャッシュ消去→再追加 |

## セキュリティ補足

- **PWA本体に認証情報は含まれていません**。Apps Script Web App URLとオプションの共有シークレットだけが端末localStorageに保存されます
- Apps Script側で `PWA_SHARED_SECRET` を設定すれば、POSTリクエストには共有シークレットが必須となり、URLが漏れても書込み不可になります
- カメラ画像はOCRで端末内処理され、外部サーバーには送信されません

## 次のステップ

セットアップが完了したら、以下を試してください：

1. eBay APIから取り込まれた実注文を選択
2. 重量・寸法を入力
3. 提案された発送方法をSheetsに記録
4. PCでGoogle Sheetsを開き、データが反映されていることを確認

問題なければ運用開始です。サーチャージや国別ルールに調整が必要な場合は、`master_v3.xlsx`をベースにGoogle Sheetsを直接編集することで反映できます。
