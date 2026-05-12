/**
 * メインのUIロジック (v3.7)
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
    batchScanActive: false
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

    const updateToolbar = () => {
      const active = document.activeElement;
      const idx = active ? chain.indexOf(active.id) : -1;
      if (idx === -1) {
        toolbar.classList.add('hidden');
        return;
      }
      toolbar.classList.remove('hidden');
      prevBtn.disabled = (idx === 0);
      // 最終フィールドでは「次へ」→「完了」に切り替え
      if (idx === chain.length - 1) {
        nextBtn.textContent = '完了 ▶';
      } else {
        nextBtn.textContent = '次へ ▶';
      }
    };

    const focusByIndex = (idx) => {
      if (idx < 0 || idx >= chain.length) return;
      const el = document.getElementById(chain[idx]);
      if (!el) return;
      el.focus();
      try { el.select(); } catch (_) {}
    };

    // 各数値フィールドのフォーカス/ブラー監視
    chain.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', () => {
        setTimeout(() => { try { el.select(); } catch (_) {} }, 0);
        updateToolbar();
      });
      el.addEventListener('blur', () => {
        // ボタンタップの判定を待ってから非表示判断
        setTimeout(updateToolbar, 200);
      });
      // PCでのEnterキーフォールバック
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const idx = chain.indexOf(id);
          if (idx === chain.length - 1) {
            el.blur();
            this.calculate();
          } else {
            focusByIndex(idx + 1);
          }
        }
      });
    });

    // ボタンタップ時にフォーカスを失わないよう mousedown/touchstart で preventDefault
    const preventBlur = (btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    };
    preventBlur(prevBtn);
    preventBlur(nextBtn);
    preventBlur(doneBtn);

    prevBtn.addEventListener('click', () => {
      const active = document.activeElement;
      const idx = active ? chain.indexOf(active.id) : -1;
      if (idx > 0) focusByIndex(idx - 1);
    });

    nextBtn.addEventListener('click', () => {
      const active = document.activeElement;
      const idx = active ? chain.indexOf(active.id) : -1;
      if (idx === -1) return;
      if (idx === chain.length - 1) {
        active.blur();
        this.calculate();
      } else {
        focusByIndex(idx + 1);
      }
    });

    doneBtn.addEventListener('click', () => {
      const active = document.activeElement;
      if (active && chain.indexOf(active.id) !== -1) active.blur();
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
    try {
      this.recentCountries = JSON.parse(localStorage.getItem('recent_countries') || '[]');
      this.state.masterData = await API.getMasterData();
      if (!this.state.masterData || !Array.isArray(this.state.masterData.countries) || this.state.masterData.countries.length < 10) {
        showToast('マスタデータ不完全。再取得します...');
        API.clearMasterCache();
        this.state.masterData = await API.getMasterData(true);
      }
      Calculator.setMaster(this.state.masterData);
      const data = await API.getOrders(undefined, undefined, API.DEFAULT_DAYS_BACK);
      this.state.orders = data.orders || [];
      this.pruneTodayGroup();
      this.populateCountrySelect();
      this.renderOrders();
    } catch (err) {
      showToast('読み込みエラー: ' + err.message);
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
    const filterAcc = document.getElementById('filter-account').value;
    const hideDone = document.getElementById('filter-hide-done').checked;
    const list = document.getElementById('order-list');

    let orders = this.state.orders;
    if (filterAcc) orders = orders.filter(o => o.account === filterAcc);
    if (hideDone) orders = orders.filter(o => !o.selectedCarrier);

    const todayBar = document.getElementById('today-bar');
    const todayCount = TodayGroup.count();
    if (todayCount > 0) {
      todayBar.classList.remove('hidden');
      document.getElementById('today-count').textContent = todayCount + '件';
    } else {
      todayBar.classList.add('hidden');
    }

    if (orders.length === 0) {
      list.innerHTML = '<div class="empty">表示できる注文がありません<br>右上の⟳で同期するか、+で手動入力してください<br><span class="muted">（既定: 直近15日／入力済を隠す）</span></div>';
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
      return `
      <div class="order-item${inToday ? ' in-today' : ''}" data-id="${escapeAttr(o.orderId)}">
        ${thumbHtml}
        <div class="order-body">
          <div class="order-head">
            <span class="badge acc-${escapeAttr(o.account)}">${escapeHtml(o.account)}</span>
            ${inToday ? '<span class="today-tag">本日</span>' : ''}
            ${o.selectedCarrier ? '<span class="badge done">確定</span>' : ''}
          </div>
          <div class="order-id">${escapeHtml(o.orderId)}</div>
          <div class="order-meta">${escapeHtml(o.country || '?')} / ${escapeHtml(o.itemTitle || '')}</div>
          ${o.selectedCarrier ? `<div class="order-cost">${escapeHtml(o.selectedCarrier)} ¥${o.shippingCost}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.order-item').forEach(el => {
      el.onclick = () => {
        TodayGroup.add(el.dataset.id);
        this.openInput(el.dataset.id);
      };
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
    document.getElementById('input-weight').value = order && order.weightG ? order.weightG : '';
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
    const weightG = this._readNum('input-weight');
    const lengthCm = this._readNum('input-length');
    const widthCm = this._readNum('input-width');
    const heightCm = this._readNum('input-height');

    if (!country) return showToast('発送先国を選択してください');

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
    const legendHtml = `
      <div class="legend">
        <div class="legend-item"><span class="carrier-circle c-epacket"></span>ePacketライト</div>
        <div class="legend-item"><span class="carrier-circle c-eco"></span>SpeedPAK Eco</div>
        <div class="legend-item"><span class="carrier-circle c-dhl"></span>Ship via DHL</div>
        <div class="legend-item"><span class="carrier-circle c-fedex"></span>Ship via FedEx</div>
      </div>
    `;
    list.innerHTML = legendHtml + result.candidates.map((c, i) => {
      const colorClass = this.getCarrierColorClass(c.carrier);
      const carrierShort = this.shortenCarrier(c.carrier);
      const trackingNote = [c.tracking ? '追跡あり' : '', c.insurance ? '補償あり' : ''].filter(Boolean).join('・');

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
        <div class="result-card" data-idx="${i}">
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
  },

  getCarrierColorClass(carrier) {
    if (carrier.indexOf('ePacket') !== -1) return 'c-epacket';
    if (carrier.indexOf('Ship via DHL') !== -1) return 'c-dhl';
    if (carrier.indexOf('Ship via FedEx') !== -1) return 'c-fedex';
    if (carrier.indexOf('SpeedPAK Economy') !== -1) return 'c-eco';
    return 'c-eco';
  },

  shortenCarrier(carrier) {
    if (carrier.indexOf('ePacket') !== -1) return 'ePacketライト';
    if (carrier.indexOf('Ship via DHL') !== -1) return 'Ship via DHL';
    if (carrier.indexOf('Ship via FedEx') !== -1) return 'Ship via FedEx';
    if (carrier.indexOf('SpeedPAK Economy') !== -1) return 'SpeedPAK Eco';
    return carrier;
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

  async sync() {
    showToast('eBayから注文を取得中...');
    try {
      await API.syncOrders();
      await this.loadAll();
      showToast('同期完了');
    } catch (err) {
      showToast('同期失敗: ' + err.message);
    }
  }
};

function showToast(message) {
  const t = document.getElementById('toast');
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

document.addEventListener('DOMContentLoaded', () => App.init());
