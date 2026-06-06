/**
 * recovery.js — 注文取得リカバリ機能 (PWAクライアント新規 / RECOVERY_PLAN v1.2)
 *
 * 機能:
 *   - ヘッダー「📥 未取得」ボタンの件数バッジ更新 (getOrders 同梱の recovery_missing_count)
 *   - 取込画面 (screen-recovery): API を先に確認した候補を 3分類で一覧
 *       🟢 api_ok      → [API取込] (recoveryFetchOne, フル情報)
 *       🔴 api_missing → メールプレビュー + [メール情報で追加] (recoveryAddFromEmail, 仮)
 *       ⚪ unknown      → 後で再試行 (ボタン無し)
 *
 * 既存との関係:
 *   - 既存 API オブジェクト利用 (api.js)
 *   - app.js loadAll から Recovery.setCount(data.recovery_missing_count) で連携
 *   - HTMLに btn-recovery / recovery-badge / screen-recovery を追加 (index v6)
 *
 * グローバル: window.Recovery
 */

(function () {
  'use strict';

  const state = {
    count: 0,
    data: null,
    busy: false
  };

  function escHtmlR_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttrR_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toastR_(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    try { console.log('[Recovery]', msg); } catch (_) {}
  }

  const Recovery = {

    /**
     * getOrders レスポンスの recovery_missing_count を受けてバッジ更新。
     * (app.js loadAll から呼ばれる)
     */
    setCount(n) {
      state.count = parseInt(n, 10) || 0;
      this.updateHeaderBadge();
    },

    updateHeaderBadge() {
      const badge = document.getElementById('recovery-badge');
      if (!badge) return;
      if (state.count > 0) {
        badge.textContent = String(state.count);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    },

    /**
     * 注文カード用「📧 メール由来(仮)」バッジ (app.js renderOrders から呼ぶ)
     */
    buildBadge(o) {
      if (o && o.dataSource === 'email') {
        return '<span class="badge recovery-email-badge">📧 メール由来(仮)</span>';
      }
      if (o && o.dataSource === 'report') {
        return '<span class="badge recovery-report-badge">📄 レポート由来</span>';
      }
      return '';
    },

    buildItemClass(o) {
      if (o && o.dataSource === 'email') return ' recovery-provisional';
      if (o && o.dataSource === 'report') return ' recovery-report';
      return '';
    },

    // ============================================================
    // 取込画面
    // ============================================================

    async openScreen() {
      const screen = document.getElementById('screen-recovery');
      if (!screen) { toastR_('取込画面のHTMLが見つかりません'); return; }

      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      screen.classList.remove('hidden');

      const loader = document.getElementById('recovery-loader');
      const content = document.getElementById('recovery-content');
      if (loader) loader.classList.remove('hidden');
      if (content) content.innerHTML = '';

      try {
        const data = await API.recoveryGetMissing();
        state.data = data;
        this.renderCandidates(data);
      } catch (e) {
        if (content) content.innerHTML =
          '<div class="recovery-error">読込エラー: ' + escHtmlR_(e.message || e) + '</div>';
      } finally {
        if (loader) loader.classList.add('hidden');
      }
    },

    closeScreen() {
      const screen = document.getElementById('screen-recovery');
      const list = document.getElementById('screen-list');
      if (screen) screen.classList.add('hidden');
      if (list) list.classList.remove('hidden');
    },

    renderCandidates(data) {
      const content = document.getElementById('recovery-content');
      if (!content) return;
      const cands = (data && data.candidates) || [];
      if (cands.length === 0) {
        content.innerHTML = '<div class="recovery-empty">未取得の注文はありません。✓</div>';
        return;
      }

      const note =
        '<div class="recovery-screen-note">✓ 各 order を先に eBay API で確認しました。' +
        '緑は API で取得、赤は API が壊れている注文です。</div>';

      const cards = cands.map(c => this._buildCard(c)).join('');
      content.innerHTML = note + cards;

      // ボタンにイベントを bind（api_ok / api_shipped / api_cancelled は rec-api-、api_missing は rec-email-）
      cands.forEach(c => {
        const apiBtn = document.getElementById('rec-api-' + c.orderId);
        if (apiBtn) apiBtn.onclick = () => this.fetchOne(c.orderId, apiBtn);
        const emailBtn = document.getElementById('rec-email-' + c.orderId);
        if (emailBtn) emailBtn.onclick = () => this.addFromEmail(c.orderId, emailBtn);
      });
    },

    _buildCard(c) {
      const e = c.email || {};
      const oid = escHtmlR_(c.orderId);
      if (c.status === 'api_ok') {
        return (
          '<div class="rec-card ok" data-oid="' + escAttrR_(c.orderId) + '">' +
            '<div class="rec-card-top"><span class="rec-status ok">🟢 API取得可</span>' +
              '<span class="rec-oid">' + oid + '</span></div>' +
            '<div class="rec-acc">' + escHtmlR_(c.account) + '</div>' +
            '<div class="rec-line">eBay API で取得できます。フル情報（画像・関税・発送期日）で取り込みます。</div>' +
            '<div class="rec-actions">' +
              '<button class="rec-btn rec-btn-api" id="rec-api-' + escAttrR_(c.orderId) + '">⬇ API取込（フル情報）</button>' +
            '</div>' +
          '</div>'
        );
      }
      if (c.status === 'api_missing') {
        const addr = [e.city, e.state, e.postal].filter(Boolean).join(', ');
        return (
          '<div class="rec-card missing" data-oid="' + escAttrR_(c.orderId) + '">' +
            '<div class="rec-card-top"><span class="rec-status missing">🔴 API不可</span>' +
              '<span class="rec-oid">' + oid + '</span></div>' +
            '<div class="rec-acc">' + escHtmlR_(c.account) + ' · Invalid Order Id</div>' +
            '<div class="rec-line">API が破損のため取得不能。メール情報で追加できます（情報量は限定的）。</div>' +
            '<div class="rec-preview">' +
              '<div class="pv-row"><span class="pv-label">商品</span><span>' + escHtmlR_(e.itemTitle) + '</span></div>' +
              '<div class="pv-row"><span class="pv-label">買い手</span><span>' + escHtmlR_(e.buyerName) + '</span></div>' +
              '<div class="pv-row"><span class="pv-label">宛先</span><span>' + escHtmlR_(addr || e.country || '') + '</span></div>' +
              '<div class="pv-row"><span class="pv-label">価格</span><span>$' + escHtmlR_(e.itemPrice || 0) + '</span></div>' +
              '<div class="pv-row"><span class="pv-label">期日</span><span>' + escHtmlR_(e.shipByDate || '不明') + '</span></div>' +
            '</div>' +
            '<div class="rec-actions">' +
              '<button class="rec-btn rec-btn-email" id="rec-email-' + escAttrR_(c.orderId) + '">📧 メール情報で追加</button>' +
            '</div>' +
            '<div class="rec-warn-note">※ 後で API が復活すれば、未処理の行は自動でフル情報に昇格します。</div>' +
          '</div>'
        );
      }
      if (c.status === 'api_shipped') {
        return (
          '<div class="rec-card ok" data-oid="' + escAttrR_(c.orderId) + '">' +
            '<div class="rec-card-top"><span class="rec-status ok">✓ 発送済</span>' +
              '<span class="rec-oid">' + oid + '</span></div>' +
            '<div class="rec-acc">' + escHtmlR_(c.account) + ' · eBay上で発送済 (FULFILLED)</div>' +
            '<div class="rec-line">この注文は発送済みです。記録すると一覧に「✓ 発送済」で入り、「発送済を隠す」で隠せます。</div>' +
            '<div class="rec-actions">' +
              '<button class="rec-btn rec-btn-api" id="rec-api-' + escAttrR_(c.orderId) + '">✓ 取込（発送済として記録）</button>' +
            '</div>' +
          '</div>'
        );
      }
      if (c.status === 'api_cancelled') {
        return (
          '<div class="rec-card unknown" data-oid="' + escAttrR_(c.orderId) + '">' +
            '<div class="rec-card-top"><span class="rec-status unknown">⊘ キャンセル済</span>' +
              '<span class="rec-oid">' + oid + '</span></div>' +
            '<div class="rec-acc">' + escHtmlR_(c.account) + ' · eBay上でキャンセル</div>' +
            '<div class="rec-line">この注文はキャンセル済みです。記録すると一覧に「⊘ キャンセル済」で入り、「キャンセル済を隠す」で隠せます。</div>' +
            '<div class="rec-actions">' +
              '<button class="rec-btn rec-btn-disabled" id="rec-api-' + escAttrR_(c.orderId) + '" style="background:#5A5A5A;color:#fff;cursor:pointer;">⊘ 取込（キャンセル済として記録）</button>' +
            '</div>' +
          '</div>'
        );
      }
      // unknown
      return (
        '<div class="rec-card unknown" data-oid="' + escAttrR_(c.orderId) + '">' +
          '<div class="rec-card-top"><span class="rec-status unknown">⚪ 確認中</span>' +
            '<span class="rec-oid">' + oid + '</span></div>' +
          '<div class="rec-acc">' + escHtmlR_(c.account) + ' · API一時応答なし</div>' +
          '<div class="rec-line">API が一時的に応答しません。誤追加を防ぐため、今は追加しません。</div>' +
          '<div class="rec-actions"><button class="rec-btn rec-btn-disabled" disabled>後で再試行</button></div>' +
        '</div>'
      );
    },

    async fetchOne(orderId, btn) {
      if (state.busy) return;
      state.busy = true;
      const origLabel = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '取込中...'; }
      try {
        const r = await API.recoveryFetchOne(orderId);
        if (r && r.ok && (r.added || 0) > 0) {
          const label = r.sub === 'cancelled' ? 'キャンセル済として記録'
            : (r.sub === 'shipped' ? '発送済として記録' : 'API取込');
          toastR_('✓ ' + label + ': ' + orderId);
          this._removeCard(orderId);
          this._decrementCount();
          if (window.App && typeof App.loadAll === 'function') App.loadAll();
        } else {
          const reason = (r && r.reason) || 'unknown';
          toastR_('取込できませんでした (' + reason + ')');
          if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        }
      } catch (e) {
        toastR_('取込エラー: ' + (e.message || e));
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
      } finally {
        state.busy = false;
      }
    },

    async addFromEmail(orderId, btn) {
      if (state.busy) return;
      state.busy = true;
      if (btn) { btn.disabled = true; btn.textContent = '追加中...'; }
      try {
        const r = await API.recoveryAddFromEmail(orderId);
        if (r && r.ok) {
          toastR_('📧 メール情報で追加しました: ' + orderId);
          this._removeCard(orderId);
          this._decrementCount();
          if (window.App && typeof App.loadAll === 'function') App.loadAll();
        } else {
          const reason = (r && r.reason) || 'unknown';
          toastR_('追加できませんでした (' + reason + ')');
          if (btn) { btn.disabled = false; btn.textContent = '📧 メール情報で追加'; }
        }
      } catch (e) {
        toastR_('追加エラー: ' + (e.message || e));
        if (btn) { btn.disabled = false; btn.textContent = '📧 メール情報で追加'; }
      } finally {
        state.busy = false;
      }
    },

    _removeCard(orderId) {
      const content = document.getElementById('recovery-content');
      if (!content) return;
      const card = content.querySelector('[data-oid="' + (window.CSS && CSS.escape ? CSS.escape(orderId) : orderId) + '"]');
      if (card) card.remove();
      if (!content.querySelector('.rec-card')) {
        const note = content.querySelector('.recovery-screen-note');
        content.innerHTML = (note ? note.outerHTML : '') +
          '<div class="recovery-empty">残りの未取得はありません。✓</div>';
      }
    },

    _decrementCount() {
      state.count = Math.max(0, state.count - 1);
      this.updateHeaderBadge();
    },

    bindEvents() {
      const btnOpen = document.getElementById('btn-recovery');
      if (btnOpen) btnOpen.onclick = () => this.openScreen();
      const btnBack = document.getElementById('btn-recovery-back');
      if (btnBack) btnBack.onclick = () => this.closeScreen();
      const btnReload = document.getElementById('btn-recovery-reload');
      if (btnReload) btnReload.onclick = () => this.openScreen();
    }
  };

  window.Recovery = Recovery;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Recovery.bindEvents());
  } else {
    Recovery.bindEvents();
  }
})();
