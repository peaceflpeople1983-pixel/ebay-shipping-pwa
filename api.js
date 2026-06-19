/**
 * Apps Script Web App との通信
 */
const API = {
  config: { url: '', secret: '' },
  MASTER_CACHE_TTL: 24 * 60 * 60 * 1000, // 24時間
  DEFAULT_DAYS_BACK: 60,                  // 直近60日分を表示 (メール救済orderも含めて表示)

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
   * v3.15: CPaSS Inbox の取込実行
   * Apps Script の scanInboxFolder() を呼んで Drive Inbox 内の xlsx を取込
   * 戻り値: { files_processed: N }
   */
  async runCpassImport() {
    return this._get('?action=cpassRunImport');
  },

  /**
   * v3.15: CPaSS ステータス取得 (Inbox + 未取込数)
   * 通常は getOrders に同梱されるので個別呼出は不要だが、保険として用意
   */
  async getCpassStatus() {
    return this._get('?action=cpassStatus');
  },

  /**
   * v3.2.5: Amazon仕入値 手動取得(設定画面ボタン)。増分取込(新規CSVのみ)。
   * 戻り値: { ok, files, rows, added, updated, skipped, note } | { ok:false, reason }
   */
  async runAmazonCostImport() {
    return this._get('?action=amazonCostImport');
  },

  /**
   * v3.2.5: Amazon仕入値メタ状態 (設定画面メタ表示用)
   * 戻り値: { ok, asinCount, lastImportAt }
   */
  async getAmazonCostStatus() {
    return this._get('?action=amazonCostStatus');
  },

  /**
   * v3.16: 印刷機能
   */
  async getPrintTargets() {
    // バルク印刷対象 (未発送 + CPaSS取込済 + 印刷済でない) の orderIds + count を返す
    return this._get('?action=printGetTargets');
  },

  async getPrintData(orderIds) {
    // orderIds が空配列ならサーバ側で getBulkPrintTargets を呼ぶ
    const ids = (orderIds || []).join(',');
    const q = '?action=printGetData' + (ids ? '&orderIds=' + encodeURIComponent(ids) : '');
    return this._get(q);
  },

  async markPrinted(orderIds) {
    // 印刷済タイムスタンプを Y列に書込む
    const ids = (orderIds || []).join(',');
    return this._get('?action=printMark&orderIds=' + encodeURIComponent(ids));
  },

  async unmarkPrinted(orderId) {
    // 単一注文の Y列クリア
    return this._get('?action=printUnmark&orderId=' + encodeURIComponent(orderId));
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

  /**
   * v1.0 キャンセル通知: 未印刷通知件数 + orderId一覧
   *   戻り値: { unprintedCancellations, byAccount, hasItems, orderIds }
   */
  async getCancelTargets() {
    return this._get('?action=cancelGetTargets');
  },

  /**
   * v1.0 キャンセル通知: 印刷用詳細データ
   *   戻り値: { orders, count, byAccount }
   */
  async getCancelPrintData() {
    return this._get('?action=cancelGetPrintData');
  },

  /**
   * v1.0 キャンセル通知: 印刷完了マーク (AQ列セット)
   *   @param {string[]} orderIds 印刷完了した orderId 群
   */
  async markCancelPrinted(orderIds) {
    return this._post({
      action: 'cancelMarkPrinted',
      secret: this.config.secret,
      orderIds: orderIds || []
    });
  },

  /**
   * v1.0 キャンセル通知: 手動キャンセルチェック (PWAボタンから)
   */
  async detectCancelNow() {
    return this._post({
      action: 'cancelDetectNow',
      secret: this.config.secret
    });
  },

  /**
   * RECOVERY v1.2: 未取得 order 候補 + API 3分類 + メールプレビュー
   *   戻り値: { candidates:[{orderId,account,status,email}], counts, generatedAt }
   */
  async recoveryGetMissing() {
    return this._get('?action=recoveryGetMissing');
  },

  /**
   * RECOVERY v1.2: 1件 API フル取込 (AR='api')
   */
  async recoveryFetchOne(orderId) {
    return this._post({
      action: 'recoveryFetchOne',
      secret: this.config.secret,
      orderId: orderId
    });
  },

  /**
   * RECOVERY v1.2: 1件 メール情報で追加 (仮 AR='email')
   */
  async recoveryAddFromEmail(orderId) {
    return this._post({
      action: 'recoveryAddFromEmail',
      secret: this.config.secret,
      orderId: orderId
    });
  },

  /**
   * Phase B: 手動「発送済にする/解除」(AS=FULFILLED/'')。eBay非送信・表示フラグのみ。
   */
  async recoveryMarkShipped(orderId, shipped) {
    return this._post({
      action: 'recoveryMarkShipped',
      secret: this.config.secret,
      orderId: orderId,
      shipped: shipped
    });
  },

  /**
   * 手動「キャンセル済にする/解除」(AP=cancelledAt)。eBay非送信・表示フラグのみ。
   */
  async recoveryMarkCancelled(orderId, cancelled) {
    return this._post({
      action: 'recoveryMarkCancelled',
      secret: this.config.secret,
      orderId: orderId,
      cancelled: cancelled
    });
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
