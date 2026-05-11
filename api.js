/**
 * Apps Script Web App との通信
 */
const API = {
  config: { url: '', secret: '' },
  MASTER_CACHE_TTL: 24 * 60 * 60 * 1000, // 24時間
  DEFAULT_DAYS_BACK: 15,                  // 直近15日分のみ表示
 
  loadConfig() {
    const saved = localStorage.getItem('app_config');
    if (saved) this.config = JSON.parse(saved);
    return !!this.config.url;
  },
 
  saveConfig(url, secret) {
    this.config = { url, secret };
    localStorage.setItem('app_config', JSON.stringify(this.config));
  },
 
  async getMasterData(forceRefresh) {
    if (!forceRefresh) {
      const cached = this._loadCache('master_data', this.MASTER_CACHE_TTL);
      if (cached && Array.isArray(cached.countries) && cached.countries.length >= 10) {
        return cached;
      }
      this.clearMasterCache();
    }
    const data = await this._get('?action=getMasterData');
    if (data && Array.isArray(data.countries) && data.countries.length >= 10) {
      this._saveCache('master_data', data);
    }
    return data;
  },
 
  _loadCache(key, ttlMs) {
    try {
      const raw = localStorage.getItem('cache_' + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.timestamp > ttlMs) return null;
      return obj.data;
    } catch (e) { return null; }
  },
 
  _saveCache(key, data) {
    try {
      localStorage.setItem('cache_' + key, JSON.stringify({
        data: data,
        timestamp: Date.now()
      }));
    } catch (e) {}
  },
 
  clearMasterCache() {
    localStorage.removeItem('cache_master_data');
  },
 
  async getOrders(account, limit, daysBack) {
    let q = '?action=getOrders';
    if (account) q += '&account=' + encodeURIComponent(account);
    if (limit) q += '&limit=' + limit;
    const days = (daysBack == null) ? this.DEFAULT_DAYS_BACK : daysBack;
    if (days) q += '&daysBack=' + days;
    return this._get(q);
  },
 
  async syncOrders() {
    return this._get('?action=syncOrders');
  },
 
  /**
   * Sheets書込み（バックグラウンド）。
   * 戻り値の Promise を await しなくても処理は継続する。
   * UI を返してから resolve されるまで保持する場合は呼び出し側で .then() を使う。
   */
  async writeShipment(data) {
    return this._post({ action: 'writeShipment', secret: this.config.secret, data });
  },
 
  async extractOrderId(base64Image) {
    return this._post({ action: 'extractOrderId', secret: this.config.secret, image: base64Image });
  },
 
  async _get(query) {
    const res = await fetch(this.config.url + query, { method: 'GET' });
    if (!res.ok) throw new Error('API error: ' + res.status);
    return res.json();
  },
 
  async _post(body) {
    const res = await fetch(this.config.url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain' }
    });
    if (!res.ok) throw new Error('API error: ' + res.status);
    return res.json();
  }
};
 
/**
 * 本日の作業グループ：localStorageに永続化
 *  形式: { ids: ['14-...','14-...'], createdAt: timestamp }
 *  全件発送済みになるか、ユーザーがクリアするまで保持。
 */
const TodayGroup = {
  KEY: 'today_group',
 
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return { ids: [], createdAt: 0 };
      const obj = JSON.parse(raw);
      return { ids: obj.ids || [], createdAt: obj.createdAt || 0 };
    } catch (e) { return { ids: [], createdAt: 0 }; }
  },
 
  save(group) {
    localStorage.setItem(this.KEY, JSON.stringify(group));
  },
 
  add(orderId) {
    const g = this.load();
    if (!g.ids.includes(orderId)) {
      g.ids.push(orderId);
      if (!g.createdAt) g.createdAt = Date.now();
      this.save(g);
    }
  },
 
  remove(orderId) {
    const g = this.load();
    g.ids = g.ids.filter(id => id !== orderId);
    if (g.ids.length === 0) g.createdAt = 0;
    this.save(g);
  },
 
  clear() {
    localStorage.removeItem(this.KEY);
  },
 
  has(orderId) {
    return this.load().ids.includes(orderId);
  },
 
  count() {
    return this.load().ids.length;
  }
};
