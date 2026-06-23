/**
 * zonos.js — Zonos PrePay 連携機能 (PWAクライアント新規ファイル / v1.0)
 *
 * 仕様: zonos_integration_mockup_v2.html 参照
 *
 * 主な機能:
 *   - Zonos対象判定 (PWA側でも独立判定可能 / Sheets列を信頼)
 *   - Zonosバッジ・バナー描画ヘルパー
 *   - 残時間判定 computeZonosDeadlineMeta
 *   - 送信画面 (screen-zonos) のロジック
 *   - クリップボード操作・進捗管理・Declaration ID保存
 *
 * 既存ファイルとの関係:
 *   - 既存 App オブジェクトに依存しない独立ヘルパー群 + Zonos画面コントローラ
 *   - app.js への組み込みは ZONOS_PWA_PATCHES.md 参照
 *
 * グローバル: window.Zonos
 */

(function() {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================

  // Apps Script側の ECONOMY_POLICIES と同じ (フォールバック用)
  const ECONOMY_POLICIES = [
    'ePacketライト',
    'Economy International Shipping',
    'Economy Shipping from outside US',
    'SpeedPAK Economy',
    'eBay SpeedPAK Economy',
    'SpeedPAK Eco'
  ];

  const DEADLINE_THRESHOLDS = {
    red:    24 * 60 * 60 * 1000,
    orange: 48 * 60 * 60 * 1000,
    yellow:  4 * 24 * 60 * 60 * 1000
  };

  // ============================================================
  // ヘルパー: 対象判定
  // ============================================================

  /**
   * 注文がZonos対象か (Sheets側の isZonosTarget を信頼するが、無い場合はフォールバック判定)
   */
  function isZonosTargetOrder(o) {
    if (!o) return false;
    if (o.isZonosTarget === true || o.isZonosTarget === 'true') return true;
    // フォールバック判定
    if (String(o.country || '').toUpperCase() !== 'US') return false;
    const p = String(o.shippingPolicy || '');
    if (ECONOMY_POLICIES.indexOf(p) !== -1) return true;
    const lp = p.toLowerCase();
    if (lp.indexOf('economy') !== -1 && lp.indexOf('expedited') === -1) return true;
    if (lp.indexOf('epacket') !== -1) return true;
    return false;
  }

  // ============================================================
  // ヘルパー: 残時間計算
  // ============================================================

  /**
   * Declaration ID 期限の残時間を計算 (4段階)
   *
   * @param {string} expiresAtIso - ISO 8601
   * @return {Object} { level, label, daysLeft, msLeft }
   */
  function computeZonosDeadlineMeta(expiresAtIso) {
    if (!expiresAtIso) {
      return { level: 'gray', label: '期限なし', daysLeft: null, msLeft: null };
    }
    try {
      const expires = new Date(expiresAtIso).getTime();
      if (isNaN(expires)) {
        return { level: 'gray', label: '期限不明', daysLeft: null, msLeft: null };
      }
      const now = Date.now();
      const msLeft = expires - now;
      const daysLeft = Math.round(msLeft / (24 * 60 * 60 * 1000) * 10) / 10;
      const hoursLeft = Math.round(msLeft / (60 * 60 * 1000));

      let level, label;
      if (msLeft < 0) {
        level = 'red';
        label = '⛔ 超過';
      } else if (msLeft <= DEADLINE_THRESHOLDS.red) {
        level = 'red';
        label = '残' + hoursLeft + 'h';
      } else if (msLeft <= DEADLINE_THRESHOLDS.orange) {
        level = 'orange';
        label = '残' + Math.ceil(hoursLeft / 24) + '日';
      } else if (msLeft <= DEADLINE_THRESHOLDS.yellow) {
        level = 'yellow';
        label = '残' + Math.ceil(hoursLeft / 24) + '日';
      } else {
        level = 'green';
        label = '残' + Math.ceil(hoursLeft / 24) + '日';
      }
      return { level: level, label: label, daysLeft: daysLeft, msLeft: msLeft };
    } catch (e) {
      return { level: 'gray', label: '期限不明', daysLeft: null, msLeft: null };
    }
  }

  // ============================================================
  // ヘルパー: バッジHTMLの生成
  // ============================================================

  /**
   * 注文カード用のZonosバッジHTMLを構築。対象外の注文には空文字を返す。
   *
   * @param {Object} o - order オブジェクト (getOrders レスポンス)
   * @return {string} HTML
   */
  function buildZonosBadge(o) {
    if (!isZonosTargetOrder(o)) return '';
    if (o.trackingNumber) return ''; // 発送済はバッジ非表示
    const ddpId = o.declarationId || '';
    const role = o.doukonRole || '';
    if (ddpId) {
      // Declaration ID 取得済 → 期限バッジ
      const m = computeZonosDeadlineMeta(o.declarationExpiresAt);
      if (m.level === 'red') {
        return '<span class="badge zonos-critical">⛔ Zonos ' + escapeHtmlZ_(m.label) + '</span>';
      }
      if (m.level === 'orange') {
        return '<span class="badge zonos-urgent">⚠ Zonos ' + escapeHtmlZ_(m.label) + '</span>';
      }
      return '<span class="badge zonos-done">✓ Zonos済</span>';
    }
    // 未送信
    if (role === 'sub') {
      return '<span class="badge zonos-pending">🆕 Zonos未 (代表へ)</span>';
    }
    return '<span class="badge zonos-pending">🆕 Zonos未</span>';
  }

  /**
   * 対象外注文に表示する注記HTML
   */
  function buildZonosScopeNote(o) {
    if (isZonosTargetOrder(o)) return '';
    if (!o.country || !o.shippingPolicy) return '';
    if (String(o.country).toUpperCase() !== 'US') {
      return '<span class="sub-note zonos-na">⚖ 米国以外のためZonos対象外</span>';
    }
    return '<span class="sub-note zonos-na">⚖ ' + escapeHtmlZ_(o.shippingPolicy) + 'のためZonos対象外</span>';
  }

  /**
   * 注文一覧上部のZonos期限切迫バナー (残24h以内が1件以上で表示)
   * 既存バナーDOMの直前に挿入する想定
   */
  function buildZonosExpireBanner(orders) {
    let criticalCount = 0;
    let urgentCount = 0;
    const seenGroups = new Set();
    (orders || []).forEach(o => {
      if (!isZonosTargetOrder(o)) return;
      if (o.trackingNumber) return;
      if (!o.declarationId) return;
      if (o.doukonGroupId) {
        if (seenGroups.has(o.doukonGroupId)) return;
        seenGroups.add(o.doukonGroupId);
      }
      const m = computeZonosDeadlineMeta(o.declarationExpiresAt);
      if (m.level === 'red') criticalCount++;
      else if (m.level === 'orange') urgentCount++;
    });

    if (criticalCount === 0 && urgentCount === 0) return '';
    if (criticalCount > 0) {
      return '<div class="banner zonos-expire">' +
        '<span class="banner-icon">⛔</span>' +
        '<div class="banner-body">' +
          '<div class="banner-main">Zonos期限切迫: <strong>' + criticalCount + '件</strong></div>' +
          '<div class="banner-sub">5日決済期限が24時間以内</div>' +
        '</div>' +
      '</div>';
    }
    return '<div class="banner zonos-pending">' +
      '<span class="banner-icon">⚠</span>' +
      '<div class="banner-body">' +
        '<div class="banner-main">Zonos期限間近: <strong>' + urgentCount + '件</strong></div>' +
        '<div class="banner-sub">5日決済期限が48時間以内</div>' +
      '</div>' +
    '</div>';
  }

  // ============================================================
  // Zonos送信画面 (screen-zonos) コントローラ
  // ============================================================

  const ZonosScreen = {
    state: {
      orderId: null,
      data: null,        // zonosGetData レスポンス
      copiedFields: {},  // { 'fullName': true, 'phone': true, ... }
    },

    /**
     * 画面を開く
     * @param {string} orderId
     */
    async open(orderId) {
      this.state.orderId = orderId;
      this.state.data = null;
      this.state.copiedFields = {};

      showScreen('screen-zonos');
      this._renderLoading();

      try {
        const data = await this._fetchData(orderId);
        if (data.error) {
          this._renderError(data.error);
          return;
        }
        this.state.data = data;
        this._render();
      } catch (err) {
        this._renderError(err.message || String(err));
      }
    },

    async _fetchData(orderId) {
      // API.config を使う (既存パターン)
      const url = API.config.url + '?action=zonosGetData&orderId=' + encodeURIComponent(orderId);
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error('Zonos API error: ' + res.status);
      return res.json();
    },

    _renderLoading() {
      const root = document.getElementById('zonos-content');
      if (root) root.innerHTML = '<div class="loader">読み込み中...</div>';
    },

    _renderError(msg) {
      const root = document.getElementById('zonos-content');
      if (root) {
        root.innerHTML = '<div class="empty" style="padding:24px;">⚠ ' + escapeHtmlZ_(msg) + '</div>';
      }
    },

    _render() {
      const d = this.state.data;
      if (!d) return;
      const root = document.getElementById('zonos-content');
      if (!root) return;

      const r = d.recipient;
      const isDoukon = d.isDoukon && d.doukonCount > 1;
      const existingDdp = d.existingDeclaration && d.existingDeclaration.declarationId;

      // 各コピペフィールドのHTML
      const fields = [
        { key: 'fullName', label: 'FULL NAME', value: r.fullName, required: true },
        { key: 'phone', label: 'PHONE', value: r.phone, required: false },
        { key: 'addrLine1', label: 'STREET ADDRESS', value: r.addrLine1, required: true },
        { key: 'addrLine2', label: 'STREET ADDRESS 2', value: r.addrLine2, required: false, skipIfEmpty: true },
        { key: 'city', label: 'CITY', value: r.city, required: true },
        { key: 'state', label: 'STATE', value: r.state, required: true },
        { key: 'postalCode', label: 'POSTAL CODE', value: r.postalCode, required: true },
        { key: 'country', label: 'COUNTRY', value: r.countryFull, required: true }
      ];

      let html = '';

      // 同梱インフォボックス
      if (isDoukon) {
        html += '<div class="doukon-info">' +
          '<div class="doukon-info-title">📦 同梱グループ・代表 (' + d.doukonCount + '点まとめて1宣言)</div>' +
          '<div>このZonos送信で<strong>' + d.doukonCount + '件の商品</strong>を1つのDeclaration IDで申請します。</div>' +
          '<ul class="doukon-info-list">' +
            d.items.map(it => '<li><strong>' + (it.role === 'lead' ? '代表' : 'サブ') + ':</strong> ' +
              escapeHtmlZ_(it.orderId) + ' (' + escapeHtmlZ_(truncate_(it.itemTitle, 40)) + ')</li>').join('') +
          '</ul>' +
        '</div>';
      }

      // 進捗
      // 1 ITEM あたりのフィールド数: description / value / countryOfOrigin / quantity
      //   + weightG が有効なら weight も加算 (同梱は全 ITEM 同じ weightG なので 0/N の二択)
      const hasWeight = d.items.some(it => it.weightG && it.weightG > 0);
      const hasHs = d.items.some(it => it.hsCode);
      // 1 ITEM あたりコピー欄: description / value / ndg / madein / quantity (+weight +hs)
      const fieldsPerItem = 5 + (hasWeight ? 1 : 0) + (hasHs ? 1 : 0);
      const totalFields = fields.filter(f => !f.skipIfEmpty || f.value).length +
                           d.items.length * fieldsPerItem;
      const copiedCount = Object.keys(this.state.copiedFields).length;
      const progressPct = totalFields > 0 ? Math.round(copiedCount / totalFields * 100) : 0;
      html += '<div class="zonos-progress">' +
        '<div>' +
          '<div class="zonos-progress-text">' + escapeHtmlZ_(d.orderId) +
            (isDoukon ? ' (同梱' + d.doukonCount + '件)' : '') + '</div>' +
          '<div class="zonos-progress-num">' + copiedCount + ' / ' + totalFields + ' 完了</div>' +
        '</div>' +
        '<div style="font-size:24px;">' + (isDoukon ? '📦' : '📋') + '</div>' +
      '</div>' +
      '<div class="zonos-progress-bar" style="margin: 0 14px 12px;">' +
        '<div class="zonos-progress-fill" style="width:' + progressPct + '%;"></div>' +
      '</div>';

      // RECIPIENT カード
      html += '<div class="zonos-card">' +
        '<div class="zonos-card-head">▍ RECIPIENT (受取人' + (isDoukon ? ' = 同梱先' : '') + ')</div>';
      fields.forEach(f => {
        if (f.skipIfEmpty && !f.value) return;
        html += this._renderField(f.key, f.label, f.value);
      });
      html += '</div>';

      // ITEMS カード (同梱なら1/N, 2/N...) — ★v3.3 PC受け渡し用に再構成
      d.items.forEach((it, idx) => {
        const label = isDoukon ? ('ITEM ' + (idx + 1) + '/' + d.items.length) : 'ITEM';
        html += '<div class="zonos-card">' +
          '<div class="zonos-card-head">▍ ' + label + ' — ' + escapeHtmlZ_(truncate_(it.itemTitle, 40)) + '</div>';
        // DESCRIPTION(英語名)+ 30字メーター(税関説明上限)
        html += this._renderField('description_' + idx, 'DESCRIPTION (英語)', it.description, true);
        html += this._renderCharMeter(it.description, 30);
        // 日本語サブラベル(表示のみ・コピー不可)= Amazon日本語商品名。無ければeBay名にフォールバック
        var jaLabel = it.amazonTitleJa || it.itemTitle;
        if (jaLabel) {
          const jaSrc = it.amazonTitleJa ? 'Amazon商品名' : 'eBay名(Amazon名なし)';
          html += '<div class="zonos-sublabel">🇯🇵 ' + escapeHtmlZ_(jaLabel) +
            ' <span class="zonos-sublabel-note">(' + jaSrc + '・表示のみ)</span></div>';
        }
        // VALUE: Amazon仕入値 (JPY)。未取得は警告し、誤って¥0申告を防ぐ
        if (it.costMissing) {
          html += '<div class="zonos-cost-missing">⚠ 仕入値 未取得 — 申告価格を手動で確認してください</div>';
        } else {
          html += this._renderField('value_' + idx, 'VALUE (Amazon仕入値/JPY)', String(it.value),
            false, '', '¥' + Number(it.value).toLocaleString());
        }
        // NON-DANGEROUS GOODS REASON = (CPaSS番号) no battery, no glue / 日本語
        html += this._renderField('ndg_' + idx, 'NON-DANGEROUS GOODS REASON', it.nonDangerousReason);
        // MADE IN(Zonos既定はChina → Japanへ)
        html += this._renderField('madein_' + idx, 'MADE IN', it.madeIn || 'Japan');
        html += '<div class="zonos-madein-warn">⚠ Zonos既定は <b>China</b>。欄に「Japan」を貼付/入力し候補から選択</div>';
        // QUANTITY
        html += this._renderField('quantity_' + idx, 'QUANTITY', String(it.quantity));
        // HARMONIZED CODE(任意)
        if (it.hsCode) {
          html += this._renderField('hs_' + idx, 'HARMONIZED CODE (任意)', it.hsCode);
        }
        // UNIT WEIGHT: 表示 "850 g" / コピー "850"(g単位、同梱の全ITEMに同じ値)。未入力は非表示
        if (it.weightG && it.weightG > 0) {
          html += this._renderField('weight_' + idx, 'UNIT WEIGHT', String(it.weightG), false, ' g');
        }
        html += '</div>';
      });

      // 商品画像 (タップで写真ライブラリへ保存)
      if (d.items.length > 0 && d.items.some(it => it.imageUrl)) {
        html += '<div class="zonos-card">' +
          '<div class="zonos-card-head">▍ 商品画像 (クリックでDL → Zonosに添付)</div>' +
          '<div class="product-images">';
        d.items.forEach((it, idx) => {
          if (it.imageUrl) {
            // ファイル名: zonos_<orderId>_<idx>.jpg
            const safeOrderId = String(d.orderId || 'item').replace(/[^a-zA-Z0-9-]/g, '_');
            const filename = 'zonos_' + safeOrderId + '_' + (idx + 1) + '.jpg';
            html += '<div class="product-img clickable" ' +
              'data-zonos-img-url="' + escapeAttrZ_(it.imageUrl) + '" ' +
              'data-zonos-img-filename="' + escapeAttrZ_(filename) + '">' +
              '<img src="' + escapeAttrZ_(it.imageUrl) +
              '" alt="" loading="lazy" onerror="this.style.display=&quot;none&quot;">' +
              '<div class="product-img-icon">📥</div>' +
              '<div class="product-img-label">IMG ' + (idx + 1) + '</div>' +
            '</div>';
          }
        });
        html += '</div>' +
          '<div style="font-size:10.5px; color:var(--text-secondary); padding:8px 12px 10px; line-height:1.5;">' +
            '💡 PC: クリックで画像をダウンロード → Zonos web版の「Browse / ドラッグ」で添付(Snipping Tool不要)。スマホ: タップで写真保存。' +
          '</div>' +
        '</div>';
      }

      // 合計金額 (同梱のみ)
      if (isDoukon) {
        html += '<div style="margin: 12px 14px; padding: 10px 12px; background: #E1F5EE; ' +
          'border-radius: 8px; font-size: 11.5px; color: #0F6E56;">' +
          '💡 <strong>合計: ' + d.totalValue.toFixed(2) + ' USD × 1パッケージ</strong></div>';
      }

      // Declaration ID 入力
      const titleText = existingDdp
        ? '✓ Declaration ID 入力済'
        : '⬇ Zonosで決済完了後、ここに入力';
      const inputValue = existingDdp || '';
      const saveText = isDoukon ? (d.doukonCount + '件に保存') : '保存';
      html += '<div class="declaration-block">' +
        '<div class="declaration-block-title">' + titleText + '</div>' +
        '<div class="declaration-input">' +
          '<input type="text" id="zonos-declaration-input" placeholder="Declaration IDを入力" value="' + escapeAttrZ_(inputValue) + '">' +
          '<button id="zonos-save-btn">' + saveText + '</button>' +
        '</div>';
      if (existingDdp) {
        const m = computeZonosDeadlineMeta(d.existingDeclaration.expiresAt);
        html += '<div style="margin-top: 8px; padding: 8px 10px; background: #E1F5EE; border-radius: 6px; ' +
          'font-size: 11.5px; color: #0F6E56;">' +
          '<strong>取得 ' + escapeHtmlZ_(formatDt_(d.existingDeclaration.paidAt)) + '</strong> / ' +
          '期限 ' + escapeHtmlZ_(formatDt_(d.existingDeclaration.expiresAt)) +
          ' (' + escapeHtmlZ_(m.label) + ')</div>';
      }
      html += '</div>';

      // Zonos web版を開く(PC・主) + アプリ(スマホ・副)
      html += '<button class="primary-btn" id="zonos-open-web-btn">🌐 Zonos Prepay web版を開く</button>';
      html += '<button class="primary-btn zonos-secondary-btn" id="zonos-open-app-btn">📲 Zonosアプリを開く(スマホ)</button>';
      html += '<div style="height: 24px;"></div>';

      root.innerHTML = html;

      // イベントバインド
      this._bindEvents();
    },

    /**
     * @param {string} key       - 識別キー (進捗管理用)
     * @param {string} label     - 表示ラベル (例: 'WEIGHT')
     * @param {string} value     - 表示値 兼 コピー値 (両者を分けたい場合は displaySuffix を使う)
     * @param {boolean} [isAiTranslated]
     * @param {string} [displaySuffix] - 表示にのみ付加する単位等 (例: ' g')。コピーには含まれない
     */
    _renderField(key, label, value, isAiTranslated, displaySuffix, displayValue) {
      if (!value && value !== 0) return '';
      const isCopied = !!this.state.copiedFields[key];
      const cls = isCopied ? 'done' : '';
      const btnText = isCopied ? '✓ 済' : '📋';
      const btnCls = isCopied ? 'done' : '';
      // 表示値(displayValue があればそれを表示。コピー値は常に value)
      const shownRaw = (displayValue != null && displayValue !== '') ? String(displayValue) : String(value);
      const shownHtml = escapeHtmlZ_(shownRaw);
      const suffixHtml = displaySuffix
        ? '<span class="copy-field-unit">' + escapeHtmlZ_(displaySuffix) + '</span>'
        : '';
      const aiTag = isAiTranslated ? '<span class="ai-tag">AI英訳</span>' : '';
      // 「要確認」は英訳DESCRIPTIONに日本語が残っている場合のみ(日本語が正規の欄では出さない)
      const warnTag = (isAiTranslated && containsNonAscii_(String(value)))
        ? '<span class="warn-tag">⚠ 要確認</span>'
        : '';
      return '<div class="copy-field ' + cls + '" data-field-key="' + escapeAttrZ_(key) + '">' +
        '<div class="copy-field-info">' +
          '<div class="copy-field-key">' + escapeHtmlZ_(label) + '</div>' +
          '<div class="copy-field-value">' + shownHtml + suffixHtml + aiTag + warnTag + '</div>' +
        '</div>' +
        '<button class="copy-btn ' + btnCls + '" data-copy-value="' + escapeAttrZ_(String(value)) + '" ' +
          'data-copy-key="' + escapeAttrZ_(key) + '">' + btnText + '</button>' +
      '</div>';
    },

    /** DESCRIPTION の30字メーター(税関説明の既定上限) */
    _renderCharMeter(text, limit) {
      const n = String(text || '').length;
      const ok = n <= limit;
      const cls = ok ? 'ok' : 'bad';
      const msg = ok
        ? (n + ' / ' + limit + ' 字 ✓ 税関説明に収まる')
        : (n + ' / ' + limit + ' 字 ⚠ 超過 — 名前を短縮推奨(税関側で切詰めの恐れ)');
      return '<div class="zonos-charmeter ' + cls + '">' + escapeHtmlZ_(msg) + '</div>';
    },

    _bindEvents() {
      const root = document.getElementById('zonos-content');
      if (!root) return;

      // コピペボタン
      root.querySelectorAll('.copy-btn[data-copy-value]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const val = btn.getAttribute('data-copy-value');
          const key = btn.getAttribute('data-copy-key');
          this._copyToClipboard(val, key, btn);
        });
      });

      // 商品画像タップ → 写真ライブラリへ保存
      root.querySelectorAll('[data-zonos-img-url]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          const url = el.getAttribute('data-zonos-img-url');
          const filename = el.getAttribute('data-zonos-img-filename') || 'zonos_image.jpg';
          this._downloadImage(url, filename, el);
        });
      });

      // 保存ボタン
      const saveBtn = document.getElementById('zonos-save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this._saveDeclaration());
      }

      // Zonos web版を開く(PC)
      const openWebBtn = document.getElementById('zonos-open-web-btn');
      if (openWebBtn) {
        openWebBtn.addEventListener('click', () => this._openZonosWeb());
      }

      // Zonosアプリを開く(スマホ)
      const openBtn = document.getElementById('zonos-open-app-btn');
      if (openBtn) {
        openBtn.addEventListener('click', () => this._openZonosApp());
      }
    },

    /** Zonos Prepay web版 (PC) を新規タブで開く */
    _openZonosWeb() {
      window.open('https://dashboard.zonosprepay.com/', '_blank', 'noopener');
    },

    /**
     * 商品画像を iPhone 写真ライブラリへ保存
     *  - Tier 1: fetch + Web Share API (ワンタップ・iOS 15+)
     *  - Tier 2: fetchが成功してShareが使えない場合はBlob URL経由ダウンロード
     *  - Tier 3: fetchがCORSで失敗したら画像URLを新タブで開く (ユーザーが長押しで保存)
     */
    async _downloadImage(imageUrl, filename, el) {
      if (!imageUrl) return;

      // ビジュアル: ダウンロード中表示
      if (el) el.classList.add('downloading');

      try {
        // Tier 1: fetch を試す
        let blob = null;
        try {
          const response = await fetch(imageUrl, { mode: 'cors' });
          if (response.ok) {
            blob = await response.blob();
          }
        } catch (fetchErr) {
          // CORS失敗等 — 後でTier 3 (新タブ) にフォールバック
          console.warn('Zonos image fetch failed (CORS等):', fetchErr.message);
        }

        if (blob) {
          // File オブジェクトを作成
          const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });

          // Tier 1: Web Share API はモバイルのみ。
          //   ★v3.3 fix: PC(Windows等)では共有シートが出てファイル保存/添付できないため使わず、
          //   Tier 2(ファイルDL)へ直行する。
          const isMobileLike = (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')) ||
            (navigator.maxTouchPoints > 1 && !/Windows NT/i.test(navigator.userAgent || ''));
          if (isMobileLike && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: filename });
              if (typeof showToast === 'function') showToast('共有シートを開きました');
              return;
            } catch (shareErr) {
              if (shareErr.name === 'AbortError') {
                // ユーザーがキャンセル — トースト不要
                return;
              }
              console.warn('Web Share API failed:', shareErr);
              // フォールバックへ
            }
          }

          // Tier 2: Blob URLでダウンロード (Web Shareが無い場合)
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // Blob URLは少し残してから開放 (iOS Safariで navigation を確実にするため)
          setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
          if (typeof showToast === 'function') showToast('ダウンロード開始');
          return;
        }

        // Tier 3: 画像URLを新タブで開く (CORSで取得不可な場合のフォールバック)
        // iOS Safari は画像を全画面表示するので、ユーザーが長押し→「写真に保存」可能
        const a = document.createElement('a');
        a.href = imageUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (typeof showToast === 'function') {
          showToast('画像を長押し→「写真に保存」を選んでください');
        }

      } catch (e) {
        console.error('Image download error:', e);
        if (typeof showToast === 'function') {
          showToast('画像保存失敗: ' + e.message);
        }
      } finally {
        if (el) el.classList.remove('downloading');
      }
    },

    async _copyToClipboard(value, key, btn) {
      try {
        await navigator.clipboard.writeText(value);
        this.state.copiedFields[key] = true;
        // ビジュアル更新
        const field = btn.closest('.copy-field');
        if (field) field.classList.add('done');
        btn.classList.add('done');
        btn.textContent = '✓ 済';
        // 進捗バーも更新
        this._updateProgress();
        if (typeof showToast === 'function') showToast('コピーしました');
      } catch (e) {
        if (typeof showToast === 'function') showToast('コピー失敗: ' + e.message);
      }
    },

    _updateProgress() {
      const d = this.state.data;
      if (!d) return;
      // 1 ITEM あたり: description / value / ndg / madein / quantity (+weight +hs)
      const hasWeight = d.items.some(it => it.weightG && it.weightG > 0);
      const hasHs = d.items.some(it => it.hsCode);
      const fieldsPerItem = 5 + (hasWeight ? 1 : 0) + (hasHs ? 1 : 0);
      const totalFields = 8 + d.items.length * fieldsPerItem;
      const copiedCount = Object.keys(this.state.copiedFields).length;
      const progressPct = totalFields > 0 ? Math.round(copiedCount / totalFields * 100) : 0;
      const fill = document.querySelector('#zonos-content .zonos-progress-fill');
      if (fill) fill.style.width = progressPct + '%';
      const num = document.querySelector('#zonos-content .zonos-progress-num');
      if (num) num.textContent = copiedCount + ' / ' + totalFields + ' 完了';
    },

    async _saveDeclaration() {
      const input = document.getElementById('zonos-declaration-input');
      if (!input) return;
      const declarationId = input.value.trim();
      if (!declarationId) {
        if (typeof showToast === 'function') showToast('Declaration IDを入力してください');
        return;
      }
      if (declarationId.length < 5) {
        if (typeof showToast === 'function') showToast('Declaration IDが短すぎます (5文字以上)');
        return;
      }

      const saveBtn = document.getElementById('zonos-save-btn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
      }

      try {
        const body = {
          action: 'zonosSaveDeclaration',
          secret: API.config.secret || '',
          orderId: this.state.data.orderId,
          declarationId: declarationId,
          paidAt: new Date().toISOString()
        };
        const res = await fetch(API.config.url, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'text/plain' }
        });
        const result = await res.json();
        if (result.error) {
          if (typeof showToast === 'function') showToast('保存失敗: ' + result.error);
          return;
        }
        if (typeof showToast === 'function') showToast('保存しました' + (result.doukon ? ' (同梱' + result.rowsUpdated + '件)' : ''));
        // 注文リストを再読込
        if (typeof App !== 'undefined' && App.loadAll) {
          await App.loadAll();
        }
        // 画面を再描画
        await this.open(this.state.data.orderId);
      } catch (e) {
        if (typeof showToast === 'function') showToast('保存エラー: ' + e.message);
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      }
    },

    _openZonosApp() {
      // URLスキーム試行 → 失敗ならApp Store誘導
      const scheme = 'zonos-prepay://';
      const fallback = 'https://apps.apple.com/us/app/zonos-prepay/id6747267592';
      const start = Date.now();
      window.location = scheme;
      // 2秒以内にblurされなければApp Storeへ
      setTimeout(() => {
        if (Date.now() - start < 2200 && document.visibilityState === 'visible') {
          window.location = fallback;
        }
      }, 2000);
    }
  };

  // ============================================================
  // ユーティリティ (escapeHtml系はapp.jsに既存だが、独立して持つ)
  // ============================================================

  function escapeHtmlZ_(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttrZ_(s) {
    return escapeHtmlZ_(s);
  }
  function truncate_(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }
  function containsNonAscii_(s) {
    return /[^\x00-\x7F]/.test(String(s || ''));
  }
  function formatDt_(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const pad = n => String(n).padStart(2, '0');
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  // ============================================================
  // showScreen ヘルパー (app.js の同名関数が存在しない場合のフォールバック)
  // ============================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(id);
    if (target) target.classList.remove('hidden');
  }

  // ============================================================
  // グローバルエクスポート
  // ============================================================
  window.Zonos = {
    isZonosTargetOrder: isZonosTargetOrder,
    computeZonosDeadlineMeta: computeZonosDeadlineMeta,
    buildZonosBadge: buildZonosBadge,
    buildZonosScopeNote: buildZonosScopeNote,
    buildZonosExpireBanner: buildZonosExpireBanner,
    Screen: ZonosScreen,
    ECONOMY_POLICIES: ECONOMY_POLICIES
  };

})();
