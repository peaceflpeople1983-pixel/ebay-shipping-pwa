/**
 * メインのUIロジック (v3.16)
 *
 * v3.16 追加機能:
 *  - ピックアップシート印刷 (A4縦・1商品1ページ・黒字のみ)
 *  - バルク印刷: 未発送 + CPaSS取込済 + 印刷済でない注文を一括印刷
 *  - 個別印刷 / 印刷済解除: 注文カード長押しメニュー
 *  - 🖨 印刷済 バッジ表示 (リストから非表示にしない)
 *  - Amazon商品名表示 (PA-API 連携・キャッシュ付き)
 *
 * v3.15 追加機能:
 *  - 注文一覧の上部に CPaSS バナー (Inbox 取込待機 / 未取込警告)
 *  - [📥 取込実行] ボタンで PWA から直接 Apps Script の取込を実行
 *  - 注文カードに ⚠ CPaSS未取込 警告バッジ
 *  - 発送情報入力画面に ⚠ CPaSS 未取込警告
 *  - Apps Script の getOrders レスポンスの cpass_status を読む
 *
 * v3.14 追加機能:
 *  - CPaSS パッケージ番号 / ASIN の表示
 *    注文カードに 📦 CPaSS#xxxx と 🛒 Amazon.co.jp 直リンクを追加
 *    Apps Script の getOrders が返す order.cpass を使用
 *
 * v3.7 追加機能:
 *  - 数値入力用フローティングツールバー（◀前へ／次へ▶／完了）
 *    iPhone数値キーパッドの「次へ」キー欠如を補い、キーボード上にカスタムバー表示
 *  - 入力画面を開いた時、重量フィールドへ自動フォーカス
 *  - 最終フィールド(高)で「次へ▶」が「完了▶」に切り替わる
 *
 * v3.5 機能（継続）:
 *  - フォーカス時の既存値自動全選択
 *  - 入力画面のアカウントカードに商品サムネ表示
 *  - 同期時の新規注文に Browse API で画像URL自動付与（バックエンド側）
 */
