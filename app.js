/**
 * メインのUIロジック
 */
const App = {
  state: {
    masterData: null,
    orders: [],
    currentOrder: null,
    currentInput: null,
    currentResult: null,
    selectedCarrierIndex: 0,
    recentCountries: []
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
  },

  bindAll() {
    document.getElementById('btn-sync').onclick = () => this.sync();
    document.getElementById('btn-settings').onclick = () => this.show('screen-setup');
    document.getElementById('btn-new').onclick = () => this.openInput(null);
    document.getElementById('filter-account').onchange = () => this.renderOrders();
    document.getElementById('btn-back-list').onclick = () => this.show('screen-list');
    document.getElementById('btn-back-input').onclick = () => this.show('screen-input');
    document.getElementById('btn-calculate').onclick = () => this.calculate();
    document.getElementById('btn-confirm').onclick = () => this.confirmShipment();
    document.getElementById('btn-ocr').onclick = () => OCR.open();
    document.getElementById('btn-ocr-cancel').onclick = () => OCR.close();
    document.getElementById('btn-ocr-capture').onclick = () => OCR.capture();
  },

  async loadAll() {
    this.show('screen-list');
    this.setLoader(true);
    try {
      this.recentCountries = JSON.parse(localStorage.getItem('recent_countries') || '[]');
      this.state.masterData = await API.getMasterData();
      Calculator.setMaster(this.state.masterData);
      const data = await API.getOrders();
      this.state.orders = data.orders || [];
      this.populateCountrySelect();
      this.renderOrders();
    } catch (err) {
      showToast('読み込みエラー: ' + err.message);
    } finally {
      this.setLoader(false);
    }
  },

  setLoader(show) {
    document.getElementById('list-loader').classList.toggle('hidden', !show);
  },

  populateCountrySelect() {
    const sel = document.getElementById('input-country');
    sel.innerHTML = '';
    const all = this.state.masterData.countries;
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
    const filter = document.getElementById('filter-account').value;
    const list = document.getElementById('order-list');
    let orders = this.state.orders;
    if (filter) orders = orders.filter(o => o.account === filter);
    if (orders.length === 0) {
      list.innerHTML = '<div class="empty">注文が登録されていません<br>右上の⟳で同期するか、+で手動入力してください</div>';
      return;
    }
    list.innerHTML = orders.slice().reverse().map(o => `
      <div class="order-item" data-id="${escapeHtml(o.orderId)}">
        <div class="order-head">
          <span class="badge acc-${escapeHtml(o.account)}">${escapeHtml(o.account)}</span>
          ${o.selectedCarrier ? '<span class="badge done">確定</span>' : ''}
        </div>
        <div class="order-id">${escapeHtml(o.orderId)}</div>
        <div class="order-meta">${escapeHtml(o.country || '?')} / ${escapeHtml(o.itemTitle || '')}</div>
        ${o.selectedCarrier ? `<div class="order-cost">${escapeHtml(o.selectedCarrier)} ¥${o.shippingCost}</div>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('.order-item').forEach(el => {
      el.onclick = () => this.openInput(el.dataset.id);
    });
  },

  openInput(orderId) {
    let order = orderId ? this.state.orders.find(o => o.orderId === orderId) : null;
    this.state.currentOrder = order;
    document.getElementById('input-account').textContent = order ? order.account : '（手動入力）';
    document.getElementById('input-order-id').value = order ? order.orderId : '';
    document.getElementById('input-country').value = order ? order.country : '';
    document.getElementById('input-weight').value = order && order.weightG ? order.weightG : '';
    document.getElementById('input-length').value = order && order.lengthCm ? order.lengthCm : '';
    document.getElementById('input-width').value = order && order.widthCm ? order.widthCm : '';
    document.getElementById('input-height').value = order && order.heightCm ? order.heightCm : '';
    document.getElementById('input-title').textContent = order ? '発送情報入力' : '手動入力';
    this.show('screen-input');
  },

  calculate() {
    const input = {
      country: document.getElementById('input-country').value,
      weightG: parseInt(document.getElementById('input-weight').value, 10),
      lengthCm: parseFloat(document.getElementById('input-length').value),
      widthCm: parseFloat(document.getElementById('input-width').value),
      heightCm: parseFloat(document.getElementById('input-height').value)
    };
    if (!input.country) return showToast('発送先国を選択してください');
    if (!input.weightG || !input.lengthCm || !input.widthCm || !input.heightCm) {
      return showToast('重量・寸法を入力してください');
    }
    this.state.currentInput = input;
    const result = Calculator.calculate(input);
    this.state.currentResult = result;
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
    list.innerHTML = result.candidates.map((c, i) => `
      <div class="result-card${i === 0 ? ' recommend' : ''}" data-idx="${i}">
        <div>
          ${i === 0 ? '<div class="recommend-badge">最安・推奨</div>' : ''}
          <div class="carrier">${escapeHtml(c.carrier)}</div>
          <div class="meta">${escapeHtml(c.detail)} / 請求重量 ${c.billableG}g</div>
          ${c.surcharge > 0 ? `<div class="meta">+ サーチャージ ¥${c.surcharge}（${(c.surchargeReasons||[]).join(', ')}）</div>` : ''}
          <div class="meta">${c.tracking ? '追跡あり' : ''} ${c.insurance ? '/ 補償あり' : ''}</div>
        </div>
        <div>
          <div class="price">¥${c.totalCost.toLocaleString()}</div>
          <div class="days">${escapeHtml(c.estimatedDays)}</div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.result-card').forEach(el => {
      el.onclick = () => {
        list.querySelectorAll('.result-card').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        this.state.selectedCarrierIndex = parseInt(el.dataset.idx, 10);
      };
    });
    list.querySelector('.result-card').classList.add('selected');
    document.getElementById('btn-confirm').classList.remove('hidden');
  },

  async confirmShipment() {
    const c = this.state.currentResult.candidates[this.state.selectedCarrierIndex];
    if (!c) return;
    const orderId = document.getElementById('input-order-id').value.trim();
    if (!orderId) return showToast('注文IDを入力してください');
    const i = this.state.currentInput;
    const data = {
      orderId,
      weightG: i.weightG,
      lengthCm: i.lengthCm,
      widthCm: i.widthCm,
      heightCm: i.heightCm,
      carrier: c.carrier,
      cost: c.totalCost,
      alternatives: this.state.currentResult.candidates.slice(1).map(x => x.carrier + ' ¥' + x.totalCost).join(' / ')
    };
    document.getElementById('btn-confirm').disabled = true;
    try {
      const res = await API.writeShipment(data);
      if (res.error) throw new Error(res.error);
      showToast('Sheetsに書込みました');
      await this.loadAll();
    } catch (err) {
      showToast('書込み失敗: ' + err.message);
    } finally {
      document.getElementById('btn-confirm').disabled = false;
    }
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => App.init());
