/**
 * メインのUIロジック (v3.1)
 *
 * v3.1 修正:
 *  - 寸法/重量バリデーションを改善：どの項目が未入力かを明示
 *  - 全角数字・カンマ・空白を自動的に半角・除去して受け付ける
 *  - コンソールに実値ログを出力（デバッグ用）
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
    if (!API.loadConfig()) {
      this.show('screen-setup');
      this.bindSetup();
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
    document.getElementById('btn-save-config').onclick = async () => {
      const url = document.getElementById('cfg-api-url').value.trim();
      const secret = document.getElementById('cfg-secret').value.trim();
      if (!url) return showToast('Web App URLを入力してください');
      API.saveConfig(url, secret);
      this.bindAll();
      await this.loadAll();
    };
    const clearBtn = document.getElementById('btn-clear-cache');
    if (clearBtn) clearBtn.onclick = async () => {
      API.clearMasterCache();
      showToast('キャッシュをクリアしました');
      if (API.config.url) {
        this.bindAll();
        await this.loadAll();
      }
    };
  },
 
  bindAll() {
    document.getElementById('btn-sync').onclick = () => this.sync();
    document.getElementById('btn-settings').onclick = () => this.show('screen-setup');
    document.getElementById('btn-new').onclick = () => this.openInput(null);
    document.getElementById('filter-account').onchange = () => this.renderOrders();
    document.getElementById('filter-hide-done').onchange = () => this.renderOrders();
 
    document.getElementById('btn-back-list').onclick = () => this.goHome();
    document.getElementById('btn-back-input').onclick = () => this.show('screen-input');
 
    const homeInput = document.getElementById('btn-home-input');
    if (homeInput) homeInput.onclick = () => this.goHome();
    const homeResult = document.getElementById('btn-home-result');
    if (homeResult) homeResult.onclick = () => this.goHome();
 
    document.getElementById('btn-calculate').onclick = () => this.calculate();
    document.getElementById('btn-confirm').onclick = () => this.confirmShipment();
 
    document.getElementById('btn-ocr').onclick = () => {
      OCR.setKnownOrders(this.state.orders);
      OCR.open(orderId => {
        document.getElementById('input-order-id').value = orderId;
      });
    };
    document.getElementById('btn-scan-list').onclick = () => {
      this.state.batchScanActive = false;
      OCR.setKnownOrders(this.state.orders);
      OCR.open(orderId => this.handleScanFromList(orderId));
    };
 
    const batchBtn = document.getElementById('btn-batch-scan');
    if (batchBtn) batchBtn.onclick = () => this.startBatchScan();
    const clearTodayBtn = document.getElementById('btn-today-clear');
    if (clearTodayBtn) clearTodayBtn.onclick = () => {
      if (confirm('本日の作業グループをクリアしますか？（発送履歴は残ります）')) {
        TodayGroup.clear();
        this.renderOrders();
        showToast('本日グループをクリアしました');
      }
    };
 
    document.getElementById('btn-ocr-cancel').onclick = () => {
      this.state.batchScanActive = false;
      OCR.keepOpen = false;
      OCR.close();
      this.renderOrders();
    };
    document.getElementById('btn-ocr-capture').onclick = () => OCR.capture();
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
      const thumbHtml = o.imageUrl
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
 
    // サムネ画像＋商品名
    const thumbWrap = document.getElementById('input-thumb-wrap');
    const titleEl = document.getElementById('input-item-title');
    if (order && order.imageUrl) {
      thumbWrap.innerHTML = `<img src="${escapeAttr(order.imageUrl)}" alt="" onerror="this.outerHTML='<div class=&quot;order-thumb-placeholder&quot;>&#128230;</div>'">`;
    } else {
      thumbWrap.innerHTML = '<div class="order-thumb-placeholder">&#128230;</div>';
    }
    titleEl.textContent = (order && order.itemTitle) ? order.itemTitle : '';
 
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
  },
 
  /** 数値フィールドを堅牢に読み取る（全角→半角、カンマ・空白除去） */
  _readNum(id) {
    let raw = String(document.getElementById(id).value || '').trim();
    // 全角数字＆全角ピリオドを半角に
    raw = raw.replace(/[０-９．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    // カンマ・空白除去
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
 
    // どのフィールドが未入力/不正かを具体的に表示
    const missing = [];
    if (!weightG || weightG <= 0) missing.push('重量');
    if (!lengthCm || lengthCm <= 0) missing.push('長');
    if (!widthCm || widthCm <= 0) missing.push('幅');
    if (!heightCm || heightCm <= 0) missing.push('高');
    if (missing.length) {
      console.log('[Validation NG]', { country, weightG, lengthCm, widthCm, heightCm,
        rawWeight: document.getElementById('input-weight').value,
        rawLength: document.getElementById('input-length').value,
        rawWidth: document.getElementById('input-width').value,
        rawHeight: document.getElementById('input-height').value });
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
 