const App = {
  state: {
    masterData: null,
    orders: [],
    currentOrder: null,
    currentInput: null,
    currentResult: null,
    selectedCarrierIndex: 0,
    recentCountries: [],
    pendingWrites: 0,
    batchScanActive: false,
    cpassStatus: null,  // v3.15: { inbox_pending_count, unimported_count, unimported_orders }
    // v3.16: 印刷関連
    bulkPrintCount: 0,
    bulkPrintTargets: [],
    printPreviewOrders: [],
    longPressOrderId: null,
    _longPressTimer: null,
    _longPressTriggered: false
  },

  async init() {
    // 設定画面のボタンは常にバインド（後で歯車アイコンから設定変更したい時のため）
    this.bindSetup();
    if (!API.loadConfig()) {
      this.show('screen-setup');
      return;
    }
    this.bindAll();
    await this.loadAll();
  },

  show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  },

  bindSetup() {
    const saveBtn = document.getElementById('btn-save-config');
    if (saveBtn) {
      // 視覚的バインド完了マーカー（緑色に変更でハンドラ設定済みと判別可能）
      saveBtn.style.background = '#0F6E56';
      saveBtn.textContent = '✓ 保存して開始';
      saveBtn.onclick = async () => {
        showToast('保存処理を開始しています...');
        const url = document.getElementById('cfg-api-url').value.trim();
        const secret = document.getElementById('cfg-secret').value.trim();
        if (!url) return showToast('Web App URLを入力してください');
        API.saveConfig(url, secret);
        this.bindAll();
        await this.loadAll();
      };
      // touchstart で iOS Safari の :active を確実に動かす + フォールバック
      saveBtn.addEventListener('touchstart', () => {
        saveBtn.style.opacity = '0.7';
      }, { passive: true });
      saveBtn.addEventListener('touchend', () => {
        saveBtn.style.opacity = '1';
      }, { passive: true });
    }

    const clearBtn = document.getElementById('btn-clear-cache');
    if (clearBtn) {
      clearBtn.textContent = '✓ マスタキャッシュをクリア';
      clearBtn.onclick = async () => {
        API.clearMasterCache();
        showToast('キャッシュをクリアしました');
        if (API.config.url) {
          this.bindAll();
          await this.loadAll();
        }
      };
      clearBtn.addEventListener('touchstart', () => {
        clearBtn.style.opacity = '0.7';
      }, { passive: true });
      clearBtn.addEventListener('touchend', () => {
        clearBtn.style.opacity = '1';
      }, { passive: true });
    }
  },

  /** 要素が存在する場合のみハンドラを設定（防御） */
  _bind(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) el[eventName] = handler;
  },

  bindAll() {
    try {
      this._bind('btn-sync', 'onclick', () => this.sync());
      this._bind('btn-settings', 'onclick', () => this.show('screen-setup'));
      this._bind('btn-new', 'onclick', () => this.openInput(null));
      this._bind('filter-account', 'onchange', () => this.renderOrders());
      this._bind('filter-hide-done', 'onchange', () => this.renderOrders());
      this._bind('filter-hide-shipped', 'onchange', () => this.renderOrders());
      // v3.17: 発送期日フィルタ
      this._bind('filter-overdue-only', 'onchange', () => this.renderOrders());
      this._bind('filter-urgent-only', 'onchange', () => this.renderOrders());
      // ★ v1.0 キャンセル通知: キャンセル済隠すフィルタ
      this._bind('filter-hide-cancel', 'onchange', () => this.renderOrders());

      this._bind('btn-back-list', 'onclick', () => this.goHome());
      this._bind('btn-back-input', 'onclick', () => this.show('screen-input'));
      this._bind('btn-home-input', 'onclick', () => this.goHome());
      this._bind('btn-home-result', 'onclick', () => this.goHome());

      this._bind('btn-calculate', 'onclick', () => this.calculate());
      this._bind('btn-confirm', 'onclick', () => this.confirmShipment());

      this._bind('btn-ocr', 'onclick', () => {
        OCR.setKnownOrders(this.state.orders);
        OCR.open(orderId => {
          const el = document.getElementById('input-order-id');
          if (el) el.value = orderId;
        });
      });
      this._bind('btn-scan-list', 'onclick', () => {
        this.state.batchScanActive = false;
        OCR.setKnownOrders(this.state.orders);
        OCR.open(orderId => this.handleScanFromList(orderId));
      });

      // v3.15: CPaSS 取込実行ボタン
      this._bind('btn-cpass-import', 'onclick', () => this.runCpassImport());

      // v3.16: 印刷機能
      this._bind('btn-bulk-print', 'onclick', () => this.openBulkPrint());
      this._bind('btn-back-print', 'onclick', () => this.goHome());
      this._bind('btn-home-print', 'onclick', () => this.goHome());
      this._bind('btn-print-cancel', 'onclick', () => this.goHome());
      this._bind('btn-print-do', 'onclick', () => this.doBrowserPrint());
      this._bind('btn-print-mark', 'onclick', () => this.markPrintedAndReturn());
      this._bind('card-action-print', 'onclick', () => this.openIndividualPrint(this.state.longPressOrderId));
      this._bind('card-action-unmark', 'onclick', () => this.unmarkPrintedAndReload(this.state.longPressOrderId));
      // ★ Phase B: 発送済にする / 解除 (表示フラグのみ・eBay非送信)
      this._bind('card-action-ship', 'onclick', () => this.markShippedAndReload(this.state.longPressOrderId, true));
      this._bind('card-action-unship', 'onclick', () => this.markShippedAndReload(this.state.longPressOrderId, false));
      // ★ 手動キャンセル: キャンセル済にする / 解除 (表示フラグのみ・eBay非送信)
      this._bind('card-action-cancelmark', 'onclick', () => this.markCancelledAndReload(this.state.longPressOrderId, true));
      this._bind('card-action-uncancelmark', 'onclick', () => this.markCancelledAndReload(this.state.longPressOrderId, false));
      this._bind('card-action-cancel', 'onclick', () => this.closeCardActionMenu());

      this._bind('btn-batch-scan', 'onclick', () => this.startBatchScan());
      this._bind('btn-today-clear', 'onclick', () => {
        if (confirm('本日の作業グループをクリアしますか？（発送履歴は残ります）')) {
          TodayGroup.clear();
          this.renderOrders();
          showToast('本日グループをクリアしました');
        }
      });

      this._bind('btn-ocr-cancel', 'onclick', () => {
        this.state.batchScanActive = false;
        OCR.keepOpen = false;
        OCR.close();
        this.renderOrders();
      });
      this._bind('btn-ocr-capture', 'onclick', () => OCR.capture());

      // 数値入力用フローティングツールバー（重量→長→幅→高、最終フィールドで完了）
      this.bindNumericToolbar();
    } catch (err) {
      console.error('bindAll error:', err);
      showToast('初期化エラー: ' + err.message);
    }
  },

  NUMERIC_CHAIN: ['input-weight', 'input-length', 'input-width', 'input-height'],

  /**
   * 数値入力用フローティングツールバーをバインド。
   * iPhone数値キーパッドには「次へ」キーが構造的に無いため、
   * キーボードの上にカスタムバー[◀前へ][次へ▶][完了]を表示する。
   * - 最終フィールド(高)では[次へ▶]が[完了▶]に変化し、計算を実行
   * - PCではEnterキーでも同じ挙動
   * - フォーカス時に既存値を全選択
   */
  bindNumericToolbar() {
    const toolbar = document.getElementById('kb-toolbar');
    const prevBtn = document.getElementById('kb-prev');
    const nextBtn = document.getElementById('kb-next');
    const doneBtn = document.getElementById('kb-done');
    if (!toolbar || !prevBtn || !nextBtn || !doneBtn) return;
    const chain = this.NUMERIC_CHAIN;

    // ===== ツールバーをキーボードの真上に固定するための VisualViewport 連動 =====
    // iOS Safari は position:fixed bottom:0 がキーボード裏に隠れるため、
    // 見えている領域（visualViewport）の下端に合わせて動的に top を設定する
    const syncPosition = () => {
      const vv = window.visualViewport;
      if (!vv) {
        // 古いブラウザ向けフォールバック（CSS の bottom:0 任せ）
        toolbar.style.top = '';
        toolbar.style.bottom = '0';
        toolbar.style.width = '';
        toolbar.style.left = '';
        return;
      }
      const tbHeight = toolbar.offsetHeight || 60;
      toolbar.style.top = (vv.offsetTop + vv.height - tbHeight) + 'px';
      toolbar.style.bottom = 'auto';
      toolbar.style.left = vv.offsetLeft + 'px';
      toolbar.style.width = vv.width + 'px';
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncPosition);
      window.visualViewport.addEventListener('scroll', syncPosition);
    }
    window.addEventListener('resize', syncPosition);
    window.addEventListener('orientationchange', () => setTimeout(syncPosition, 100));

    // 最後にフォーカスされていた数値フィールドのインデックスを保持
    // （ボタンタップ時に activeElement が body 等になるため、これを信頼ソースに使う）
    let lastFocusedIdx = -1;

    const updateToolbar = () => {
      const active = document.activeElement;
      const idx = active ? chain.indexOf(active.id) : -1;
      if (idx !== -1) lastFocusedIdx = idx;
      const effectiveIdx = (idx !== -1) ? idx : lastFocusedIdx;
      if (effectiveIdx === -1) {
        toolbar.classList.add('hidden');
        return;
      }
      toolbar.classList.remove('hidden');
      prevBtn.disabled = (effectiveIdx === 0);
      // 最終フィールドでは「次へ」→「完了」に切り替え
      if (effectiveIdx === chain.length - 1) {
        nextBtn.textContent = '完了 ▶';
      } else {
        nextBtn.textContent = '次へ ▶';
      }
      // 表示直後に位置を強制再計算（キーボード展開アニメーション中も追従）
      requestAnimationFrame(syncPosition);
      setTimeout(syncPosition, 100);
      setTimeout(syncPosition, 300);
    };

    const focusByIndex = (idx) => {
      if (idx < 0 || idx >= chain.length) return;
      const el = document.getElementById(chain[idx]);
      if (!el) return;
      lastFocusedIdx = idx;
      el.focus();
      try { el.select(); } catch (_) {}
      updateToolbar();
    };

    // 各数値フィールドのフォーカス/ブラー監視
    chain.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', () => {
        lastFocusedIdx = idx;
        setTimeout(() => { try { el.select(); } catch (_) {} }, 0);
        updateToolbar();
      });
      // PCでのEnterキーフォールバック
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (idx === chain.length - 1) {
            el.blur();
            this.calculate();
          } else {
            focusByIndex(idx + 1);
          }
        }
      });
    });

    // 共通ボタンハンドラ。
    // iOS では touchstart で preventDefault するとクリックも止まるので、
    // touchstart で直接アクションを起こし、その後の click 重複発火はフラグでブロック。
    const wireButton = (btn, action) => {
      let touchHandled = false;
      btn.addEventListener('touchstart', (e) => {
        // フォーカスを失わせず、即時アクション実行
        e.preventDefault();
        touchHandled = true;
        action();
      }, { passive: false });
      btn.addEventListener('click', () => {
        if (touchHandled) {
          touchHandled = false;
          return;
        }
        action();
      });
    };

    wireButton(prevBtn, () => {
      if (lastFocusedIdx > 0) focusByIndex(lastFocusedIdx - 1);
    });

    wireButton(nextBtn, () => {
      if (lastFocusedIdx === -1) return;
      if (lastFocusedIdx === chain.length - 1) {
        // 最終フィールド → 計算実行
        const el = document.getElementById(chain[lastFocusedIdx]);
        if (el) el.blur();
        toolbar.classList.add('hidden');
        lastFocusedIdx = -1;
        this.calculate();
      } else {
        focusByIndex(lastFocusedIdx + 1);
      }
    });

    wireButton(doneBtn, () => {
      const idx = (lastFocusedIdx !== -1) ? lastFocusedIdx : (document.activeElement ? chain.indexOf(document.activeElement.id) : -1);
      if (idx !== -1) {
        const el = document.getElementById(chain[idx]);
        if (el) el.blur();
      }
      toolbar.classList.add('hidden');
      lastFocusedIdx = -1;
      this.calculate();
    });
  },

  goHome() {
    this.show('screen-list');
    this.renderOrders();
    if (this.state.pendingWrites > 0) {
      showToast('Sheetsへ書込み中... (' + this.state.pendingWrites + '件)');
    }
  },

  handleScanFromList(orderId) {
    const found = this.state.orders.find(o => o.orderId === orderId);
    if (found) {
      TodayGroup.add(orderId);
      this.openInput(orderId);
      showToast('注文を開きました：' + orderId);
    } else {
      showToast('注文ID ' + orderId + ' が見つかりません');
    }
  },

  startBatchScan() {
    this.state.batchScanActive = true;
    OCR.setKnownOrders(this.state.orders);
    showToast('連続スキャン開始：撮影 → 自動で次へ。完了したら「キャンセル」で終了');
    OCR.open(orderId => {
      const found = this.state.orders.find(o => o.orderId === orderId);
      if (found) {
        TodayGroup.add(orderId);
      } else {
        showToast('未マッチID：' + orderId);
      }
      this.renderOrders();
    }, { keepOpen: true });
  },

  async loadAll() {
    this.show('screen-list');
    this.setLoader(true);
    let step = 'init';
    try {
      step = 'localStorage';
      this.recentCountries = JSON.parse(localStorage.getItem('recent_countries') || '[]');
      step = 'getMasterData';
      this.state.masterData = await API.getMasterData();
      if (!this.state.masterData || !Array.isArray(this.state.masterData.countries) || this.state.masterData.countries.length < 10) {
        showToast('マスタデータ不完全。再取得します...');
        API.clearMasterCache();
        step = 'getMasterData(retry)';
        this.state.masterData = await API.getMasterData(true);
      }
      step = 'Calculator.setMaster';
      Calculator.setMaster(this.state.masterData);
      step = 'getOrders';
      const data = await API.getOrders(undefined, undefined, API.DEFAULT_DAYS_BACK);
      step = 'state assignment';
      this.state.orders = data.orders || [];
      this.state.cpassStatus = data.cpass_status || null;  // v3.15
      // ★ RECOVERY: 未取得 order 件数バッジ更新
      if (window.Recovery && typeof Recovery.setCount === 'function') {
        Recovery.setCount(data.recovery_missing_count || 0);
      }
      step = 'pruneTodayGroup';
      this.pruneTodayGroup();
      step = 'populateCountrySelect';
      this.populateCountrySelect();
      step = 'renderOrders';
      this.renderOrders();
      step = 'updateCpassBanner';
      this.updateCpassBanner();  // v3.15
      step = 'updateBulkPrintBadge';
      this.updateBulkPrintBadge();  // v3.16
      // ★ キャンセル通知 v1.0: バナー + バッジ更新
      step = 'CancelNotice.refresh';
      if (window.CancelNotice && typeof CancelNotice.refresh === 'function') {
        await CancelNotice.refresh();
        this.renderOrders();  // バッジ反映のために再描画
      }
    } catch (err) {
      try { console.error('loadAll failed at step:', step, err); } catch (_) {}
      const msg = (err && err.message) ? err.message : String(err);
      showToast('読み込みエラー[' + step + ']: ' + msg);
    } finally {
      this.setLoader(false);
    }
  },

  pruneTodayGroup() {
    const g = TodayGroup.load();
    if (!g.ids.length) return;
    const done = new Set(this.state.orders.filter(o => o.selectedCarrier).map(o => o.orderId));
    let removed = 0;
    g.ids.forEach(id => {
      if (done.has(id)) { TodayGroup.remove(id); removed++; }
    });
    if (removed > 0) showToast(removed + '件の発送完了を本日グループから除外しました');
  },

  setLoader(show) {
    document.getElementById('list-loader').classList.toggle('hidden', !show);
  },

  populateCountrySelect() {
    const sel = document.getElementById('input-country');
    sel.innerHTML = '';
    const all = (this.state.masterData && this.state.masterData.countries) || [];
    if (!all.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '国マスタが読み込めません';
      sel.appendChild(o);
      return;
    }
    const recent = this.recentCountries
      .map(c => all.find(a => a.code === c))
      .filter(Boolean)
      .slice(0, 10);
    if (recent.length > 0) {
      const og = document.createElement('optgroup');
      og.label = '最近使った国';
      recent.forEach(c => {
        const o = document.createElement('option');
        o.value = c.code; o.textContent = c.name + ' (' + c.code + ')';
        og.appendChild(o);
      });
      sel.appendChild(og);
    }
    const og2 = document.createElement('optgroup');
    og2.label = 'すべての国（コード順）';
    all.slice().sort((a, b) => a.code.localeCompare(b.code)).forEach(c => {
      const o = document.createElement('option');
      o.value = c.code; o.textContent = c.name + ' (' + c.code + ')';
      og2.appendChild(o);
    });
    sel.appendChild(og2);
  },

  recordRecentCountry(code) {
    this.recentCountries = [code, ...this.recentCountries.filter(c => c !== code)].slice(0, 10);
    localStorage.setItem('recent_countries', JSON.stringify(this.recentCountries));
  },

  renderOrders() {
    try {
      this._renderOrdersImpl();
    } catch (err) {
      try { console.error('renderOrders failed:', err); } catch (_) {}
      const list = document.getElementById('order-list');
      if (list) {
        list.innerHTML = '<div class="empty">一覧描画エラー: ' +
          escapeHtml(String(err && err.message ? err.message : err)) +
          '<br><small>サポートに連絡してください</small></div>';
      }
    }
  },

  _renderOrdersImpl() {
    const filterAcc = document.getElementById('filter-account').value;
    const hideDone = document.getElementById('filter-hide-done').checked;
    // v3.13: 発送済（追跡番号あり）を隠すトグル。要素が無い古い HTML には防御的に対応
    const hideShippedEl = document.getElementById('filter-hide-shipped');
    const hideShipped = hideShippedEl ? hideShippedEl.checked : false;
    // v3.17: 発送期日フィルタ
    const overdueOnlyEl = document.getElementById('filter-overdue-only');
    const overdueOnly = overdueOnlyEl ? overdueOnlyEl.checked : false;
    const urgentOnlyEl = document.getElementById('filter-urgent-only');
    const urgentOnly = urgentOnlyEl ? urgentOnlyEl.checked : false;
    const list = document.getElementById('order-list');

    let orders = this.state.orders;
    if (filterAcc) orders = orders.filter(o => o.account === filterAcc);
    if (hideDone) orders = orders.filter(o => !o.selectedCarrier);
    if (hideShipped) orders = orders.filter(o => !(o.trackingNumber || o.fulfillmentStatus === 'FULFILLED'));
    // ★ v1.0 キャンセル通知: キャンセル済 (未印刷 + AP列マーク済) を隠す
    const hideCancelHistoryEl = document.getElementById('filter-hide-cancel');
    const hideCancelHistory = hideCancelHistoryEl ? hideCancelHistoryEl.checked : false;
    if (hideCancelHistory) {
      orders = orders.filter(o => !(o.cancelledAt && !o.printedAt));
    }
    // v3.17: 期限フィルタ (computeDeadlineMeta は完全防御化済み)
    if (overdueOnly) {
      const self = this;
      orders = orders.filter(function(o) {
        try {
          const m = self.computeDeadlineMeta(o.shipByDate);
          return m && m.level === 'red';
        } catch (e) { return false; }
      });
    }
    if (urgentOnly) {
      const self = this;
      orders = orders.filter(function(o) {
        try {
          const m = self.computeDeadlineMeta(o.shipByDate);
          return m && (m.level === 'red' || m.level === 'orange');
        } catch (e) { return false; }
      });
    }

    const todayBar = document.getElementById('today-bar');
    const todayCount = TodayGroup.count();
    if (todayCount > 0) {
      todayBar.classList.remove('hidden');
      document.getElementById('today-count').textContent = todayCount + '件';
    } else {
      todayBar.classList.add('hidden');
    }

    // v3.18.8: 発送期日警告バナーを更新 (フィルタに依らず全注文で集計)
    this._updateDeadlineBanner();

    if (orders.length === 0) {
      list.innerHTML = '<div class="empty">表示できる注文がありません<br>右上の⟳で同期するか、+で手動入力してください<br><span class="muted">（既定: 直近60日／入力済を隠す／発送済を隠す）</span></div>';
      return;
    }

    const todaySet = new Set(TodayGroup.load().ids);
    const sortedOrders = orders.slice().sort((a, b) => {
      const ta = todaySet.has(a.orderId) ? 0 : 1;
      const tb = todaySet.has(b.orderId) ? 0 : 1;
      return ta - tb;
    });

    list.innerHTML = sortedOrders.slice().reverse().map(o => {
      const inToday = todaySet.has(o.orderId);
      const hasUrl = o.imageUrl && String(o.imageUrl).indexOf('http') === 0;
      const thumbHtml = hasUrl
        ? `<img class="order-thumb" src="${escapeAttr(o.imageUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;order-thumb-placeholder&quot;>&#128230;</div>'">`
        : `<div class="order-thumb-placeholder">&#128230;</div>`;
      // v3.13: 発送済情報の組み立て
      const isShipped = !!(o.trackingNumber || o.fulfillmentStatus === 'FULFILLED');
      const shippedBadge = isShipped ? '<span class="badge shipped">✓ 発送済</span>' : '';
      // v3.15: CPaSS 未取込警告バッジ (発送済かつ未取込のみ)
      const cpassUnimportedBadge = o.cpass_unimported ? '<span class="badge cpass-unimported">⚠ CPaSS未取込</span>' : '';
      // v3.16: 印刷済バッジ
      const printedBadge = o.printedAt ? '<span class="badge printed">🖨 印刷済</span>' : '';
      // v3.17: 発送期日バッジ (緊急度4段階 + 期限不明)。発送済はバッジ非表示
      const deadlineBadge = (!isShipped) ? this._buildDeadlineBadge(o.shipByDate) : '';
      const shippingInfoHtml = isShipped ? `
          <div class="order-shipping-info">
            <div class="ship-date">📮 ${escapeHtml(this.formatShippedAt(o.shippedAt))} 発送</div>
            <div class="ship-tracking">${escapeHtml(o.trackingNumber)}</div>
          </div>` : '';

      // v3.18: 同梱関連の要素を組み立て
      const dk = this._buildDoukonElements(o);

      // OrderID 表示: 同梱代表/サブは枠付き、それ以外は素のテキスト
      const orderIdHtml = dk.idBoxHtml
        ? dk.idBoxHtml
        : `<div class="order-id">${escapeHtml(o.orderId)}</div>`;

      // ★ キャンセル通知 v1.0: バッジ + class 追記
      const cancelClass = (window.CancelNotice && CancelNotice.buildItemClass)
        ? CancelNotice.buildItemClass(o)
        : '';
      const cancelBadge = (window.CancelNotice && CancelNotice.buildBadge)
        ? CancelNotice.buildBadge(o)
        : '';
      // ★ RECOVERY: メール由来(仮) バッジ + class
      const recoveryClass = (window.Recovery && Recovery.buildItemClass)
        ? Recovery.buildItemClass(o)
        : '';
      const recoveryBadge = (window.Recovery && Recovery.buildBadge)
        ? Recovery.buildBadge(o)
        : '';

      return `
      <div class="order-item${inToday ? ' in-today' : ''}${isShipped ? ' shipped' : ''}${dk.itemClass}${cancelClass}${recoveryClass}" data-id="${escapeAttr(o.orderId)}" data-line-item-id="${escapeAttr(o.lineItemId || '')}">
        ${dk.bannerHtml}
        ${thumbHtml}
        <div class="order-body">
          <div class="order-head">
            <span class="badge acc-${escapeAttr(o.account)}">${escapeHtml(o.account)}</span>
            ${inToday ? '<span class="today-tag">本日</span>' : ''}
            ${o.selectedCarrier ? '<span class="badge done">確定</span>' : ''}
            ${shippedBadge}
            ${cpassUnimportedBadge}
            ${printedBadge}
            ${cancelBadge}
            ${recoveryBadge}
            ${dk.badgeHtml}
            ${dk.subTagHtml}
            ${deadlineBadge}
          </div>
          ${dk.warningBarHtml}
          ${orderIdHtml}
          <div class="order-meta">${escapeHtml(o.country || '?')} / ${escapeHtml(o.itemTitle || '')}</div>
          ${o.selectedCarrier ? `<div class="order-cost">${escapeHtml(o.selectedCarrier)} ¥${o.shippingCost}</div>` : ''}
          ${shippingInfoHtml}
          ${this.renderCpassInfo(o.cpass)}
          ${dk.breakdownHtml}
        </div>
      </div>`;
    }).join('');

    // v3.16: 長押し対応 + 通常クリック
    list.querySelectorAll('.order-item').forEach(el => {
      const orderId = el.dataset.id;
      this._bindCardLongPress(el, orderId);
    });
  },

  /**
   * v3.16: カードの長押し検出 (500ms) + 通常クリック
   * - 長押し: 個別印刷/印刷済解除メニューを開く
   * - 通常クリック: 入力画面へ
   */
  _bindCardLongPress(el, orderId) {
    const LONG_MS = 500;
    let pressTimer = null;
    let triggered = false;
    let startY = 0;

    const cleanup = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    const handleStart = (clientY) => {
      triggered = false;
      startY = clientY;
      pressTimer = setTimeout(() => {
        triggered = true;
        if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {}
        this.showCardActionMenu(orderId);
      }, LONG_MS);
    };
    const handleMove = (clientY) => {
      if (Math.abs(clientY - startY) > 10) cleanup();
    };
    const handleEnd = () => {
      cleanup();
      // triggered フラグは showCardActionMenu 内で参照される
    };

    // Touch
    el.addEventListener('touchstart', (e) => handleStart(e.touches[0].clientY), { passive: true });
    el.addEventListener('touchmove', (e) => handleMove(e.touches[0].clientY), { passive: true });
    el.addEventListener('touchend', handleEnd, { passive: true });
    el.addEventListener('touchcancel', cleanup, { passive: true });

    // Mouse (PC)
    el.addEventListener('mousedown', (e) => handleStart(e.clientY));
    el.addEventListener('mousemove', (e) => { if (pressTimer) handleMove(e.clientY); });
    el.addEventListener('mouseup', handleEnd);
    el.addEventListener('mouseleave', cleanup);

    // 右クリック (PC) でも長押しメニューを開く
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      triggered = true;
      this.showCardActionMenu(orderId);
    });

    // クリック: 長押しでなければ openInput
    el.addEventListener('click', (e) => {
      if (triggered) {
        triggered = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      TodayGroup.add(orderId);
      this.openInput(orderId);
    });
  },

  openInput(orderId) {
    let order = orderId ? this.state.orders.find(o => o.orderId === orderId) : null;
    this.state.currentOrder = order;
    document.getElementById('input-account').textContent = order ? order.account : '（手動入力）';

    // サムネ画像＋商品名（index.htmlが旧版なら要素なし→スキップ）
    const thumbWrap = document.getElementById('input-thumb-wrap');
    const titleEl = document.getElementById('input-item-title');
    const hasUrl = order && order.imageUrl && String(order.imageUrl).indexOf('http') === 0;
    if (thumbWrap) {
      if (hasUrl) {
        thumbWrap.innerHTML = `<img src="${escapeAttr(order.imageUrl)}" alt="" onerror="this.outerHTML='<div class=&quot;order-thumb-placeholder&quot;>&#128230;</div>'">`;
      } else {
        thumbWrap.innerHTML = '<div class="order-thumb-placeholder">&#128230;</div>';
      }
    }
    if (titleEl) titleEl.textContent = (order && order.itemTitle) ? order.itemTitle : '';

    document.getElementById('input-order-id').value = order ? order.orderId : '';
    document.getElementById('input-country').value = order ? order.country : '';

    // v3.14/v3.15: CPaSS パッケージ番号 または 未取込警告 (発送先国と梱包後重量の間)
    const cpassRow = document.getElementById('input-cpass-row');
    const cpassNo = document.getElementById('input-cpass-no');
    const cpassWarning = document.getElementById('input-cpass-warning');
    if (cpassRow && cpassNo) {
      if (order && order.cpass && order.cpass.package_no) {
        // 取込済み: パッケージ番号表示
        cpassNo.textContent = order.cpass.package_no;
        cpassRow.classList.remove('hidden');
        if (cpassWarning) cpassWarning.classList.add('hidden');
      } else if (order && order.cpass_unimported) {
        // v3.15: 未取込: 警告表示
        cpassRow.classList.add('hidden');
        if (cpassWarning) cpassWarning.classList.remove('hidden');
      } else {
        // どちらも該当しない: 両方非表示
        cpassRow.classList.add('hidden');
        if (cpassWarning) cpassWarning.classList.add('hidden');
      }
    }

    // v3.12: order.weightG は実際は kg 単位（Apps Script の getOrders が I列=weightKg を weightG 名で返している）
    // 入力欄は g 単位なので kg→g 変換。1未満なら kg と判断して1000倍、それ以上ならそのまま g として扱う
    const wRaw = order && order.weightG;
    let wG = '';
    if (typeof wRaw === 'number' && wRaw > 0) {
      wG = (wRaw < 10) ? Math.round(wRaw * 1000) : Math.round(wRaw);
    }
    document.getElementById('input-weight').value = wG;
    document.getElementById('input-length').value = order && order.lengthCm ? order.lengthCm : '';
    document.getElementById('input-width').value = order && order.widthCm ? order.widthCm : '';
    document.getElementById('input-height').value = order && order.heightCm ? order.heightCm : '';
    document.getElementById('input-title').textContent = order ? '発送情報入力' : '手動入力';
    const tariffCard = document.getElementById('input-tariff-card');
    if (order && order.country === 'US' && (order.customsName || order.hsCode)) {
      tariffCard.classList.remove('hidden');
      document.getElementById('t-customs-name').textContent = order.customsName || '—';
      document.getElementById('t-hs-code').textContent = order.hsCode || '—';
      document.getElementById('t-tariff-rate').textContent = order.tariffRate ? order.tariffRate.toFixed(1) + '%' : '0.0%';
    } else {
      tariffCard.classList.add('hidden');
    }
    this.show('screen-input');
    // 重量フィールドへ自動フォーカス（既存値があれば全選択でそのまま上書き可能）
    const wf = document.getElementById('input-weight');
    if (wf) {
      try {
        wf.focus();
        wf.select();
      } catch (_) {}
    }
  },

  _readNum(id) {
    let raw = String(document.getElementById(id).value || '').trim();
    raw = raw.replace(/[０-９．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    raw = raw.replace(/[,\s]/g, '');
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  },

  calculate() {
    const order = this.state.currentOrder;
    const country = document.getElementById('input-country').value;
    let weightG = this._readNum('input-weight');
    const lengthCm = this._readNum('input-length');
    const widthCm = this._readNum('input-width');
    const heightCm = this._readNum('input-height');

    if (!country) return showToast('発送先国を選択してください');

    // v3.12: 重量が極端に小さい（< 10g）場合は kg 入力と判断して救済
    if (weightG !== null && weightG > 0 && weightG < 10) {
      const corrected = Math.round(weightG * 1000);
      if (confirm(`重量「${weightG}」は kg 単位の入力ですか？\nOK で ${corrected}g に補正して計算します。`)) {
        weightG = corrected;
        document.getElementById('input-weight').value = weightG;
      }
    }

    const missing = [];
    if (!weightG || weightG <= 0) missing.push('重量');
    if (!lengthCm || lengthCm <= 0) missing.push('長');
    if (!widthCm || widthCm <= 0) missing.push('幅');
    if (!heightCm || heightCm <= 0) missing.push('高');
    if (missing.length) {
      console.log('[Validation NG]', { country, weightG, lengthCm, widthCm, heightCm });
      return showToast(missing.join('・') + ' が未入力または0です');
    }

    const input = {
      country: country,
      weightG: Math.round(weightG),
      lengthCm: lengthCm,
      widthCm: widthCm,
      heightCm: heightCm,
      itemPriceUSD: order ? order.itemPrice : 0,
      tariffRate: order ? order.tariffRate : 0
    };
    this.state.currentInput = input;
    const result = Calculator.calculate(input);
    this.state.currentResult = result;
    this.state.selectedCarrierIndex = 0;
    this.recordRecentCountry(input.country);
    this.renderResult(result);
    this.show('screen-result');
  },

  renderResult(result) {
    document.getElementById('m-actual').textContent = result.context.actualG + ' g';
    document.getElementById('m-vol8').textContent = result.context.vol8000G + ' g';
    document.getElementById('m-vol5').textContent = result.context.vol5000G + ' g';
    document.getElementById('m-country').textContent = result.context.country;

    const list = document.getElementById('result-list');
    if (result.candidates.length === 0) {
      list.innerHTML = '<div class="empty">利用可能な発送方法がありません<br>サイズ・重量を確認してください</div>';
      document.getElementById('btn-confirm').classList.add('hidden');
      return;
    }
    // v3.10: shipping policy に応じた推奨ハイライトの算出
    const order = this.state.currentOrder;
    const shippingPolicy = order ? order.shippingPolicy : '';
    const recommendedTypes = this.getRecommendedCarrierTypes(shippingPolicy);
    const hintHtml = (recommendedTypes.length > 0)
      ? '<div class="shipping-hint"><b>ゴールド色のカード</b>から安い方を選択</div>'
      : '';

    const legendHtml = `
      <div class="legend">
        <div class="legend-item"><span class="carrier-circle c-epacket"></span>ePacketライト</div>
        <div class="legend-item"><span class="carrier-circle c-eco"></span>SpeedPAK Eco</div>
        <div class="legend-item"><span class="carrier-circle c-dhl"></span>Ship via DHL</div>
        <div class="legend-item"><span class="carrier-circle c-fedex"></span>Ship via FedEx</div>
      </div>
    `;
    list.innerHTML = hintHtml + legendHtml + result.candidates.map((c, i) => {
      const colorClass = this.getCarrierColorClass(c.carrier);
      const carrierShort = this.shortenCarrier(c.carrier);
      const trackingNote = [c.tracking ? '追跡あり' : '', c.insurance ? '補償あり' : ''].filter(Boolean).join('・');
      const isRecommended = this.isRecommendedCarrier(c.carrier, recommendedTypes);

      let breakdownHtml = '';
      if (c.tariffBuyer > 0 && c.tariffSeller === 0) {
        breakdownHtml = `
          <span>送料のみ</span>
          <span class="buyer-badge">関税¥${c.tariffBuyer.toLocaleString()} 買い手負担</span>
        `;
      } else {
        const parts = [`送料 ¥${c.basicCost.toLocaleString()}`];
        if (c.tariffSeller > 0) parts.push(`+ 関税 ¥${c.tariffSeller.toLocaleString()}`);
        if (c.usFees > 0) parts.push(`+ 通関費 ¥${c.usFees.toLocaleString()}`);
        if (c.surcharge > 0) parts.push(`+ サーチャージ ¥${c.surcharge.toLocaleString()}`);
        breakdownHtml = parts.map(p => `<span>${escapeHtml(p)}</span>`).join('');
      }

      return `
        <div class="result-card${isRecommended ? ' recommended' : ''}" data-idx="${i}">
          <div class="card-header">
            <span class="carrier-circle ${colorClass}"></span>
            <span class="carrier-name">${escapeHtml(carrierShort)}</span>
            ${i === 0 ? '<span class="recommend-badge">最安</span>' : ''}
          </div>
          <div class="card-main">
            <div class="card-info">
              ${escapeHtml(c.detail)}・${(c.billableG/1000).toFixed(2)}kg<br>
              ${escapeHtml(c.estimatedDays)}${trackingNote ? '・' + escapeHtml(trackingNote) : ''}
            </div>
            <div class="card-price-big">¥${c.totalCost.toLocaleString()}</div>
          </div>
          <div class="card-breakdown">
            ${breakdownHtml}
          </div>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.result-card').forEach(el => {
      el.onclick = () => {
        list.querySelectorAll('.result-card').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        this.state.selectedCarrierIndex = parseInt(el.dataset.idx, 10);
      };
    });
    const first = list.querySelector('.result-card');
    if (first) first.classList.add('selected');
    document.getElementById('btn-confirm').classList.remove('hidden');

    if (result.context.tariffJPY > 0) {
      const order = this.state.currentOrder;
      const hsCode = order ? order.hsCode : '';
      const itemPrice = order ? order.itemPrice : 0;
      const summary = document.createElement('div');
      summary.className = 'tariff-summary';
      summary.innerHTML = `
        <div class="left">
          <div class="label">米国関税概算</div>
          <div class="detail">HS ${escapeHtml(hsCode || '?')} / 税率 ${result.context.tariffRate.toFixed(1)}% / 価格 $${itemPrice}</div>
        </div>
        <div class="right">¥${result.context.tariffJPY.toLocaleString()}</div>
      `;
      list.appendChild(summary);
    }

    // v3.11: 除外された配送会社と理由を末尾に表示（デバッグ可視化）
    if (result.excluded && result.excluded.length > 0) {
      const exDiv = document.createElement('div');
      exDiv.className = 'excluded-info';
      exDiv.innerHTML = '<div class="excluded-title">候補外（理由）</div>' +
        result.excluded.map(e =>
          `<div class="excluded-row">・<b>${escapeHtml(e.name)}</b>: ${escapeHtml(e.reason)}</div>`
        ).join('');
      list.appendChild(exDiv);
    }
  },

  getCarrierColorClass(carrier) {
    if (carrier.indexOf('ePacket') !== -1) return 'c-epacket';
    if (carrier.indexOf('Ship via DHL') !== -1) return 'c-dhl';
    if (carrier.indexOf('Ship via FedEx') !== -1) return 'c-fedex';
    if (carrier.indexOf('SpeedPAK Economy') !== -1) return 'c-eco';
    return 'c-eco';
  },

  /**
   * v3.10: shipping policy から推奨する配送会社タイプ群を返す
   * v3.17.6: DHL/FedEx は既知の全 shipping policy で常時推奨表示する
   *   policy 固有の推奨キャリア + DHL + FedEx を返す
   * 戻り値:
   *   ['speedpak','dhl','fedex']     → eBay SpeedPAK Economy
   *   ['dhl','fedex']                → Expedited International Shipping / eBay SpeedPAK Expedited
   *   ['epacket','dhl','fedex']      → Economy International Shipping
   *   []                              → policy 不明・未定義 → ハイライトしない (現状維持)
   * 判定順序: SpeedPAK Economy（完全一致）→ Expedited（含む）→ Economy（含む）
   */
  getRecommendedCarrierTypes(shippingPolicy) {
    const policy = String(shippingPolicy || '');
    if (policy === 'eBay SpeedPAK Economy') return ['speedpak', 'dhl', 'fedex'];
    if (policy.indexOf('Expedited') !== -1) return ['dhl', 'fedex'];
    if (policy.indexOf('Economy') !== -1) return ['epacket', 'dhl', 'fedex'];
    return [];
  },

  /** v3.10: carrier 名と推奨タイプ群から、ハイライト対象か判定 */
  isRecommendedCarrier(carrier, types) {
    if (!types || types.length === 0) return false;
    const c = String(carrier || '');
    if (types.indexOf('epacket') !== -1 && c.indexOf('ePacket') !== -1) return true;
    if (types.indexOf('speedpak') !== -1 && c.indexOf('SpeedPAK Economy') !== -1) return true;
    if (types.indexOf('dhl') !== -1 && c.indexOf('Ship via DHL') !== -1) return true;
    if (types.indexOf('fedex') !== -1 && c.indexOf('Ship via FedEx') !== -1) return true;
    return false;
  },

  /**
   * v3.13: 発送日 "YYYY-MM-DD" → "M/D" 形式に整形
   * 不正な値や空はそのまま返す（カードで表示しないかは呼び出し元判断）
   */
  formatShippedAt(s) {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(s);
    return parseInt(m[2], 10) + '/' + parseInt(m[3], 10);
  },

  /**
   * v3.17: shipByDate (ISO 8601 UTC) を JST に変換し、緊急度メタデータを返す
   * v3.17.7: iOS Safari の任意例外 (RangeError "The string did not match...") を完全に捕捉
   * 戻り値: { date: Date|null, level: 'red'|'orange'|'yellow'|'green'|'gray',
   *           label: string ("5/22(金) 23:59" / "期限不明"), hoursLeft: number|null }
   */
  computeDeadlineMeta(shipByDate) {
    var grayResult = { date: null, level: 'gray', label: '期限不明', hoursLeft: null };
    try {
      if (shipByDate == null || shipByDate === '') return grayResult;
      // 型安全変換: 文字列でない値も String() 化、空白も除去
      var s;
      try { s = String(shipByDate).trim(); } catch (e1) { return grayResult; }
      if (!s) return grayResult;
      // iOS Safari 互換: "YYYY-MM-DD HH:MM:SS" や "YYYY/MM/DD HH:MM" を ISO に整形
      // (Apps Script の Sheets セルが日時として返ってきた場合のフォールバック)
      var normalized = s
        .replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3')   // YYYY/MM/DD → YYYY-MM-DD
        .replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/, '$1-$2-$3T$4:$5:$6Z'); // space→T
      var d;
      try { d = new Date(normalized); } catch (e2) { return grayResult; }
      var t;
      try { t = d && d.getTime ? d.getTime() : NaN; } catch (e3) { return grayResult; }
      if (!t || isNaN(t)) return grayResult;
      var now = new Date();
      var hoursLeft = (t - now.getTime()) / (1000 * 60 * 60);
      // v3.18.8: 残りカレンダー日数(JST)ベースの4段階＋無色
      //  JSTの暦日番号で差分を取る (時刻ではなく「日付」で残り日数を判定)
      var jstDay = function (dateObj) {
        return Math.floor((dateObj.getTime() + 9 * 3600 * 1000) / (24 * 3600 * 1000));
      };
      var daysLeft = jstDay(d) - jstDay(now);
      // 仕様: ≥8日=無色(none) / 7日=green / 6-5=yellow / 4-3=orange / 2-1=red / 当日(0)=red / 超過=red
      var level;
      if (daysLeft >= 8) level = 'none';
      else if (daysLeft === 7) level = 'green';
      else if (daysLeft >= 5) level = 'yellow';   // 6,5
      else if (daysLeft >= 3) level = 'orange';   // 4,3
      else level = 'red';                          // 2,1,0,超過
      var label;
      try { label = this._formatDeadlineJst(d); } catch (e4) { label = '期限不明'; }
      return { date: d, level: level, label: label, hoursLeft: hoursLeft, daysLeft: daysLeft };
    } catch (e) {
      try { console.warn('computeDeadlineMeta error:', e && e.message ? e.message : e, 'input:', shipByDate); } catch (_) {}
      return grayResult;
    }
  },

  /**
   * v3.17: Date を JST の "M/D(曜) HH:MM" に整形 (例: "5/22(金) 23:59")
   * v3.17.7: 完全例外捕捉 (Invalid Date のメソッド呼出も安全に)
   */
  _formatDeadlineJst(d) {
    try {
      if (!d || !d.getTime) return '';
      var t = d.getTime();
      if (isNaN(t)) return '';
      var jst = new Date(t + 9 * 60 * 60 * 1000);
      var jt = jst.getTime();
      if (isNaN(jt)) return '';
      var M = jst.getUTCMonth() + 1;
      var D = jst.getUTCDate();
      var h = jst.getUTCHours();
      var m = jst.getUTCMinutes();
      var youbi = ['日','月','火','水','木','金','土'][jst.getUTCDay()];
      var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
      return M + '/' + D + '(' + youbi + ') ' + pad(h) + ':' + pad(m);
    } catch (e) {
      return '';
    }
  },

  /**
   * v3.18: 同梱グループラベル (A/B/C/D/E) → 色定義
   */
  _doukonColors: {
    A: { bg: '#E3DCFB', fg: '#2E2280', border: '#C5B9F2' }, // Indigo
    B: { bg: '#FCE0EC', fg: '#7A1247', border: '#F4C0D1' }, // Magenta
    C: { bg: '#DAEAFB', fg: '#0C447C', border: '#85B7EB' }, // Blue
    D: { bg: '#F0E5D3', fg: '#5C3A0E', border: '#C9A86E' }, // Sand
    E: { bg: '#DBF0F2', fg: '#0E5460', border: '#7AC0CC' }  // Cyan
  },

  /**
   * v3.18: 同梱カードのHTML部品を一括で組み立て
   *  - 引数: order (doukonGroupLabel, doukonGroupSize, doukonRole, doukonGroupLeadId が必須)
   *  - 戻り値: { itemClass, bannerHtml, badgeHtml, subTagHtml, idBoxHtml, warningBarHtml, breakdownHtml }
   *  - 同梱なしの注文では空文字主体の安全な値を返す
   */
  _buildDoukonElements(o) {
    const empty = { itemClass: '', bannerHtml: '', badgeHtml: '', subTagHtml: '', idBoxHtml: '', warningBarHtml: '', breakdownHtml: '' };
    try {
      if (!o || !o.doukonGroupId || !o.doukonGroupLabel) return empty;
      const label = String(o.doukonGroupLabel);
      const role = String(o.doukonRole || '');
      const isLead = role === 'lead';
      const isSub = role === 'sub';
      const groupSize = parseInt(o.doukonGroupSize, 10) || 0;
      const colors = this._doukonColors[label] || this._doukonColors.A;
      const isPattern2 = String(o.doukonGroupId).indexOf('P2-') === 0;
      const leadOrderId = String(o.doukonGroupLeadId || '');

      // 1) カードに付与するクラス（左ボーダー色＋背景）
      const itemClass = isLead
        ? ' doukon doukon-lead doukon-' + label.toLowerCase()
        : (isSub ? ' doukon doukon-sub' : '');

      // 2) 上部バナー
      const bannerLabel = isLead
        ? '📦 同梱グループ' + label + ' ・代表 ・' + groupSize + '点まとめて計測'
        : '📦 同梱グループ' + label + ' ・サブ ・計測不要 (代表へ)';
      const bannerStyle = isLead
        ? 'background:' + colors.bg + ';color:' + colors.fg + ';border:0.5px solid ' + colors.border + ';'
        : 'background:#ECECEC;color:#5A5A5A;border:0.5px solid #B4B2A9;';
      const bannerHtml = '<div class="doukon-banner" style="' + bannerStyle + '">' + escapeHtml(bannerLabel) + '</div>';

      // 3) 📦 同梱X×N バッジ
      const badgeStyle = 'background:' + colors.bg + ';color:' + colors.fg + ';';
      const badgeHtml = '<span class="badge doukon-badge" style="' + badgeStyle + '">📦 同梱' + escapeHtml(label) + ' ×' + groupSize + '</span>';

      // 4) サブタグ
      const subTagHtml = isSub
        ? '<span class="badge doukon-sub-tag">サブ' + (isPattern2 && leadOrderId ? ' → ' + escapeHtml(leadOrderId.substring(0, 8)) : '') + '</span>'
        : '';

      // 5) ORDER ID 枠: 代表=実線+モノスペース、サブ=破線+取消線
      let idBoxHtml = '';
      if (isLead) {
        idBoxHtml = '<div class="doukon-id-box doukon-id-lead">'
          + '<div class="doukon-id-label">📷 ORDER ID</div>'
          + '<div class="doukon-id-value">' + escapeHtml(o.orderId) + '</div>'
          + '</div>';
      } else if (isSub) {
        idBoxHtml = '<div class="doukon-id-box doukon-id-sub">'
          + '<div class="doukon-id-label">🚫 PICKUP REF</div>'
          + '<div class="doukon-id-value">' + escapeHtml(o.orderId) + '</div>'
          + '</div>';
      }

      // 6) パターン2サブの赤警告バー
      const warningBarHtml = (isSub && isPattern2 && leadOrderId)
        ? '<div class="doukon-warning-bar">⚠️ このOrderIDはスキャン対象外 ・代表は <strong>' + escapeHtml(leadOrderId) + '</strong></div>'
        : '';

      // 7) 同梱内訳ボックス（同グループの他メンバーをリスト）
      const breakdownHtml = this._buildDoukonBreakdown(o, colors, isPattern2, label);

      return {
        itemClass: itemClass,
        bannerHtml: bannerHtml,
        badgeHtml: badgeHtml,
        subTagHtml: subTagHtml,
        idBoxHtml: idBoxHtml,
        warningBarHtml: warningBarHtml,
        breakdownHtml: breakdownHtml
      };
    } catch (e) {
      try { console.warn('_buildDoukonElements failed:', e); } catch (_) {}
      return empty;
    }
  },

  /**
   * v3.18: 同梱内訳ボックスを構築
   *  - 同じ doukonGroupId に属する全注文（this.state.orders から）を列挙
   *  - 各行: 「商品名(短縮) 末尾4桁」+ 「本カード」or「代表」マーク
   */
  _buildDoukonBreakdown(o, colors, isPattern2, label) {
    try {
      const gid = o.doukonGroupId;
      if (!gid || !Array.isArray(this.state.orders)) return '';
      // 同グループのメンバー
      const members = this.state.orders.filter(x => x && x.doukonGroupId === gid);
      if (members.length === 0) return '';

      // 表示順: 代表→サブ。代表が複数いる場合はOrderId昇順
      members.sort((a, b) => {
        const ra = a.doukonRole === 'lead' ? 0 : 1;
        const rb = b.doukonRole === 'lead' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return String(a.orderId).localeCompare(String(b.orderId));
      });

      // 各行を HTML 化
      const rows = members.map((m, i) => {
        const isSelf = (m.orderId === o.orderId) && (String(m.lineItemId || '') === String(o.lineItemId || ''));
        const isLead = m.doukonRole === 'lead';
        const tail = String(m.orderId || '').slice(-4);
        const shortTitle = String(m.itemTitle || '').substring(0, 40);
        let tag = '';
        if (isSelf) tag = '<span class="dk-tag-self">本カード</span>';
        else if (isLead) tag = '<span class="dk-tag-lead">代表</span>';
        return '<div class="dk-breakdown-row">'
          + '<span class="dk-no">' + (i + 1) + '.</span> '
          + escapeHtml(shortTitle) + ' '
          + '<span class="dk-tail">末尾 ' + escapeHtml(tail) + '</span> '
          + tag
          + '</div>';
      }).join('');

      const headLabel = isPattern2
        ? '📦 同梱' + label + ' 内訳 (' + members.length + '点・別OrderID/同一買主)'
        : '📦 同梱' + label + ' 内訳 (' + members.length + '点・同一OrderID)';

      const buyerLine = (isPattern2 && o.buyerUsername)
        ? '<div class="dk-buyer">👤 buyer: <span class="dk-mono">' + escapeHtml(o.buyerUsername) + '</span></div>'
        : '';

      const style = 'background:' + colors.bg + ';border:0.5px solid ' + colors.border + ';color:' + colors.fg + ';';
      return '<div class="doukon-breakdown" style="' + style + '">'
        + '<div class="dk-breakdown-head">' + escapeHtml(headLabel) + '</div>'
        + buyerLine
        + rows
        + '</div>';
    } catch (e) {
      try { console.warn('_buildDoukonBreakdown failed:', e); } catch (_) {}
      return '';
    }
  },

  /**
   * v3.17: 一覧カード右上に表示する発送期日バッジHTMLを生成
   * v3.17.7: 完全防御 — 何があってもバッジを返す (空文字含む)
   */
  _buildDeadlineBadge(shipByDate) {
    try {
      var meta = this.computeDeadlineMeta(shipByDate);
      if (!meta) return '';
      // v3.18.8: 8日以上先(none)はバッジを出さない
      if (meta.level === 'none') return '';
      var cls = 'badge due-' + (meta.level || 'gray');
      var icon = '';
      if (meta.level === 'red') icon = '⛔ ';
      else if (meta.level === 'orange') icon = '⚠ ';
      var text;
      if (!meta.level || meta.level === 'gray') {
        text = '期限不明';
      } else if (meta.daysLeft != null && meta.daysLeft < 0) {
        // 超過(締切を過ぎた)は Red のまま「超過」表記で明示
        text = '期限超過 ' + (meta.label || '');
      } else {
        text = '期限 ' + (meta.label || '');
      }
      return '<span class="' + cls + '">' + icon + escapeHtml(text) + '</span>';
    } catch (e) {
      try { console.warn('_buildDeadlineBadge error:', e); } catch (_) {}
      return '';
    }
  },

  /**
   * v3.18.8: 発送期日警告バナーの表示制御
   *  - 残り7日以内(level: green/yellow/orange/red)の「未発送」注文が1件でもあれば表示
   *  - 同梱の重複を避けるため orderId 単位でユニークカウント
   *  - 最も緊急な状態(red>orange>yellow>green)に応じて文言を変える
   */
  _updateDeadlineBanner() {
    try {
      var banner = document.getElementById('deadline-banner');
      if (!banner) return;
      var orders = Array.isArray(this.state.orders) ? this.state.orders : [];
      var seen = {};
      var counts = { red: 0, orange: 0, yellow: 0, green: 0 };
      var total = 0;
      for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || o.trackingNumber || o.fulfillmentStatus === 'FULFILLED') continue;  // 発送済は対象外
        var oid = String(o.orderId || '');
        if (!oid || seen[oid]) continue;                  // orderId 単位でユニーク
        var meta;
        try { meta = this.computeDeadlineMeta(o.shipByDate); } catch (e) { meta = null; }
        if (!meta) continue;
        var lv = meta.level;
        if (lv === 'red' || lv === 'orange' || lv === 'yellow' || lv === 'green') {
          seen[oid] = true;
          counts[lv]++;
          total++;
        }
      }
      if (total === 0) {
        banner.classList.add('hidden');
        banner.classList.remove('urgent-red', 'urgent-orange', 'urgent-yellow', 'urgent-green');
        return;
      }
      // 最緊急レベルでバナー色・文言を決定
      var topLevel = counts.red ? 'red' : (counts.orange ? 'orange' : (counts.yellow ? 'yellow' : 'green'));
      var subText;
      if (counts.red) subText = '⛔ 期限間近/超過が ' + counts.red + '件あります';
      else if (counts.orange) subText = '⚠ 残り3〜4日が ' + counts.orange + '件あります';
      else if (counts.yellow) subText = '残り5〜6日が ' + counts.yellow + '件あります';
      else subText = '残り7日が ' + counts.green + '件あります';

      var countEl = document.getElementById('deadline-banner-count');
      var subEl = document.getElementById('deadline-banner-sub');
      if (countEl) countEl.textContent = total + '件';
      if (subEl) subEl.textContent = subText;
      banner.classList.remove('urgent-red', 'urgent-orange', 'urgent-yellow', 'urgent-green');
      banner.classList.add('urgent-' + topLevel);
      banner.classList.remove('hidden');
    } catch (e) {
      try { console.warn('_updateDeadlineBanner error:', e); } catch (_) {}
    }
  },

  shortenCarrier(carrier) {
    if (carrier.indexOf('ePacket') !== -1) return 'ePacketライト';
    if (carrier.indexOf('Ship via DHL') !== -1) return 'Ship via DHL';
    if (carrier.indexOf('Ship via FedEx') !== -1) return 'Ship via FedEx';
    if (carrier.indexOf('SpeedPAK Economy') !== -1) return 'SpeedPAK Eco';
    return carrier;
  },

  /**
   * v3.14: CPaSS パッケージ番号 / ASIN を注文カードに描画
   * 引数: order.cpass オブジェクト (Apps Script の getOrders が JOIN して返す)
   * cpass が null/undefined の場合は空文字を返す (既存カードは壊さない)
   */
  renderCpassInfo(cpass) {
    if (!cpass) return '';
    const parts = [];

    if (cpass.package_no) {
      const sibling = cpass.sibling_count > 0
        ? '<span class="sibling-badge">同梱 +' + cpass.sibling_count + '</span>'
        : '';
      parts.push(
        '<div class="cpass-package">' +
          '<span class="pkg-icon">📦</span>' +
          '<span>CPaSS #</span>' +
          '<span class="pkg-no">' + escapeHtml(cpass.package_no) + '</span>' +
          sibling +
        '</div>'
      );
    }

    if (cpass.asin && cpass.amazon_jp_url) {
      parts.push(
        '<div class="cpass-asin">' +
          '<span class="asin-icon">🛒</span>' +
          '<span>Amazon.co.jp:</span>' +
          '<a href="' + escapeHtml(cpass.amazon_jp_url) + '" target="_blank" rel="noopener">' +
            escapeHtml(cpass.asin) +
          '</a>' +
        '</div>'
      );
    }

    if (parts.length === 0) return '';
    return '<div class="order-cpass-info">' + parts.join('') + '</div>';
  },

  /**
   * v3.15: CPaSS バナーを表示/更新
   * - Inbox に取込待ちあり → 青いバナー + [取込実行] ボタン
   * - CPaSS 未取込あり → 黄色いバナー (情報のみ)
   * - 両方なし → バナー全体非表示
   */
  updateCpassBanner() {
    const banner = document.getElementById('cpass-banner');
    const inboxAlert = document.getElementById('cpass-inbox-alert');
    const unimportedAlert = document.getElementById('cpass-unimported-alert');
    const inboxCountEl = document.getElementById('cpass-inbox-count');
    const unimportedCountEl = document.getElementById('cpass-unimported-count');
    if (!banner || !inboxAlert || !unimportedAlert) return;

    const status = this.state.cpassStatus;
    const inboxCount = status && status.inbox_pending_count ? status.inbox_pending_count : 0;
    const unimportedCount = status && status.unimported_count ? status.unimported_count : 0;

    if (inboxCount > 0) {
      if (inboxCountEl) inboxCountEl.textContent = inboxCount;
      inboxAlert.classList.remove('hidden');
    } else {
      inboxAlert.classList.add('hidden');
    }

    if (unimportedCount > 0) {
      if (unimportedCountEl) unimportedCountEl.textContent = unimportedCount;
      unimportedAlert.classList.remove('hidden');
    } else {
      unimportedAlert.classList.add('hidden');
    }

    if (inboxCount > 0 || unimportedCount > 0) {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  },

  // ============================================================
  // v3.16: 印刷機能
  // ============================================================

  /**
   * ヘッダーの印刷ボタンのバッジを更新 (バルク印刷対象数)
   */
  async updateBulkPrintBadge() {
    const badge = document.getElementById('bulk-print-badge');
    if (!badge) return;
    try {
      const r = await API.getPrintTargets();
      const count = (r && typeof r.count === 'number') ? r.count : 0;
      this.state.bulkPrintCount = count;
      this.state.bulkPrintTargets = r.orderIds || [];
      if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    } catch (e) {
      console.error('updateBulkPrintBadge error:', e);
    }
  },

  /**
   * 一括印刷を開始: 対象注文の印刷データを取得して印刷プレビュー画面へ
   */
  async openBulkPrint() {
    if (this.state.bulkPrintCount === 0) {
      showToast('印刷対象がありません (未発送+CPaSS取込済+未印刷の注文がない)');
      return;
    }
    showToast('印刷データを取得中... (' + this.state.bulkPrintCount + '件)');
    try {
      const r = await API.getPrintData([]); // 空配列 = サーバ側で getBulkPrintTargets
      const orders = (r && r.orders) || [];
      if (orders.length === 0) {
        showToast('印刷対象がありません');
        return;
      }
      this.state.printPreviewOrders = orders;
      this.renderPrintPreview(orders);
      this.show('screen-print');
    } catch (e) {
      showToast('印刷データ取得失敗: ' + e.message);
    }
  },

  /**
   * 個別印刷: 指定注文1件のみ
   */
  async openIndividualPrint(orderId) {
    this.closeCardActionMenu();
    if (!orderId) return;
    showToast('印刷データを取得中... (' + orderId + ')');
    try {
      const r = await API.getPrintData([orderId]);
      const orders = (r && r.orders) || [];
      if (orders.length === 0) {
        showToast('注文データが見つかりません');
        return;
      }
      this.state.printPreviewOrders = orders;
      this.renderPrintPreview(orders);
      this.show('screen-print');
    } catch (e) {
      showToast('印刷データ取得失敗: ' + e.message);
    }
  },

  /**
   * v3.17: 印刷プレビューを描画 (A4 1枚に 2商品・上下分割)
   * 奇数末尾の最終ペアは上カードのみ・下半分は空白
   */
  renderPrintPreview(orders) {
    const area = document.getElementById('print-preview-area');
    const countLabel = document.getElementById('print-count-label');
    const titleEl = document.getElementById('print-title');
    if (!area) return;

    // v3.18.11: ★同梱表示が印刷で効かない問題の修正★
    //  getPrintData(Apps Script) は doukonGroupId/doukonRole しか返さず、
    //  doukonGroupLabel/Size/LeadId が欠落していたため _buildPrintDoukonElements が常に empty を返し、
    //  サブにも計測欄(defaultMeasure)が描画されていた。
    //  一覧用 this.state.orders は annotateDoukonLabels_ 済みなので、グループID単位で補完する。
    orders = this._enrichPrintDoukonLabels(orders);

    // v3.18: 同梱グループは「代表→サブ」の順で連続配置。同梱なしの単独商品は元の順序維持。
    orders = this._reorderForDoukon(orders);

    const total = orders.length;
    const pageCount = Math.ceil(total / 2);
    if (countLabel) countLabel.textContent = total + ' 件 / ' + pageCount + ' 枚 (1ページ2商品)';
    if (titleEl) titleEl.textContent = '📦 ピックアップシート印刷 (' + total + '件 / ' + pageCount + '枚)';

    const dateStr = this._formatPrintDate(new Date());

    // 2件ずつペアにグループ化
    const pairs = [];
    for (let i = 0; i < total; i += 2) {
      pairs.push([orders[i], orders[i + 1] || null]);
    }

    // v3.18.6: ★iOS Safari 印刷崩れ修正★
    //  .print-pair ラッパーを廃止し、.print-page をフラットな兄弟として並べる。
    //  iOS Safari はラッパー div 内にネストされた要素の page-break-before を無視するため、
    //  カードを印刷コンテナ直下に置くことで .top の強制改ページを確実に効かせる。
    //  位置クラス: 奇数=.top (A4上半分・新ページ強制), 偶数=.bottom (同ページ下半分)
    const html = pairs.map((pair, pairIdx) => {
      const topIdx = pairIdx * 2 + 1;
      const botIdx = pairIdx * 2 + 2;
      const topCard = this._renderPrintPage(pair[0], topIdx, total, dateStr, 'top');
      const botCard = pair[1]
        ? this._renderPrintPage(pair[1], botIdx, total, dateStr, 'bottom')
        : '<div class="print-page empty bottom"></div>';
      return topCard + botCard;  // ラッパーなしで連結
    }).join('');
    area.innerHTML = html;
  },

  _formatPrintDate(d) {
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  /**
   * v3.18.11: 印刷データに同梱ラベル情報(label/size/leadId)を補完する
   *  - getPrintData は doukonGroupId/doukonRole のみ返す。
   *  - 一覧用 this.state.orders は annotateDoukonLabels_ 済みで label/size/leadId を持つ。
   *  - グループIDは全メンバーで共通なので、groupId → {label,size,leadId} のマップで補える。
   *  - buyerUsername も一覧側にあれば補完(パターン2の内訳 buyer 行用)。
   */
  _enrichPrintDoukonLabels(orders) {
    try {
      if (!Array.isArray(orders) || orders.length === 0) return orders;

      // 1) 一覧(this.state.orders)から groupId -> 正準ラベルのマップ(あれば優先)
      const stateMap = {};
      if (Array.isArray(this.state.orders)) {
        this.state.orders.forEach(s => {
          if (s && s.doukonGroupId && s.doukonGroupLabel && !stateMap[String(s.doukonGroupId)]) {
            stateMap[String(s.doukonGroupId)] = {
              label: String(s.doukonGroupLabel),
              leadId: s.doukonGroupLeadId ? String(s.doukonGroupLeadId) : '',
              buyer: s.buyerUsername ? String(s.buyerUsername) : ''
            };
          }
        });
      }

      // 2) ★フォールバック★ groupId 未タグでも「同一OrderID複数明細(パターン1)」を自動検出
      //    getPrintData が AC列を返さない/シート未タグでも、同じ OrderID が複数行あれば
      //    同梱グループ扱い(代表=先頭明細, 以降=サブ)。ユーザー例 21-14641-67588(2 ASIN) を確実に拾う。
      const idCount = {};
      orders.forEach(o => {
        if (o && !o.doukonGroupId && o.orderId) {
          const k = String(o.orderId);
          idCount[k] = (idCount[k] || 0) + 1;
        }
      });
      const firstSeen = {};
      orders.forEach(o => {
        if (!o || o.doukonGroupId || !o.orderId) return;
        const k = String(o.orderId);
        if (idCount[k] >= 2) {
          o.doukonGroupId = 'P1LOCAL-' + k;
          if (!firstSeen[k]) { o.doukonRole = o.doukonRole || 'lead'; firstSeen[k] = true; }
          else { o.doukonRole = o.doukonRole || 'sub'; }
        }
      });

      // 3) 印刷データ自身を groupId 単位に集計(出現順を保持)
      const groupOrder = [];
      const members = {};
      orders.forEach(o => {
        const gid = (o && o.doukonGroupId) ? String(o.doukonGroupId) : '';
        if (!gid) return;
        if (!members[gid]) { members[gid] = []; groupOrder.push(gid); }
        members[gid].push(o);
      });

      // 代表(lead)の特定 + role 未設定グループの補完(先頭=lead, 以降=sub)
      const leadOf = {};
      groupOrder.forEach(gid => {
        const arr = members[gid];
        const hasLead = arr.some(x => String(x.doukonRole || '') === 'lead');
        if (!hasLead) {
          arr.forEach((x, i) => { if (!x.doukonRole) x.doukonRole = (i === 0 ? 'lead' : 'sub'); });
        } else {
          arr.forEach(x => { if (!x.doukonRole) x.doukonRole = 'sub'; });
        }
        const lead = arr.find(x => String(x.doukonRole || '') === 'lead') || arr[0];
        leadOf[gid] = lead ? String(lead.orderId || '') : '';
      });

      // 4) ラベル(A,B,C…)を出現順で割当(state にあればそれを優先し一覧と一致させる)
      const LB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let li = 0;
      const labelOf = {};
      groupOrder.forEach(gid => {
        if (stateMap[gid] && stateMap[gid].label) labelOf[gid] = stateMap[gid].label;
        else { labelOf[gid] = LB.charAt(li % LB.length); li += 1; }
      });

      // 5) 各注文へ反映(単独商品は groupId 無しなので一切変更しない)
      orders.forEach(o => {
        const gid = (o && o.doukonGroupId) ? String(o.doukonGroupId) : '';
        if (!gid) return;
        o.doukonGroupLabel  = labelOf[gid] || 'A';
        o.doukonGroupSize   = (members[gid] || []).length;
        o.doukonGroupLeadId = (stateMap[gid] && stateMap[gid].leadId) || leadOf[gid] || '';
        if (!o.buyerUsername && stateMap[gid] && stateMap[gid].buyer) o.buyerUsername = stateMap[gid].buyer;
      });

      // 6) 内訳ブロック用にメンバーマップを保持(state.orders 非依存化)
      this.state.printGroupMembers = members;
      return orders;
    } catch (e) {
      try { console.warn('_enrichPrintDoukonLabels failed:', e); } catch (_) {}
      return orders;
    }
  },

  /**
   * v3.18: 印刷用に注文配列を並べ替える
   *  - 同梱グループは「代表→サブ」順で連続配置
   *  - 同梱グループ間の順序は元の出現順を維持
   *  - 同梱なしの注文は元の位置に挿入順を保つ
   */
  _reorderForDoukon(orders) {
    try {
      if (!Array.isArray(orders) || orders.length === 0) return orders;
      const result = [];
      const visited = new Set();
      // key: 同梱グループID(or null for non-doukon)
      orders.forEach((o, idx) => {
        const key = idx + '|' + (o.orderId || '') + '|' + (o.lineItemId || '');
        if (visited.has(key)) return;
        if (o && o.doukonGroupId) {
          // 同じグループの全メンバーをまとめて取り出す
          const groupMembers = orders
            .map((x, i) => ({ o: x, i: i }))
            .filter(x => x.o && x.o.doukonGroupId === o.doukonGroupId);
          groupMembers.sort((a, b) => {
            const ra = a.o.doukonRole === 'lead' ? 0 : 1;
            const rb = b.o.doukonRole === 'lead' ? 0 : 1;
            if (ra !== rb) return ra - rb;
            return a.i - b.i; // 同役割内は元の順序維持
          });
          groupMembers.forEach(m => {
            const k = m.i + '|' + (m.o.orderId || '') + '|' + (m.o.lineItemId || '');
            if (!visited.has(k)) {
              result.push(m.o);
              visited.add(k);
            }
          });
        } else {
          result.push(o);
          visited.add(key);
        }
      });
      return result;
    } catch (e) {
      try { console.warn('_reorderForDoukon failed:', e); } catch (_) {}
      return orders;
    }
  },

  /**
   * v3.18: 印刷シート用の同梱要素を組み立て
   *  - bannerHtml: 上部の同梱バナー
   *  - warningHtml: パターン2サブ用の赤警告バー
   *  - frameClass: ORDER ID 枠の追加クラス (' doukon-sub' か '')
   *  - idLabel: 'ORDER ID' (代表) or 'PICKUP REF (撮影不可)' (サブ)
   *  - breakdownHtml: 内訳ブロック
   *  - measureHtml: サブの場合は計測欄置換注記 (代表/単独は空文字 → 既定の計測欄が描画される)
   */
  _buildPrintDoukonElements(o) {
    const empty = { bannerHtml: '', warningHtml: '', frameClass: '', idLabel: 'ORDER ID', breakdownHtml: '', measureHtml: '' };
    try {
      if (!o || !o.doukonGroupId || !o.doukonGroupLabel) return empty;
      const label = String(o.doukonGroupLabel);
      const role = String(o.doukonRole || '');
      const isLead = role === 'lead';
      const isSub = role === 'sub';
      const groupSize = parseInt(o.doukonGroupSize, 10) || 0;
      const colors = this._doukonColors[label] || this._doukonColors.A;
      const isPattern2 = String(o.doukonGroupId).indexOf('P2-') === 0;
      const leadOrderId = String(o.doukonGroupLeadId || '');

      // バナー
      const bannerText = isLead
        ? '📦 同梱グループ' + label + ' ・代表 ・' + groupSize + '点まとめて計測'
        : '📦 同梱グループ' + label + ' ・サブ ・計測不要 (代表へ)';
      const bannerStyle = isLead
        ? 'background:' + colors.bg + ';color:' + colors.fg + ';border:0.5px solid ' + colors.border + ';'
        : 'background:#ECECEC;color:#5A5A5A;border:0.5px solid #B4B2A9;';
      const bannerHtml = '<div class="pp-doukon-banner-wrap"><span class="pp-doukon-banner" style="' + bannerStyle + '">' + escapeHtml(bannerText) + '</span></div>';

      // パターン2 サブの赤警告バー
      const warningHtml = (isSub && isPattern2)
        ? '<div class="pp-doukon-warning">⚠️ このOrderIDはスキャン対象外です（代表シートをご使用ください） ・代表 <strong>' + escapeHtml(leadOrderId) + '</strong></div>'
        : '';

      // ORDER ID 枠の装飾切替
      const frameClass = isSub ? ' doukon-sub' : '';
      const idLabel = isSub ? '🚫 PICKUP REF (撮影不可)' : '📷 ORDER ID';

      // 内訳ブロック
      // v3.18.11: メンバーは印刷側マップ(_enrichPrintDoukonLabels が構築)を優先。
      //   state.orders がフィルタで欠けていても内訳が出るようにする。
      let breakdownHtml = '';
      let members = (this.state.printGroupMembers && this.state.printGroupMembers[String(o.doukonGroupId)])
        ? this.state.printGroupMembers[String(o.doukonGroupId)].slice()
        : [];
      if (members.length === 0 && Array.isArray(this.state.orders)) {
        members = this.state.orders.filter(x => x && String(x.doukonGroupId) === String(o.doukonGroupId));
      }
      {
        members.sort((a, b) => {
          const ra = a.doukonRole === 'lead' ? 0 : 1;
          const rb = b.doukonRole === 'lead' ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return String(a.orderId).localeCompare(String(b.orderId));
        });
        if (members.length > 0) {
          const rows = members.map((m, i) => {
            const isSelf = (m.orderId === o.orderId) && (String(m.lineItemId || '') === String(o.lineItemId || ''));
            const isMemberLead = m.doukonRole === 'lead';
            const tail = String(m.orderId || '').slice(-4);
            const shortTitle = String(m.itemTitle || '').substring(0, 38);
            let tag = '';
            if (isSelf) tag = '<span class="pp-dk-tag-self">本シート</span>';
            else if (isMemberLead) tag = '<span class="pp-dk-tag-lead">代表</span>';
            return (i + 1) + '. ' + escapeHtml(shortTitle) + ' <span class="pp-dk-tail">末尾 ' + escapeHtml(tail) + '</span>' + tag + '<br>';
          }).join('');
          const headLabel = isPattern2
            ? '\u{1F4E6} 同梱' + label + ' 内訳 (' + members.length + '点・別OrderID/同一買主)'
            : '\u{1F4E6} 同梱' + label + ' 内訳 (' + members.length + '点・同一OrderID)';
          const buyerLine = (isPattern2 && o.buyerUsername)
            ? '<div class="pp-dk-buyer">\u{1F464} buyer: ' + escapeHtml(o.buyerUsername) + '</div>'
            : '';
          const style = 'background:' + colors.bg + ';border:0.5px solid ' + colors.border + ';color:' + colors.fg + ';';
          breakdownHtml = '<div class="pp-doukon-breakdown" style="' + style + '">'
            + '<div class="pp-dk-head">' + escapeHtml(headLabel) + '</div>'
            + buyerLine
            + rows
            + '</div>';
        }
      }

      const measureHtml = isSub
        ? '<div class="pp-measure doukon-sub-note"><div class="pp-measure-label">⚖ 計測欄なし</div>※ 重量・寸法は代表シート <strong>' + escapeHtml(leadOrderId) + '</strong> に一括入力</div>'
        : '';

      return { bannerHtml: bannerHtml, warningHtml: warningHtml, frameClass: frameClass, idLabel: idLabel, breakdownHtml: breakdownHtml, measureHtml: measureHtml };
    } catch (e) {
      try { console.warn('_buildPrintDoukonElements failed:', e); } catch (_) {}
      return empty;
    }
  },

  _renderPrintPage(o, orderIdx, total, dateStr, positionClass) {
    const orderId = escapeHtml(o.orderId || '');
    const account = escapeHtml(o.account || '');
    const country = escapeHtml(o.country || '');
    const ebayTitle = escapeHtml(o.itemTitle || '');
    const amazonTitle = escapeHtml(o.amazonTitle || '');
    const asin = escapeHtml(o.asin || '');
    const cpassPackage = escapeHtml(o.cpassPackage || '');
    const carrier = escapeHtml(o.selectedCarrier || o.shippingPolicy || '未確定');
    const hsCode = escapeHtml(o.hsCode || '');
    const tariffRate = o.tariffRate ? (parseFloat(o.tariffRate).toFixed(1) + '%') : '0%';
    const buyer = escapeHtml(o.buyerName || '');
    const imageHtml = (o.imageUrl && String(o.imageUrl).indexOf('http') === 0)
      ? '<img src="' + escapeAttr(o.imageUrl) + '" alt="" onerror="this.outerHTML=&#39;\u{1F4E6}&#39;">'
      : '\u{1F4E6}';

    const dm = this.computeDeadlineMeta(o.shipByDate);
    let deadlineLabel;
    // v3.18.8: 超過は daysLeft<0 でのみ「(超過)」表記。red は当日/残り1-2日も含むため区別する
    if (dm.level === 'gray')                          deadlineLabel = '発送期日 不明';
    else if (dm.daysLeft != null && dm.daysLeft < 0)  deadlineLabel = '⛔ 発送期日 ' + dm.label + ' (超過)';
    else if (dm.level === 'red')                      deadlineLabel = '⛔ 発送期日 ' + dm.label;
    else if (dm.level === 'orange')                   deadlineLabel = '⚠ 発送期日 ' + dm.label;
    else                                              deadlineLabel = '発送期日 ' + dm.label;
    const deadlineHtml = '<div class="pp-deadline urgent-' + dm.level + '">' + escapeHtml(deadlineLabel) + '</div>';

    const addrLine1 = escapeHtml(o.addrLine1 || '');
    const addrLine2 = escapeHtml(o.addrLine2 || '');
    const city = escapeHtml(o.city || '');
    const stateRegion = escapeHtml(o.stateRegion || '');
    const postalCode = escapeHtml(o.postalCode || '');
    const countryFull = escapeHtml(o.countryFull || o.country || '');
    const cityStateZip = [city, stateRegion, postalCode].filter(Boolean).join(' ');
    const buyerAddrHtml = [
      buyer ? '<div>' + buyer + '</div>' : '',
      addrLine1 ? '<div>' + addrLine1 + '</div>' : '',
      addrLine2 ? '<div>' + addrLine2 + '</div>' : '',
      cityStateZip ? '<div>' + cityStateZip + '</div>' : '',
      countryFull ? '<div>' + countryFull + '</div>' : ''
    ].filter(Boolean).join('');

    const cpassBlock = cpassPackage
      ? '<div class="pp-cpass"><div class="pp-cpass-label">CPASS PACKAGE</div><div class="pp-cpass-value">#' + cpassPackage + '</div></div>'
      : '<div class="pp-cpass warning"><div class="pp-cpass-label">CPASS</div><div class="pp-cpass-value">⚠ 未取込</div></div>';

    const amazonBlock = amazonTitle
      ? '<div class="pp-amazon-text">' + amazonTitle + '</div><div class="pp-amazon-asin">\u{1F6D2} ' + asin + '</div>'
      : '<div class="pp-amazon-text" style="color:#666;">(' + (asin ? 'ASIN: ' + asin + ' / 未取得' : '未取込') + ')</div>';

    const posCls = positionClass ? (' ' + positionClass) : '';

    const dp = this._buildPrintDoukonElements(o);
    const defaultMeasure =
      '<div class="pp-measure">' +
        '<div class="pp-measure-label">⚖ 計測 (記入欄)</div>' +
        '重量: <span class="pp-write-box"></span> g 　' +
        '寸法: <span class="pp-write-box tiny"></span>×<span class="pp-write-box tiny"></span>×<span class="pp-write-box tiny"></span> cm' +
      '</div>';

    return '' +
      '<div class="print-page' + posCls + '">' +
        '<div class="pp-header">' +
          '<div class="pp-title">\u{1F4E6} ピックアップシート ' + orderIdx + '/' + total + '</div>' +
          deadlineHtml +
          '<div class="pp-meta">' + dateStr + '</div>' +
        '</div>' +
        dp.bannerHtml +
        dp.warningHtml +
        '<div class="pp-orderid-frame' + dp.frameClass + '">' +
          '<div class="pp-orderid-label">' + dp.idLabel + '</div>' +
          '<div class="pp-orderid-id">' + orderId + '</div>' +
        '</div>' +
        dp.breakdownHtml +
        '<div class="pp-card-area">' +
          '<div class="pp-info">' +
            '<div class="pp-img-wrap">' +
              '<div class="pp-img">' + imageHtml + '</div>' +
              '<div class="pp-ac-bottom" title="' + account + ' / ' + country + '">' + account + ' / ' + country + '</div>' +
            '</div>' +
            '<div class="pp-text-area">' +
              '<div class="pp-ebay"><div class="pp-ebay-label">eBay商品名</div><div class="pp-ebay-text">' + ebayTitle + '</div></div>' +
              '<div class="pp-amazon"><div class="pp-amazon-label">AMAZON商品名 ⭐</div>' + amazonBlock + '</div>' +
            '</div>' +
          '</div>' +
          cpassBlock +
          (dp.measureHtml || defaultMeasure) +
          '<div class="pp-meta-info">\u{1F4E6} ' + carrier + ' / HS ' + (hsCode || '-') + ' / 関税 ' + tariffRate + '</div>' +
          '<div class="pp-buyer">' +
            '<div class="pp-buyer-label">SHIP TO</div>' +
            '<div class="pp-buyer-addr">' + (buyerAddrHtml || (buyer + '<br>' + country)) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  },

  // ===== v3.18 復元: 印刷/同期/CPaSS/カードメニュー系メソッド =====
  async sync() {
    showToast('eBayから注文を取得中...');
    try {
      await API.syncOrders();
      await this.loadAll();
      showToast('同期完了');
    } catch (err) {
      showToast('同期失敗: ' + err.message);
    }
  },

  confirmShipment() {
    const c = this.state.currentResult.candidates[this.state.selectedCarrierIndex];
    if (!c) return;
    const orderId = document.getElementById('input-order-id').value.trim();
    if (!orderId) return showToast('注文IDを入力してください');
    const i = this.state.currentInput;
    const weightKg = Math.round((i.weightG / 1000) * 100) / 100;
    const data = {
      orderId,
      weightKg: weightKg,
      lengthCm: i.lengthCm,
      widthCm: i.widthCm,
      heightCm: i.heightCm,
      carrier: c.carrier,
      cost: c.totalCost,
      alternatives: this.state.currentResult.candidates.slice(1).map(x => x.carrier + ' ¥' + x.totalCost).join(' / ')
    };
    TodayGroup.remove(orderId);
    const localOrder = this.state.orders.find(o => o.orderId === orderId);
    if (localOrder) {
      localOrder.selectedCarrier = c.carrier;
      localOrder.shippingCost = c.totalCost;
    }
    showToast('Sheetsへ書込み中... ホームへ戻ります');
    this.state.pendingWrites++;
    this.goHome();

    API.writeShipment(data)
      .then(res => {
        this.state.pendingWrites--;
        if (res && res.error) {
          showToast('書込み失敗: ' + res.error);
        } else {
          showToast('書込み完了：' + orderId);
        }
      })
      .catch(err => {
        this.state.pendingWrites--;
        showToast('書込み失敗: ' + err.message);
      });
  },

  async runCpassImport() {
    const btn = document.getElementById('btn-cpass-import');
    if (!btn) return;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>取込中...';

    try {
      const result = await API.runCpassImport();
      if (result && typeof result.files_processed === 'number') {
        showToast(result.files_processed + ' ファイル取込完了');
      } else {
        showToast('取込完了');
      }
      // データを再読み込みして UI を更新
      await this.loadAll();
    } catch (err) {
      showToast('取込失敗: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  },

  showCardActionMenu(orderId) {
    this.state.longPressOrderId = orderId;
    const overlay = document.getElementById('card-action-overlay');
    const target = document.getElementById('card-action-target');
    const unmarkBtn = document.getElementById('card-action-unmark');
    if (!overlay || !target) return;

    target.textContent = orderId;

    // 印刷済か否かでメニュー表示制御
    const order = this.state.orders.find(o => o.orderId === orderId);
    if (unmarkBtn) {
      if (order && order.printedAt) {
        unmarkBtn.style.display = '';
      } else {
        unmarkBtn.style.display = 'none';
      }
    }

    // ★ Phase B: 発送済にする / 解除 の表示制御
    //   - 発送済にする: まだ発送済でない (追跡なし AND FULFILLEDでない)
    //   - 発送済を解除 : 手動/API で FULFILLED かつ 追跡番号なし (=手動マーク相当)
    const shipBtn = document.getElementById('card-action-ship');
    const unshipBtn = document.getElementById('card-action-unship');
    const hasTracking = !!(order && order.trackingNumber);
    const isFulfilled = !!(order && order.fulfillmentStatus === 'FULFILLED');
    if (shipBtn) shipBtn.style.display = (!hasTracking && !isFulfilled) ? '' : 'none';
    if (unshipBtn) unshipBtn.style.display = (!hasTracking && isFulfilled) ? '' : 'none';

    // ★ 手動キャンセル: 未キャンセルなら「キャンセル済にする」、キャンセル済なら「解除」
    const cancelMarkBtn = document.getElementById('card-action-cancelmark');
    const uncancelBtn = document.getElementById('card-action-uncancelmark');
    const isCancelled = !!(order && order.cancelledAt);
    if (cancelMarkBtn) cancelMarkBtn.style.display = isCancelled ? 'none' : '';
    if (uncancelBtn) uncancelBtn.style.display = isCancelled ? '' : 'none';

    overlay.classList.remove('hidden');
    // オーバーレイ外タップで閉じる
    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeCardActionMenu();
    };
  },

  closeCardActionMenu() {
    const overlay = document.getElementById('card-action-overlay');
    if (overlay) overlay.classList.add('hidden');
    this.state.longPressOrderId = null;
  },

  // ★ Phase B: 手動「発送済にする / 解除」(表示フラグのみ・eBay非送信)
  async markShippedAndReload(orderId, shipped) {
    this.closeCardActionMenu();
    if (!orderId) return;
    const msg = shipped
      ? orderId + ' を「発送済」にしますか？\n\n※ これは PWA の表示フラグのみで、eBay には何も送信しません。\neBay へ追跡番号を登録するには「追跡スキャン」を使ってください。'
      : orderId + ' の「発送済」を解除しますか？';
    if (!window.confirm(msg)) return;
    try {
      const r = await API.recoveryMarkShipped(orderId, shipped);
      if (r && r.ok) {
        showToast(shipped ? '✓ 発送済にしました' : '↩ 発送済を解除しました');
        this.loadAll();
      } else {
        showToast('失敗: ' + ((r && r.reason) || 'unknown'));
      }
    } catch (e) {
      showToast('エラー: ' + (e.message || e));
    }
  },

  // ★ 手動「キャンセル済にする / 解除」(表示フラグのみ・eBay非送信)
  async markCancelledAndReload(orderId, cancelled) {
    this.closeCardActionMenu();
    if (!orderId) return;
    const msg = cancelled
      ? orderId + ' を「キャンセル済」にしますか？\n\n※ 表示フラグのみで、eBay には何も送信しません。\nAPI で確認できない注文を手動でキャンセル扱いにし、一覧から隠します。'
      : orderId + ' の「キャンセル済」を解除しますか？';
    if (!window.confirm(msg)) return;
    try {
      const r = await API.recoveryMarkCancelled(orderId, cancelled);
      if (r && r.ok) {
        showToast(cancelled ? '⊘ キャンセル済にしました' : '↩ キャンセルを解除しました');
        this.loadAll();
      } else {
        showToast('失敗: ' + ((r && r.reason) || 'unknown'));
      }
    } catch (e) {
      showToast('エラー: ' + (e.message || e));
    }
  },

  doBrowserPrint() {
    window.print();
  },

  async markPrintedAndReturn() {
    const orders = this.state.printPreviewOrders || [];
    if (orders.length === 0) {
      this.goHome();
      return;
    }
    const ids = orders.map(o => o.orderId);
    showToast('印刷済マーク中... (' + ids.length + '件)');
    try {
      const r = await API.markPrinted(ids);
      const updated = (r && r.updated) || 0;
      showToast(updated + '件を印刷済としてマークしました');
      this.state.printPreviewOrders = [];
      await this.loadAll();
    } catch (e) {
      showToast('印刷済マーク失敗: ' + e.message);
    }
  },

  async unmarkPrintedAndReload(orderId) {
    this.closeCardActionMenu();
    if (!orderId) return;
    showToast('印刷済を解除中...');
    try {
      const r = await API.unmarkPrinted(orderId);
      if (r && r.updated > 0) {
        showToast('印刷済を解除しました: ' + orderId);
      } else {
        showToast('対象注文が見つかりませんでした');
      }
      await this.loadAll();
    } catch (e) {
      showToast('印刷済解除失敗: ' + e.message);
    }
  },

};

function showToast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// PWA 初期化エントリ (v3.18.11)
document.addEventListener('DOMContentLoaded', () => App.init());
