/**
 * Apps Script Web App との通信
 */
const API = {
  config: { url: '', secret: '' },

  loadConfig() {
    const saved = localStorage.getItem('app_config');
    if (saved) this.config = JSON.parse(saved);
    return !!this.config.url;
  },

  saveConfig(url, secret) {
    this.config = { url, secret };
    localStorage.setItem('app_config', JSON.stringify(this.config));
  },

  async getMasterData() {
    return this._get('?action=getMasterData');
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
