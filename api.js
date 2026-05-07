/**
 * Apps Script Web App との通信
 */
const API = {
  config: { url: '', secret: '' },
  MASTER_CACHE_TTL: 24 * 60 * 60 * 1000, // 24時間
 
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
      if (cached) return cached;
    }
    const data = await this._get('?action=getMasterData');
    this._saveCache('master_data', data);
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
 
  async getOrders(account, limit) {
    let q = '?action=getOrders';
    if (account) q += '&account=' + encodeURIComponent(account);
    if (limit) q += '&limit=' + limit;
    return this._get(q);
  },
 
  async syncOrders() {
    return this._get('?action=syncOrders');
  },
 
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
