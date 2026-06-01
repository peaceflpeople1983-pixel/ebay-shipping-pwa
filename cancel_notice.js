/**
 * cancel_notice.js — キャンセル通知ピッキングリスト機能 (PWAクライアント新規ファイル / v1.0)
 *
 * 仕様: CANCEL_NOTICE_PLAN_v1.md 参照
 * モックアップ: cancel_notice_mockup_v1.html 参照
 *
 * 主な機能:
 *   - 注文一覧上部のキャンセル通知バナー表示
 *   - 注文カードへの「🚨 キャンセル通知未印刷」バッジ追加
 *   - キャンセル通知印刷画面 (A4 2スリップ/ページ)
 *   - 手動キャンセルチェック (PWAヘッダーボタン)
 *   - 印刷完了マーク → AQ列セット
 *
 * 既存ファイルとの関係:
 *   - 既存 API オブジェクトを利用
 *   - app.js から CancelNotice.refresh() / buildCancelBadge(o) で連携
 *   - HTMLに screen-cancel-print + banner-cancel-notice + filter-cancel-pending を追加
 *
 * グローバル: window.CancelNotice
 */

(function() {
  'use strict';

  // ============================================================
  // 内部 state
  // ============================================================

  const state = {
    targets: null,          // 最新の getCancelTargets レスポンス
    orderIdSet: new Set(),  // バッジ判定用 Set
    printData: null,        // 印刷画面で取得した詳細
    busy: false             // 二重実行防止
  };

  // ============================================================
  // ヘルパー
  // ============================================================

  function escapeHtmlC_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeAttrC_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDateTimeJST_(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
      const day = String(jst.getUTCDate()).padStart(2, '0');
      const hh = String(jst.getUTCHours()).padStart(2, '0');
      const mm = String(jst.getUTCMinutes()).padStart(2, '0');
      return m + '/' + day + ' ' + hh + ':' + mm;
    } catch (e) { return iso; }
  }

  function showToastC_(msg) {
    if (typeof showToast === 'function') {
      showToast(msg);
      return;
    }
    try { console.log('[CancelNotice]', msg); } catch (_) {}
  }

  // ============================================================
  // CancelNotice メインモジュール
  // ============================================================

  const CancelNotice = {

    /**
     * 初期化 + 最新のキャンセル通知データ取得
     * (app.js の loadAll の最後 もしくは renderOrders の前に呼ばれる)
     */
    async refresh() {
      try {
        const data = await API.getCancelTargets();
        state.targets = data || { unprintedCancellations: 0, hasItems: false, orderIds: [] };
        state.orderIdSet = new Set(state.targets.orderIds || []);
        this.renderBanner();
        this.updateHeaderBadge();
      } catch (e) {
        try { console.error('[CancelNotice] refresh failed:', e); } catch (_) {}
        state.targets = { unprintedCancellations: 0, hasItems: false, orderIds: [] };
        state.orderIdSet = new Set();
      }
    },

    /**
     * 指定 orderId がキャンセル通知未印刷か (カードのバッジ判定用)
     */
    isCancelPending(orderId) {
      if (!orderId) return false;
      return state.orderIdSet.has(String(orderId).trim());
    },

    /**
     * 注文カード用バッジ HTML (app.js renderOrders から呼ぶ)
     */
    buildBadge(o) {
      if (!o || !this.isCancelPending(o.orderId)) return '';
      return '<span class="badge cancel-notice-badge">🚨 キャンセル通知未印刷</span>';
    },

    /**
     * 注文カード用 root クラス追記 (赤ボーダー装飾)
     */
    buildItemClass(o) {
      if (!o || !this.isCancelPending(o.orderId)) return '';
      return ' cancel-notice';
    },

    // ============================================================
    // バナー表示
    // ============================================================

    /**
     * 注文一覧上部のバナーを描画
     */
    renderBanner() {
      const banner = document.getElementById('banner-cancel-notice');
      if (!banner) return;
      const count = state.targets ? state.targets.unprintedCancellations : 0;
      if (!count) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
      }
      banner.classList.remove('hidden');
      banner.innerHTML =
        '<span class="banner-icon">🚨</span>' +
        '<div class="banner-body">' +
          '<div class="banner-main">キャンセル通知 未印刷: <strong>' + count + '件</strong></div>' +
          '<div class="banner-sub">印刷済orderがeBayでキャンセルされました</div>' +
        '</div>' +
        '<button class="banner-btn" id="btn-cancel-print">📋 通知印刷</button>';
      const btn = document.getElementById('btn-cancel-print');
      if (btn) btn.onclick = () => this.openPrintScreen();
    },

    /**
     * ヘッダーボタンのバッジ更新 (件数表示)
     */
    updateHeaderBadge() {
      const badge = document.getElementById('cancel-check-badge');
      if (!badge) return;
      const count = state.targets ? state.targets.unprintedCancellations : 0;
      if (count > 0) {
        badge.textContent = String(count);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    },

    // ============================================================
    // 手動キャンセルチェック (ヘッダーボタン)
    // ============================================================

    async manualCheck() {
      if (state.busy) return;
      state.busy = true;
      const btn = document.getElementById('btn-cancel-check');
      if (btn) btn.disabled = true;
      try {
        showToastC_('eBayでキャンセル状態をチェック中...');
        const result = await API.detectCancelNow();
        const detected = (result && result.detected) || 0;
        const expanded = (result && result.doukonExpanded) || 0;
        if (detected > 0 || expanded > 0) {
          const parts = [];
          if (detected > 0) parts.push(detected + '件');
          if (expanded > 0) parts.push('(同梱拡張 ' + expanded + '件)');
          showToastC_('🚨 ' + parts.join(' ') + ' のキャンセルを検出');
        } else {
          showToastC_('✓ 新規キャンセルはありません');
        }
        await this.refresh();
        // 既存の注文一覧も再描画
        if (window.App && typeof App.renderOrders === 'function') {
          App.renderOrders();
        }
      } catch (e) {
        showToastC_('チェックエラー: ' + (e.message || e));
      } finally {
        state.busy = false;
        if (btn) btn.disabled = false;
      }
    },

    // ============================================================
    // 印刷画面
    // ============================================================

    /**
     * キャンセル通知印刷画面を開く
     */
    async openPrintScreen() {
      const screen = document.getElementById('screen-cancel-print');
      if (!screen) {
        showToastC_('印刷画面のHTMLが見つかりません');
        return;
      }

      // 画面遷移 (既存パターン: .hidden 切り替え)
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      screen.classList.remove('hidden');

      const loader = document.getElementById('cancel-print-loader');
      const content = document.getElementById('cancel-print-content');
      if (loader) loader.classList.remove('hidden');
      if (content) content.innerHTML = '';

      try {
        const data = await API.getCancelPrintData();
        state.printData = data;
        this.renderPrintSheets(data);
      } catch (e) {
        if (content) {
          content.innerHTML = '<div class="cancel-error">読込エラー: ' + escapeHtmlC_(e.message || e) + '</div>';
        }
      } finally {
        if (loader) loader.classList.add('hidden');
      }
    },

    /**
     * 印刷画面を閉じて注文一覧に戻る
     */
    closePrintScreen() {
      const screen = document.getElementById('screen-cancel-print');
      const list = document.getElementById('screen-list');
      if (screen) screen.classList.add('hidden');
      if (list) list.classList.remove('hidden');
    },

    /**
     * 印刷シートを描画 (v1.5: 2スリップ/A4ページ 維持、内容コンパクト化)
     */
    renderPrintSheets(data) {
      const content = document.getElementById('cancel-print-content');
      if (!content) return;
      if (!data || !data.orders || data.orders.length === 0) {
        content.innerHTML = '<div class="cancel-empty">未印刷のキャンセル通知はありません。</div>';
        return;
      }

      const orders = data.orders;
      // 2件ずつA4にまとめる
      const pages = [];
      for (let i = 0; i < orders.length; i += 2) {
        pages.push(orders.slice(i, i + 2));
      }

      const html = pages.map((pageOrders, pageIdx) => {
        const slipsHtml = pageOrders.map((o, slipIdx) =>
          this._buildSlip(o, pageIdx * 2 + slipIdx + 1, orders.length)
        ).join(
          '<div class="cancel-cut">- - - - - - - - 切　離　線 - - - - - - - -</div>'
        );
        return '<div class="cancel-a4-paper">' + slipsHtml + '</div>';
      }).join('');

      content.innerHTML = html;
    },

    /**
     * 1スリップのHTML構築
     */
    _buildSlip(o, slipNum, total) {
      const isCancelled = o.doukonIsCancelled !== false;
      const inDoukon = !!o.doukonGroupId;
      const doukonInfo = inDoukon
        ? (o.doukonRole === 'lead' ? '代表' : 'サブ')
          + ' (' + slipNum + '/' + total + '・' + (o.doukonCancelledCount || 0) + '/' + (o.doukonSize || 1) + ')'
        : (slipNum + '/' + total);

      const addr = [o.city, o.state, o.postalCode].filter(Boolean).join(', ');

      // 同梱グループ内で この order がキャンセル対象 か 巻込まれただけ か
      let warningInner;
      let instruction;
      if (isCancelled) {
        warningInner =
          '<span style="font-size:18pt;">⛔ DO NOT SHIP ⛔</span><br>' +
          '<span style="font-size:9pt;font-weight:500;">発送禁止 — 既存ピッキングリストから抜取</span>';
        instruction = '✋ 既存ピッキングリストの <code>' + escapeHtmlC_(o.orderId) +
          '</code> を見つけて、本通知と一緒に保留してください。<br>梱包・発送はしないでください。';
      } else {
        warningInner =
          '<span style="font-size:14pt;">⚠ 同梱内に1件キャンセル ⚠</span><br>' +
          '<span style="font-size:9pt;font-weight:500;">同梱グループ全体を要確認</span>';
        instruction = '⚠ 同梱グループ <code>' + escapeHtmlC_(o.doukonGroupId) +
          '</code> 内に1件キャンセルあり (' + (o.doukonCancelledCount || 0) + '/' + (o.doukonSize || 1) +
          ')。<br>このorder自体は有効ですが、同梱として一旦保留してください。';
      }

      const imgHtml = o.imageUrl
        ? '<img class="cancel-slip-thumb" src="' + escapeAttrC_(o.imageUrl) + '" alt="" onerror="this.outerHTML=\'<div class=&quot;cancel-slip-thumb-placeholder&quot;>📦</div>\'">'
        : '<div class="cancel-slip-thumb-placeholder">📦</div>';

      return (
        '<div class="cancel-slip' + (isCancelled ? ' is-cancelled' : ' is-doukon-warn') + '">' +
          '<div class="cancel-slip-header">' +
            '<div class="cancel-slip-title">🚨 CANCELLED / キャンセル 🚨</div>' +
            '<div class="cancel-slip-meta">' + escapeHtmlC_(o.account) + ' / ' + doukonInfo + '</div>' +
          '</div>' +
          '<div class="cancel-slip-orderid">' +
            '<div class="cancel-slip-orderid-label">ORDER ID (突合用)</div>' +
            '<div class="cancel-slip-orderid-value">' + escapeHtmlC_(o.orderId) + '</div>' +
          '</div>' +
          '<div class="cancel-slip-body">' +
            imgHtml +
            '<div class="cancel-slip-info">' +
              '<div class="label">ITEM</div><div>' + escapeHtmlC_(o.itemTitle) + '</div>' +
              '<div class="label">BUYER</div><div>' + escapeHtmlC_(o.buyerName) + '</div>' +
              '<div class="label">SHIPPING</div><div>' + escapeHtmlC_(addr || o.country || '') + '</div>' +
              '<div class="label">VALUE</div><div>$' + escapeHtmlC_(o.itemPrice || 0) + ' USD</div>' +
            '</div>' +
          '</div>' +
          '<div class="cancel-slip-times">' +
            '<strong>⛔ Cancelled at:</strong> ' + escapeHtmlC_(formatDateTimeJST_(o.cancelledAt)) + ' JST<br>' +
            '<strong>📋 Originally printed:</strong> ' + escapeHtmlC_(formatDateTimeJST_(o.printedAt)) + ' JST' +
          '</div>' +
          '<div class="cancel-warning-box">' + warningInner + '</div>' +
          '<div class="cancel-instruction">' + instruction + '</div>' +
        '</div>'
      );
    },

    // ============================================================
    // ブラウザ印刷 + 完了マーク
    // ============================================================

    /**
     * window.print() を呼んで物理印刷
     *
     * ★ v1.3 ポータル方式 + 動的CSS注入 + A4 1ページ固定:
     *   - 印刷対象 HTML を body 直下の隠し div にクローン
     *   - @media print ルールを JS から動的に <style> として注入 (最高特異性)
     *   - style.css の既存ルールと共存可能
     *
     *   診断ログ: console (F12) で「[CancelNotice v1.5]」を確認できれば新コード稼働中。
     */
    triggerPrint() {
      console.log('[CancelNotice v1.5] triggerPrint called');

      const content = document.getElementById('cancel-print-content');
      if (!content || !content.innerHTML.trim()) {
        console.warn('[CancelNotice v1.5] content empty');
        showToastC_('印刷対象がありません');
        return;
      }

      // ポータル (body 直下) を準備
      let portal = document.getElementById('cancel-print-portal');
      if (!portal) {
        portal = document.createElement('div');
        portal.id = 'cancel-print-portal';
        document.body.appendChild(portal);
        console.log('[CancelNotice v1.5] Portal created');
      }
      portal.innerHTML = content.innerHTML;
      const a4Count = portal.querySelectorAll('.cancel-a4-paper').length;
      console.log('[CancelNotice v1.5] Portal populated with', a4Count, 'A4 sheets');

      // ★ 動的 CSS 注入 (キャッシュ無関係に最新ルール適用 + 最高特異性で他CSS上書き)
      let dynStyle = document.getElementById('cancel-print-dyn-style');
      if (!dynStyle) {
        dynStyle = document.createElement('style');
        dynStyle.id = 'cancel-print-dyn-style';
        document.head.appendChild(dynStyle);
      }
      // ★ v1.5: 2スリップ/A4ページ + 全要素コンパクト化 (各スリップ約105mm目標)
      dynStyle.textContent = [
        '@media print {',
        '  @page { size: A4; margin: 0; }',
        '  html body.cancel-print-active > * { display: none !important; }',
        '  html body.cancel-print-active > #cancel-print-portal {',
        '    display: block !important; position: static !important;',
        '    margin: 0 !important; padding: 0 !important;',
        '    width: 100% !important; height: auto !important;',
        '    overflow: visible !important; visibility: visible !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal * { visibility: visible !important; }',
        '  /* A4 ラッパー: 高さ 297mm 固定 + 2スリップ縦並び */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-a4-paper {',
        '    display: flex !important; flex-direction: column !important;',
        '    width: 210mm !important; max-width: 210mm !important;',
        '    height: 297mm !important; max-height: 297mm !important;',
        '    margin: 0 auto !important; padding: 3mm 5mm !important;',
        '    border: 3px solid #A32D2D !important;',
        '    box-shadow: none !important;',
        '    page-break-after: always !important;',
        '    page-break-inside: avoid !important;',
        '    gap: 2mm !important; box-sizing: border-box !important;',
        '    background: #fff !important; overflow: hidden !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-a4-paper:last-child {',
        '    page-break-after: auto !important;',
        '  }',
        '  /* 各スリップ = 140mm 固定 (内容溢れたら overflow:hidden) */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip {',
        '    flex: 0 0 140mm !important;',
        '    height: 140mm !important; max-height: 140mm !important;',
        '    overflow: hidden !important;',
        '    box-sizing: border-box !important;',
        '    padding: 0 3mm 3mm 3mm !important;',
        '    border: 2px solid #A32D2D !important;',
        '    border-radius: 3px !important;',
        '    display: flex !important; flex-direction: column !important;',
        '    background: #fff !important;',
        '  }',
        '  /* 切離線 = 3mm */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-cut {',
        '    flex: 0 0 3mm !important;',
        '    height: 3mm !important;',
        '    margin: 0 !important; padding: 0 !important;',
        '    box-sizing: border-box !important;',
        '    text-align: center !important;',
        '    font-size: 7pt !important;',
        '    color: #888 !important;',
        '    border-top: 1px dashed #888 !important;',
        '    letter-spacing: 2px !important;',
        '    line-height: 3mm !important;',
        '  }',
        '  /* === スリップ内部要素を強くコンパクト化 === */',
        '  /* ヘッダー: 小さく */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-header {',
        '    min-height: 7mm !important; padding: 1.5mm 0 !important; margin: 0 0 1.5mm 0 !important;',
        '    border-bottom: 2px solid #A32D2D !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-title {',
        '    font-size: 10pt !important; line-height: 1.1 !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-meta {',
        '    font-size: 7.5pt !important;',
        '  }',
        '  /* Order ID 枠: 小さく */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-orderid {',
        '    padding: 1mm 3mm !important; margin-bottom: 1.5mm !important;',
        '    border-width: 2px !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-orderid-label {',
        '    font-size: 6pt !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-orderid-value {',
        '    font-size: 12pt !important; line-height: 1.1 !important;',
        '  }',
        '  /* 商品情報: 画像 20mm、テキスト 7.5pt */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-body {',
        '    grid-template-columns: 20mm 1fr !important; gap: 2.5mm !important; margin-bottom: 1.5mm !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-thumb,',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-thumb-placeholder {',
        '    width: 20mm !important; height: 20mm !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-info {',
        '    font-size: 7.5pt !important; line-height: 1.3 !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-info .label {',
        '    font-size: 6pt !important; margin-top: 0.5mm !important;',
        '  }',
        '  /* 日時情報: 小さく */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-slip-times {',
        '    font-size: 6.5pt !important; margin: 0.5mm 0 !important; line-height: 1.3 !important;',
        '  }',
        '  /* 警告ボックス: 小さく */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-warning-box {',
        '    padding: 1.5mm !important; font-size: 10pt !important;',
        '    margin: 1mm 0 !important; line-height: 1.2 !important;',
        '    border-width: 2px !important;',
        '  }',
        '  html body.cancel-print-active #cancel-print-portal .cancel-warning-box span {',
        '    font-size: 13pt !important;',
        '  }',
        '  /* 指示文: 小さく */',
        '  html body.cancel-print-active #cancel-print-portal .cancel-instruction {',
        '    padding: 1mm 2mm !important; font-size: 6.5pt !important; line-height: 1.3 !important;',
        '  }',
        '}'
      ].join('\n');

      document.body.classList.add('cancel-print-active');
      console.log('[CancelNotice v1.5] Class added, dynStyle injected. Calling print() in 300ms...');

      // setTimeout で確実にレイアウト反映後に印刷 (300ms = 余裕を持って)
      setTimeout(() => {
        console.log('[CancelNotice v1.5] Calling window.print()');
        window.print();
        // 印刷ダイアログを閉じた後、クリーンアップ
        setTimeout(() => {
          document.body.classList.remove('cancel-print-active');
          if (portal) portal.innerHTML = '';
          console.log('[CancelNotice v1.5] Cleanup done');
        }, 1000);
      }, 300);
    },

    /**
     * 印刷完了マーク (AQ列セット) → リフレッシュ
     */
    async confirmPrinted() {
      if (state.busy) return;
      if (!state.printData || !state.printData.orders || state.printData.orders.length === 0) {
        showToastC_('印刷対象がありません');
        return;
      }
      state.busy = true;
      const btn = document.getElementById('btn-cancel-confirm');
      if (btn) btn.disabled = true;
      try {
        const orderIds = state.printData.orders.map(o => o.orderId);
        // 重複除去 (同梱で複数行ある場合)
        const uniqueIds = Array.from(new Set(orderIds));
        await API.markCancelPrinted(uniqueIds);
        showToastC_('✓ 通知印刷完了をマークしました (' + uniqueIds.length + 'order)');
        // 画面戻り
        this.closePrintScreen();
        // 再取得 + 一覧再描画
        await this.refresh();
        if (window.App && typeof App.renderOrders === 'function') {
          App.renderOrders();
        }
      } catch (e) {
        showToastC_('マークエラー: ' + (e.message || e));
      } finally {
        state.busy = false;
        if (btn) btn.disabled = false;
      }
    },

    // ============================================================
    // 初期化
    // ============================================================

    bindEvents() {
      const btnCheck = document.getElementById('btn-cancel-check');
      if (btnCheck) btnCheck.onclick = () => this.manualCheck();

      const btnPrintTrigger = document.getElementById('btn-cancel-do-print');
      if (btnPrintTrigger) btnPrintTrigger.onclick = () => this.triggerPrint();

      const btnConfirm = document.getElementById('btn-cancel-confirm');
      if (btnConfirm) btnConfirm.onclick = () => this.confirmPrinted();

      const btnBack = document.getElementById('btn-cancel-back');
      if (btnBack) btnBack.onclick = () => this.closePrintScreen();
    }
  };

  // ============================================================
  // 公開
  // ============================================================

  window.CancelNotice = CancelNotice;

  // DOMContentLoaded で event bind
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CancelNotice.bindEvents());
  } else {
    CancelNotice.bindEvents();
  }
})();
