/**
 * 発送会社最適選定ロジック
 *
 * masterData: Apps Scriptから取得したマスタデータ
 * input: { country, weightG, lengthCm, widthCm, heightCm }
 * 戻り値: { candidates: [{carrier, totalCost, ...}], context: {...} }
 */
const Calculator = {
  master: null,
  setMaster(m) { this.master = m; this._ecoEuCache = null; },

  // ★ EU対応 (2026-08, 料金ガイド2026-07-30発効):
  //   SpeedPAK Economy の発送先が DE単独 → EU27カ国 に拡大。
  //   DE以外の26カ国はマスタ「料金_Eco_EU」(master.rates.ecoEU) の国別列から料金を引く。
  EU_ECO_CODES: ['AT','BE','BG','CY','CZ','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'],

  // ★ EU関税DDP対応 (2026-10-01義務化・取引日基準):
  //   EU27宛て・150€以下はDDPラベル必須 → 日本郵便(ePacketライト)は候補から除外し、
  //   OC経由(SpeedPAK Eco/DHL/FedEx)はDDP自動適用のためEU関税+手数料(概算)をセラー負担で加算。
  //   150€超はDDU可なのでePacketは残す(閾値は概算USD換算)。
  //   金額・閾値・開始日は「アプリ設定」シートで上書き可能(キーが無ければ既定値)。
  EU_DDP_DEFAULTS: { start: '2026-10-01', tariffJPY: 567, thresholdUSD: 175 },
  _euDdpConf() {
    const c = (this.master && this.master.config) || {};
    const d = this.EU_DDP_DEFAULTS;
    const t = parseFloat(c.eu_tariff_jpy);
    const th = parseFloat(c.eu_ddp_threshold_usd);
    return {
      start: String(c.eu_ddp_start || d.start),
      tariffJPY: (isFinite(t) && t >= 0) ? Math.round(t) : d.tariffJPY,
      thresholdUSD: (isFinite(th) && th > 0) ? th : d.thresholdUSD
    };
  },
  _isEuCountry(code) { return code === 'DE' || this.EU_ECO_CODES.includes(code); },
  _todayYmd(input) {
    if (input && input.dateOverride) return String(input.dateOverride); // テスト用
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  },
  _euDdpActive(code, input) {
    return this._isEuCountry(code) && this._todayYmd(input) >= this._euDdpConf().start;
  },

  // ★EU関税コストモデル v2 (2026-10-17・S1):
  //   v1 = 1発送ごとに eu_tariff_jpy(¥567) を一律加算(現行・既定)。
  //   v2 = 暫定フラット関税 €3×申告行(≤€150のみ) + Union handling fee €2×申告行(価額問わず・11/1〜)
  //        + OC関税処理手数料2.1%(関税+手数料に掛ける)。PDDP(国別・1発送)は郵便DDP(日本郵便+Zonos)のみ。
  //   アプリ設定 eu_fee_model='v2' のときだけ v2。キー名・既定値は指示書S1の表のとおり。
  // PDDP手数料(1発送・EUR)。出典: Zonos「EU postal country readiness and declarant tracker」2026-10-16更新
  //   (Downloads/EU_PID_2EUR_PDDP_検証メモ.md ③)。gt150=null は「DAPのみ」(>€150はDDP不可)。
  //   DK: DKK10 ≒ €1.34 / SE: SEK10 ≒ €0.90 で換算。
  //   表に無いEU国(BG/HR/CZ/GR/HU/IE/LV/LT/PL/RO/SI)は郵便DDP未対応 → le150も null。
  EU_PDDP_DEFAULTS: {
    DE: { le150: 0.5, gt150: 2 },
    ES: { le150: 0.5, gt150: null },
    AT: { le150: 0.6, gt150: 5 },
    FR: { le150: 1, gt150: 1 },
    MC: { le150: 1, gt150: 1 },
    AD: { le150: 1, gt150: 1 },
    BE: { le150: 1, gt150: 5 },
    IT: { le150: 1, gt150: 15 },
    NL: { le150: 1, gt150: 5 },
    MT: { le150: 1, gt150: 10 },
    EE: { le150: 1.15, gt150: null },
    FI: { le150: 1.5, gt150: null },
    SK: { le150: 2, gt150: 10 },
    CY: { le150: 3.5, gt150: 3.5 },
    PT: { le150: 4, gt150: 15 },
    LU: { le150: 5, gt150: null },
    DK: { le150: 1.34, gt150: 1.34 }, // DKK 10
    SE: { le150: 0.90, gt150: 0.90 }, // SEK 10
    BG: { le150: null, gt150: null }, HR: { le150: null, gt150: null }, CZ: { le150: null, gt150: null },
    GR: { le150: null, gt150: null }, HU: { le150: null, gt150: null }, IE: { le150: null, gt150: null },
    LV: { le150: null, gt150: null }, LT: { le150: null, gt150: null }, PL: { le150: null, gt150: null },
    RO: { le150: null, gt150: null }, SI: { le150: null, gt150: null }
  },
  // 日本郵便+Zonos で関税元払いできるEU宛先(Zonos API走査で可の12か国。ADはAPI走査で不可のため含めない)
  JP_ZONOS_EU: ['FR','IT','ES','NL','DK','SE','FI','EE','LU','MT','SK','MC'],

  // ★段階C Zonos EU (2026-10-22・ZONOS_EU_PLAN_v1 §0/§2):
  //   日本郵便(ePacketライト)+Zonos で EU 宛てを DDP 発送する対象国(11か国)。
  //   ※GAS側 apps_script_v3.17.0 の ZONOS_EU_COUNTRIES と同じ値に保つこと(変更時は両方を同時に直す)。
  //   MC は本番マスタで epacketZone=null のため除外 / AD・仏海外県は未検証のため除外 / DE は Zonos 不可。
  ZONOS_EU_COUNTRIES: ['FR','IT','ES','NL','DK','SE','FI','EE','LU','MT','SK'],
  // Zonos 実測モデル(2026-10-27 Zonos サポート回答 + landedCost 実測で更新)。
  //   GAS は EU のとき endUse: NOT_FOR_RESALE で見積る → 商品合計 ≤ €150(eu_duty_threshold_eur) なら
  //   duty = €3(eu_duty_eur) × 申告行数 ("Europe Reformed Duty 3 EUR")。価格不明(0)も ≤€150 とみなす(保守側)。
  //   商品合計 > €150 は従来式 duty = Σ品目 clamp(dutyRate×CIF_item, dutyMinEUR, dutyMaxEUR)
  //   (IOSS 対象は ≤€150 のみなので実際はほぼ使われない)。
  //   €2(eu_handling_eur) × 申告行数 を eu_handling_start(既定 2026-11-01) 以降に加算(全 B2C・価額問わず)。
  //   ※€2 は 10/27 時点の Zonos 見積には出ない(arrivalDate 11/5 でも出ない)が EU が課すため、コスト比較は保守的に含める。
  //     Zonos 見積に載ったら実額と照合すること。
  //   PDDP = EU_PDDP_DEFAULTS[cc].le150 / remittance = remittanceJPY(固定円・実測 266)
  //   disbursement = disbursementRate×(duty + €2分 + PDDP)
  //   ※€2 を disbursement の基数に入れるかは不明(実測は duty+PDDP の 10%)。保守側で入れている。
  ZONOS_EU_MODEL: { dutyRate: 0.045, dutyMinEUR: 0.30, dutyMaxEUR: 0.80, remittanceJPY: 266, disbursementRate: 0.10 },
  // アプリ設定 zonos_eu_enabled(1/true で有効)。既定は無効=挙動不変
  _zonosEuEnabled() {
    const c = (this.master && this.master.config) || {};
    const v = c.zonos_eu_enabled;
    if (v === true || v === 1) return true;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '1' || s === 'true';
  },
  // ★v3.10.3: Zonos 対象の Economy 系発送ポリシー(完全一致リスト)。
  //   ※zonos.js の ECONOMY_POLICIES・GAS zonos_integration.gs の ECONOMY_POLICIES と同じ値に保つこと(変更時は3か所同時に直す)。
  ZONOS_ECONOMY_POLICIES: [
    'ePacketライト',
    'Economy International Shipping',
    'Economy Shipping from outside US',
    'SpeedPAK Economy',
    'eBay SpeedPAK Economy',
    'SpeedPAK Eco'
  ],
  // ★v3.10.3: Economy 系ポリシーか(GAS zonosIsEconomyPolicy_ / zonos.js isEconomyPolicy_ と同じロジック)。
  //   完全一致 → 部分一致(小文字で economy を含み expedited を含まない / epacket を含む)。空は false
  _isEconomyPolicy(policy) {
    if (!policy) return false;
    if (this.ZONOS_ECONOMY_POLICIES.indexOf(policy) !== -1) return true;
    const p = String(policy).toLowerCase();
    if (p.indexOf('economy') !== -1 && p.indexOf('expedited') === -1) return true;
    if (p.indexOf('epacket') !== -1) return true;
    return false;
  },
  // Zonos EU 対象か = フラグ ∧ 対象11か国 ∧ (注文の IOSS 参照あり、または手動入力で 0 < 価格 ≤ eu_ddp_threshold_usd)
  //   input.ioss = 注文行の IOSS 列 / input.manual = 注文に紐付かない手動入力(app.js が付与)
  //   ★v3.10.3: 注文に紐付く計算(manual が偽)は input.shippingPolicy が Economy 系でなければ対象外。手動入力はポリシー不問
  _isZonosEuEligible(input, country) {
    if (!this._zonosEuEnabled()) return false;
    const code = (country && typeof country === 'object') ? country.code : String(country || (input && input.country) || '');
    if (this.ZONOS_EU_COUNTRIES.indexOf(code) === -1) return false;
    if (!(input && input.manual) && !this._isEconomyPolicy(input ? input.shippingPolicy : '')) return false;
    if (input && String(input.ioss == null ? '' : input.ioss).trim() !== '') return true;
    const p = input ? input.itemPriceUSD : 0;
    return !!(input && input.manual && p > 0 && p <= this._euDdpConf().thresholdUSD);
  },
  // Zonos EU のセラー負担額(円)と内訳。freightJPY = ePacket運賃(CIF の運賃按分に使う)
  _zonosEuTariff(code, input, freightJPY) {
    const M = this.ZONOS_EU_MODEL;
    const conf = this._euFeeConf();
    const eurJpy = conf.eurJpy;
    const usdJpy = conf.usdJpy;
    // 品目: input.items に priceUSD があればそれを使い、無ければ 申告行数 n で価格を均等割り
    let prices = null;
    if (Array.isArray(input.items) && input.items.length > 0 && input.items.every(it => it && isFinite(parseFloat(it.priceUSD)))) {
      prices = input.items.map(it => Math.max(0, parseFloat(it.priceUSD)));
    } else {
      const n = this._declLines(input);
      const total = input.itemPriceUSD > 0 ? input.itemPriceUSD : 0;
      prices = [];
      for (let i = 0; i < n; i++) prices.push(total / n);
    }
    const sumPrice = prices.reduce((a, b) => a + b, 0);
    const lines = prices.length;
    const freightEUR = (freightJPY > 0 ? freightJPY : 0) / eurJpy;
    const priceEUR = sumPrice * usdJpy / eurJpy;          // 商品合計(運賃を含まない)
    const le150 = priceEUR <= conf.thresholdEUR;
    let dutyEUR = 0;
    if (le150) {
      dutyEUR = conf.dutyEUR * lines;                     // €3 × 申告行数 (NOT_FOR_RESALE・≤€150)
    } else {
      prices.forEach(pUSD => {
        const share = sumPrice > 0 ? pUSD / sumPrice : 1 / prices.length; // 運賃按分(価格比・価格不明は均等)
        const cifEUR = pUSD * usdJpy / eurJpy + freightEUR * share;
        dutyEUR += Math.min(M.dutyMaxEUR, Math.max(M.dutyMinEUR, M.dutyRate * cifEUR));
      });
    }
    dutyEUR = Math.round(dutyEUR * 10000) / 10000;
    // €2 × 申告行数 (eu_handling_start 以降・価額問わず)。Zonos 見積に載ったら実額と照合
    const handlingEUR = (this._todayYmd(input) >= conf.handlingStart) ? conf.handlingEUR * lines : 0;
    const p = conf.pddpTable[code] || null;
    // FI は表上 le150=1.5 だが指示書§2-3 により 0(Zonos 実測で PDDP が出ない)
    const pddpUse = (code === 'FI') ? 0 : ((p && p.le150) ? p.le150 : 0);
    const dutyJPY = Math.round(dutyEUR * eurJpy);
    const handlingJPY = Math.round(handlingEUR * eurJpy);
    const pddpJPY = Math.round(pddpUse * eurJpy);
    const remittanceJPY = M.remittanceJPY;
    // €2 分も基数に含める(保守側・Zonos の扱いは未確認)
    const disbursementJPY = Math.round(M.disbursementRate * (dutyJPY + handlingJPY + pddpJPY));
    const tariffJPY = dutyJPY + handlingJPY + pddpJPY + remittanceJPY + disbursementJPY;
    const note = 'Zonos DDP: 関税€' + (Math.round(dutyEUR * 100) / 100) + '(¥' + dutyJPY + ')'
      + (handlingEUR > 0 ? ' + EU手数料€' + (Math.round(handlingEUR * 100) / 100) + '(¥' + handlingJPY + ')' : '')
      + ' + PDDP€' + pddpUse + '(¥' + pddpJPY + ')'
      + ' + 送金手数料¥' + remittanceJPY
      + ' + 立替手数料' + Math.round(M.disbursementRate * 100) + '%(¥' + disbursementJPY + ')'
      + ' = ¥' + tariffJPY + ' (セラー負担・概算)';
    return {
      tariffJPY,
      note,
      breakdown: { model: 'zonos', lines, dutyEUR, handlingEUR, pddpEUR: pddpUse, dutyJPY, handlingJPY, pddpJPY,
        remittanceJPY, disbursementJPY, eurJpy, eurApprox: conf.eurApprox }
    };
  },

  _cfgStr(key, dflt) {
    const c = (this.master && this.master.config) || {};
    const v = c[key];
    return (v == null || v === '') ? dflt : String(v).trim();
  },
  _euFeeConf() {
    const r = this._rate();
    const e = this._cfgNum('eur_jpy', NaN);
    const eurApprox = !(isFinite(e) && e > 0);
    let table = this.EU_PDDP_DEFAULTS;
    const c = (this.master && this.master.config) || {};
    if (c.eu_pddp_table) {
      try {
        const t = (typeof c.eu_pddp_table === 'string') ? JSON.parse(c.eu_pddp_table) : c.eu_pddp_table;
        if (t && typeof t === 'object') table = Object.assign({}, this.EU_PDDP_DEFAULTS, t); // 国単位で上書き
      } catch (_) { /* JSON不正は既定表 */ }
    }
    return {
      model: this._cfgStr('eu_fee_model', 'v1'),
      dutyEUR: this._cfgNum('eu_duty_eur', 3),
      handlingEUR: this._cfgNum('eu_handling_eur', 2),
      handlingStart: this._cfgYmd('eu_handling_start', '2026-11-01'),
      thresholdEUR: this._cfgNum('eu_duty_threshold_eur', 150),
      ocFeePct: this._cfgNum('eu_oc_fee_pct', 2.1),
      eurJpy: eurApprox ? r * 1.17 : e,
      eurApprox,
      usdJpy: r,
      pddpTable: table
    };
  },
  // 申告行数: input.declLines > input.items.length(異なるSKU数) > 1
  _declLines(input) {
    const n = parseInt(input && input.declLines, 10);
    if (n > 0) return n;
    if (input && Array.isArray(input.items) && input.items.length > 0) return input.items.length;
    return 1;
  },
  // v2の構成要素(EUR)。pddp は郵便DDPのときだけ呼び出し側で加算する
  _euV2Parts(code, input) {
    const conf = this._euFeeConf();
    const lines = this._declLines(input);
    const priceEUR = (input && input.itemPriceUSD > 0) ? input.itemPriceUSD * conf.usdJpy / conf.eurJpy : 0;
    const le = priceEUR <= conf.thresholdEUR; // 価格不明(0)は≤€150とみなす(v1のePacket除外と同じ保守側)
    const dutyEUR = le ? conf.dutyEUR * lines : 0; // >€150 の実関税は v2 では 0(DDU想定・要判断)
    const handlingEUR = (this._todayYmd(input) >= conf.handlingStart) ? conf.handlingEUR * lines : 0;
    const p = conf.pddpTable[code] || null;
    const pddpRaw = p ? (priceEUR <= 150 ? p.le150 : p.gt150) : null;
    return { conf, lines, priceEUR, dutyEUR, handlingEUR, pddpRaw, pddpEUR: pddpRaw || 0 };
  },
  // OC系(Eco/DHL/FedEx)のEU関税セラー負担。v1=一律¥567 / v2=€3×n+€2×n+OC手数料
  _euOcTariff(code, input) {
    const conf = this._euFeeConf();
    if (conf.model !== 'v2') {
      const t = this._euDdpConf().tariffJPY;
      return { tariffJPY: t, reason: null, breakdown: { model: 'v1', tariffJPY: t } };
    }
    const v = this._euV2Parts(code, input);
    const ocFeeEUR = (v.dutyEUR + v.handlingEUR) * conf.ocFeePct / 100;
    const tariffJPY = Math.round((v.dutyEUR + v.handlingEUR + ocFeeEUR) * conf.eurJpy);
    const parts = [];
    if (v.dutyEUR > 0) parts.push('EU関税€' + conf.dutyEUR + '×' + v.lines);
    if (v.handlingEUR > 0) parts.push('手数料€' + conf.handlingEUR + '×' + v.lines);
    return {
      tariffJPY,
      reason: parts.length ? parts.join(' + ') + ' (セラー負担)' : null,
      breakdown: { lines: v.lines, dutyEUR: v.dutyEUR, handlingEUR: v.handlingEUR, pddpEUR: 0,
        ocFeeEUR: Math.round(ocFeeEUR * 10000) / 10000, eurJpy: conf.eurJpy, model: 'v2' }
    };
  },

  // ★試算専用(候補一覧には出さない): 日本郵便(ePacketライト運賃)+Zonos でEU宛てDDPした場合のセラー負担額。
  //   ※段階C(2026-10-22)以降、候補一覧の Zonos EU は _zonosEuTariff(Zonos 実測モデル)を使う。
  //     本関数は tests/eu_cost_sim.js の比較試算用に残置(v2 €3/€2 前提の旧試算)。
  //   運賃 = ePacket料金表 / Zonos手数料 = zonos_fee_jpy(既定760) / + €3×n(≤€150) + €2×n(11/1〜) + PDDP(国別)。
  //   country は国コード文字列または国オブジェクト。ePacket料金が引けない(地帯未設定・サイズ超過)ときは null。
  //   JP_ZONOS_EU 以外の国も試算値は返すが available:false・ddpNote に「対象外」を付ける(比較用)。
  estimateJpZonosEU(input, country) {
    if (!this.master) throw new Error('Master data not loaded');
    const code = (country && typeof country === 'object') ? country.code : String(country || input.country || '');
    const available = this.JP_ZONOS_EU.indexOf(code) !== -1;
    const ctry = (country && typeof country === 'object') ? country : (this.master.countries || []).find(c => c.code === code);
    if (!ctry || !ctry.epacketZone) return null;
    const dims = [input.lengthCm, input.widthCm, input.heightCm].sort((a, b) => b - a);
    if (input.weightG > 2000 || dims[0] > 60 || dims[0] + dims[1] + dims[2] > 90) return null;
    const w100 = Math.ceil(input.weightG / 100) * 100;
    const row = (this.master.rates.epacket || []).find(r => r[0] === w100);
    const freightJPY = row ? row[ctry.epacketZone] : null;
    if (!freightJPY) return null;

    const v = this._euV2Parts(code, input);
    const zonosFeeJPY = this._cfgNum('zonos_fee_jpy', 760);
    const euJPY = Math.round((v.dutyEUR + v.handlingEUR + v.pddpEUR) * v.conf.eurJpy);
    const notes = [];
    if (!available) notes.push('日本郵便+Zonosの対象外(参考試算)');
    if (v.pddpRaw == null) {
      notes.push(v.priceEUR > 150
        ? '>€150 は郵便DDP不可(DAPのみ)・PDDP手数料は0として試算'
        : 'PDDP手数料が未登録の国・0として試算');
    }
    return {
      carrier: '日本郵便+Zonos(試算)',
      country: code,
      available,
      ddpNote: notes.length ? notes.join(' / ') : null,
      freightJPY,
      zonosFeeJPY,
      euJPY,
      totalCost: freightJPY + zonosFeeJPY + euJPY,
      euBreakdown: { lines: v.lines, dutyEUR: v.dutyEUR, handlingEUR: v.handlingEUR, pddpEUR: v.pddpEUR,
        ocFeeEUR: 0, eurJpy: v.conf.eurJpy, model: 'v2' }
    };
  },

  // 為替レート（USD→JPY）。マスタ「アプリ設定」シートの usd_jpy_rate を優先し、
  // 未設定・旧マスタの場合は 150 にフォールバック(後方互換)
  exchangeRate: 150,
  _rate() {
    const c = this.master && this.master.config;
    const r = c ? parseFloat(c.usd_jpy_rate) : NaN;
    return (isFinite(r) && r > 0) ? r : this.exchangeRate;
  },

  // ★v3.6.1 アプリ設定(master.config)の数値/日付キー。未設定・旧マスタは既定値
  _cfgNum(key, dflt) {
    const c = (this.master && this.master.config) || {};
    const v = parseFloat(c[key]);
    return isFinite(v) ? v : dflt;
  },
  _cfgYmd(key, dflt) {
    const c = (this.master && this.master.config) || {};
    const v = c[key];
    if (!v) return dflt;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
    const d = new Date(v); // Sheetsの日付セルはDate/ISO文字列で届く
    if (!isNaN(d.getTime())) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return dflt;
  },
  // ★v3.6.1 燃料サーチャージ(週次キャッシュ・master.fuel)。旧マスタ(未同梱)は null=加算しない
  _fuelConf(carrier) {
    const f = this.master && this.master.fuel && this.master.fuel[carrier];
    if (!f) return null;
    const eff = parseFloat(f.eff);
    if (!isFinite(eff) || eff <= 0 || eff >= 90) return null;
    return { eff, stale: !!f.stale };
  },
  _fuelReason(conf) {
    return '燃料割増金 ' + conf.eff.toFixed(2) + '%' + (conf.stale ? '(⚠旧率・更新待ち)' : '');
  },
  // ★v3.6.1 FedEx混雑時割増金の国別単価(円/kg)。2026-09-21改定を日付で切替。旧マスタは null
  _fedexDemandPerKg(code, input) {
    const d = this.master && this.master.fedexDemand;
    if (!d || !d.after) return null;
    const useAfter = this._todayYmd(input) >= (d.changeDate || '2026-09-21');
    let v = useAfter ? d.after[code] : (d.before || {})[code];
    if (!useAfter && (v == null || v === '')) v = d.after[code]; // 改定前単価が未実測の国はフォールバック
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  },

  calculate(input) {
    if (!this.master) throw new Error('Master data not loaded');
    const country = this.master.countries.find(c => c.code === input.country);
    if (!country) return { candidates: [], context: { error: 'Unknown country' } };

    const dims = [input.lengthCm, input.widthCm, input.heightCm].sort((a, b) => b - a);
    const vol8000 = (input.lengthCm * input.widthCm * input.heightCm) / 8000;
    const vol5000 = (input.lengthCm * input.widthCm * input.heightCm) / 5000;

    // 米国向けの関税概算（円）
    const tariffJPY = (country.code === 'US' && input.itemPriceUSD && input.tariffRate)
      ? Math.round(input.itemPriceUSD * input.tariffRate / 100 * this._rate())
      : 0;

    const candidates = [];
    const excluded = []; // v3.11: 除外された配送会社と理由を画面表示用に集める

    const ep = this._epacket(input, country, dims, tariffJPY);
    if (ep && ep._excluded) excluded.push(ep);
    else if (ep) candidates.push(ep);

    if (country.ecoSupported) {
      const eco = this._eco(input, country, dims, vol8000, tariffJPY);
      if (eco) candidates.push(eco);
    } else {
      excluded.push({ _excluded: true, name: 'SpeedPAK Economy', reason: '国マスタでSpeedPAK Eco未対応' });
    }

    const dhl = this._dhl(input, country, dims, vol5000, tariffJPY);
    if (dhl) candidates.push(dhl);

    const fedex = this._fedex(input, country, dims, vol5000, tariffJPY);
    if (fedex) candidates.push(fedex);

    candidates.sort((a, b) => a.totalCost - b.totalCost);
    // ★EU v2: EUR→JPY を USDレート×1.17 で近似したときは注記を残す
    let euRateNote = null;
    if (this._euDdpActive(country.code, input)) {
      const ec = this._euFeeConf();
      if (ec.model === 'v2' && ec.eurApprox) euRateNote = '近似: eur_jpy未設定のため usd_jpy_rate×1.17 (=' + ec.eurJpy.toFixed(2) + ')';
    }
    const context = {
      actualG: input.weightG,
      vol8000G: Math.ceil(vol8000 * 1000),
      vol5000G: Math.ceil(vol5000 * 1000),
      country: country.name,
      tariffJPY: tariffJPY,
      tariffRate: input.tariffRate || 0,
      euDdp: this._euDdpActive(country.code, input), // ★EU関税DDP適用中か(UI推奨表示用)
      euRateNote: euRateNote
    };
    // ★段階C Zonos EU: 日本郵便+Zonos DDP が候補に戻ったときだけキーを足す(フラグ無効時の出力は現行と同一)
    if (ep && ep.zonosEu) context.zonosEu = true;
    return {
      candidates,
      excluded, // v3.11
      context
    };
  },

  _epacket(input, country, dims, tariffJPY) {
    // v3.11: 除外時に理由を画面表示できるよう { _excluded:true, name, reason } を返す
    const NAME = 'ePacketライト';
    const ex = (reason) => ({ _excluded: true, name: NAME, reason });

    // ★段階C Zonos EU: フラグ∧対象国∧IOSS(または手動入力の価格≤閾値)なら日本郵便+Zonos DDP で候補に戻す
    const zonosEu = this._euDdpActive(country.code, input) && this._isZonosEuEligible(input, country.code);

    // ★EU関税DDP(10/1〜): 150€以下(価格不明含む)はDDPラベル必須のため日本郵便は使えない
    if (!zonosEu && this._euDdpActive(country.code, input)) {
      const conf = this._euDdpConf();
      const p = input.itemPriceUSD;
      if (!(p > conf.thresholdUSD)) {
        return ex(p > 0
          ? `EU関税DDP義務化(10/1〜): 150€(≈$${conf.thresholdUSD})以下はDDPラベル必須 → CPaSSでSpeedPAKを使う`
          : `EU関税DDP義務化(10/1〜): 商品価格が未取得のため150€以下とみなし除外(150€超はDDU可・手動入力なら価格確認)`);
      }
    }

    if (!country.epacketZone) return ex(`国マスタに ePacket 地帯が未設定（${country.code}）`);
    if (input.weightG > 2000) return ex(`重量 ${input.weightG}g が 2000g 超`);
    if (dims[0] > 60) return ex(`最大辺 ${dims[0]}cm が 60cm 超`);
    if (dims[0] + dims[1] + dims[2] > 90) return ex(`三辺合計 ${(dims[0]+dims[1]+dims[2]).toFixed(1)}cm が 90cm 超`);
    if (dims[0] < 14.8 || dims[1] < 10.5) return ex(`最小サイズ未満（最大辺=${dims[0]}cm, 2番目=${dims[1]}cm。基準: 14.8×10.5）`);

    const w100 = Math.ceil(input.weightG / 100) * 100;
    const row = this.master.rates.epacket.find(r => r[0] === w100);
    if (!row) return ex(`料金表に ${w100}g 行が見つからない`);
    const cost = row[country.epacketZone];
    if (cost == null || cost === '' || cost === 0) return ex(`料金表 ${w100}g × 第${country.epacketZone}地帯 の値が空（row=${JSON.stringify(row)}）`);

    if (zonosEu) {
      // ★段階C Zonos EU: 関税・PDDP・Zonos手数料をセラー負担で加算(Zonos 実測モデル)
      const z = this._zonosEuTariff(country.code, input, cost);
      return {
        carrier: 'ePacketライト（Zonos DDP）',
        sheetCarrier: NAME,        // シートM列へは従来どおり 'ePacketライト' を書く(差出票・発送待ちフィルタが完全一致で判定するため)
        detail: '第' + country.epacketZone + '地帯',
        basicCost: cost,
        surcharge: 0,
        tariffSeller: z.tariffJPY,
        tariffBuyer: 0,
        totalCost: cost + z.tariffJPY,
        zonosEu: true,
        zonosBreakdown: z.breakdown,
        billableG: input.weightG,
        estimatedDays: '5〜21日',
        tracking: true,
        insurance: false,
        tariffNote: z.note
      };
    }

    return {
      carrier: NAME,
      detail: '第' + country.epacketZone + '地帯',
      basicCost: cost,
      surcharge: 0,
      tariffSeller: 0,           // セラー負担なし
      tariffBuyer: tariffJPY,    // 買い手負担として表示
      totalCost: cost,           // セラーが支払う総額（関税抜き）
      billableG: input.weightG,
      estimatedDays: '5〜21日',
      tracking: true,
      insurance: false,
      tariffNote: tariffJPY > 0 ? '関税は買い手が現地で負担' : null
    };
  },

  _eco(input, country, dims, vol8000, tariffJPY) {
    if (!this._ecoSizeOk(input, country, dims)) return null;
    const billableKg = Math.max(input.weightG / 1000, vol8000);
    const actualKg = input.weightG / 1000;
    // 実重量の上限 (2026-07-30改定: UK≤15 / AU≤22)
    if (country.code === 'GB' && actualKg > 15) return null;
    if (country.code === 'AU' && actualKg > 22) return null;
    // 請求重量の上限 (US/UK/DE=25, AU=22.5, EU=30, SE=20)
    if (billableKg > this._ecoBillableCap(country.code)) return null;

    const table = this._ecoTable(country.code);
    if (!table) return null;
    const row = table.find(r => r[0] >= billableKg);
    if (!row) return null;

    let surcharge = 0;
    const surchargeReasons = [];
    if (dims[0] > 55.88 || (input.lengthCm * input.widthCm * input.heightCm) > 55000) {
      surcharge += this.master.surcharges.eco.oversizeFlat;
      surchargeReasons.push('規定外寸法');
    }

    // ★v3.6.1: Eco混雑時割増金(EU27・ピークシーズン11/1〜12/31・アプリ設定 eco_demand_jpy。
    //   ガイド2026-09版&マスタ「サーチャージ_Eco」準拠。燃料はEcoの料金表に込みのため加算しない)
    const ecoDemandJPY = this._cfgNum('eco_demand_jpy', 0);
    if (ecoDemandJPY > 0 && this._isEuCountry(country.code)) {
      const md = this._todayYmd(input).slice(5); // 'MM-DD'
      if (md >= '11-01' && md <= '12-31') {
        surcharge += ecoDemandJPY;
        surchargeReasons.push('混雑時割増金(ピークシーズン)');
      }
    }

    // 米国向け関税＋通関手数料（Orange Connex経由はセラー負担）
    let usFees = 0;
    let tariffSeller = 0;
    let euBreakdown;
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      usFees = 245 + Math.round(tariffJPY * 0.021); // 米国輸入通関手数料 + 関税処理手数料2.1%
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
      if (usFees > 0) surchargeReasons.push('米国通関手数料');
    } else if (this._euDdpActive(country.code, input)) {
      // ★EU関税DDP(10/1〜): SpeedPAKはDDP自動適用 → v1=3€+手数料2.1%の概算 / v2=€3×n+€2×n+2.1% をセラー負担で加算
      const eu = this._euOcTariff(country.code, input);
      tariffSeller = eu.tariffJPY;
      euBreakdown = eu.breakdown;
      if (tariffSeller > 0) surchargeReasons.push(eu.reason || 'EU関税DDP(セラー負担・概算)');
    }

    const totalCost = row[1] + surcharge + tariffSeller + usFees;

    return {
      carrier: 'eBay SpeedPAK Economy',
      detail: country.name,
      basicCost: row[1],
      surcharge,
      surchargeReasons,
      euBreakdown,
      tariffSeller,
      usFees,
      totalCost,
      billableG: Math.ceil(billableKg * 1000),
      estimatedDays: this._ecoDays(country.code),
      tracking: true,
      insurance: true
    };
  },

  // 国別の請求重量上限 (2026-07-30改定)
  _ecoBillableCap(code) {
    if (code === 'AU') return 22.5;
    if (code === 'SE') return 20;
    if (this.EU_ECO_CODES.includes(code)) return 30; // DE以外のEU(DEは25)
    return 25; // US / GB / DE
  },

  // 国別の推定配送日数 (2026-07-30版ガイド)
  _ecoDays(code) {
    if (code === 'US') return '8〜12営業日';
    if (code === 'GB') return '7〜10営業日';
    if (code === 'AU') return '6〜12営業日';
    if (code === 'DE' || this.EU_ECO_CODES.includes(code)) return '6〜16営業日';
    return '6〜16営業日';
  },

  _ecoTable(code) {
    if (code === 'US') return this.master.rates.ecoUSA48;
    if (code === 'GB') return this.master.rates.ecoUK;
    if (code === 'DE') return this._ecoEuTable('DE') || this.master.rates.ecoDE; // DE二重管理解消: EU表に一本化(旧マスタはDE表へフォールバック)
    if (code === 'AU') return this.master.rates.ecoAU;
    if (this.EU_ECO_CODES.includes(code)) return this._ecoEuTable(code);
    return null;
  },

  // 料金_Eco_EU (master.rates.ecoEU = {header:[国コード27], rows:[[kg, ...27値]]}) から
  // 国別の [ [kg, JPY], ... ] を組み立てる。空欄(DE>25kg/SE>20kg)は行ごと除外。
  _ecoEuTable(code) {
    const eu = this.master.rates.ecoEU;
    if (!eu || !eu.header || !eu.rows) return null; // マスタ未対応(旧GAS)なら候補に出さない
    if (!this._ecoEuCache) this._ecoEuCache = {};
    if (this._ecoEuCache[code]) return this._ecoEuCache[code];
    const ci = eu.header.indexOf(code);
    if (ci < 0) return null;
    const table = [];
    for (let i = 0; i < eu.rows.length; i++) {
      const r = eu.rows[i];
      const v = r[ci + 1]; // r[0]=重量, r[1]〜=header順の料金
      if (v != null && v !== '' && v > 0) table.push([r[0], v]);
    }
    if (table.length === 0) return null;
    this._ecoEuCache[code] = table;
    return table;
  },

  _ecoSizeOk(input, country, dims) {
    const c = country.code;
    if (c === 'US') return dims[0] <= 66 && (dims[0] + 2 * (dims[1] + dims[2])) <= 274;
    if (c === 'GB') return dims[0] <= 120 && (dims[0] + 2 * (dims[1] + dims[2])) <= 225;
    // 2026-07-30改定: DE=120/60/60、AU体積250,000→180,000、EU(DE以外)=120/40/40。EU/AUは総容積≤180,000cm³
    const volume = input.lengthCm * input.widthCm * input.heightCm;
    if (c === 'DE') return dims[0] <= 120 && dims[1] <= 60 && dims[2] <= 60 && volume <= 180000;
    if (c === 'AU') return dims[0] <= 105 && volume <= 180000;
    if (this.EU_ECO_CODES.includes(c)) return dims[0] <= 120 && dims[1] <= 40 && dims[2] <= 40 && volume <= 180000;
    return false;
  },

  _dhl(input, country, dims, vol5000, tariffJPY) {
    if (!country.dhlZone) return null;
    if (dims[0] > 120 || dims[1] > 80 || dims[2] > 80) return null;
    const billableKg = Math.max(input.weightG / 1000, vol5000);
    if (billableKg > 70) return null;

    const tier = this.master.rates.dhl.find(r => r.weight >= billableKg);
    if (!tier) return null;
    const cost = tier.zones[country.dhlZone];
    if (!cost) return null;

    let surcharge = 0;
    const surchargeReasons = [];
    if (dims[0] > 100) {
      surcharge += this.master.surcharges.dhl.oversizeDimFlat;
      surchargeReasons.push('規定外寸法');
    }
    if (input.weightG / 1000 > 25) {
      surcharge += this.master.surcharges.dhl.specialHandlingFlat;
      surchargeReasons.push('特別貨物取扱料');
    }

    // 米国向け関税（Orange Connex経由はセラー負担、関税処理手数料2.1%含む）
    let tariffSeller = 0;
    let usFees = 0;
    let euBreakdown;
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      usFees = Math.round(tariffJPY * 0.021); // 関税処理手数料2.1%（DHLは通関手数料は別途）
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
    } else if (this._euDdpActive(country.code, input)) {
      // ★EU関税DDP(10/1〜): OC経由はDDP自動適用 → v1概算 / v2分解 をセラー負担で加算
      const eu = this._euOcTariff(country.code, input);
      tariffSeller = eu.tariffJPY;
      euBreakdown = eu.breakdown;
      if (tariffSeller > 0) surchargeReasons.push(eu.reason || 'EU関税DDP(セラー負担・概算)');
    }

    // ★v3.6.1: 燃料割増金 = 実効率(公表×0.75=SpeedPAK 25%OFF) × (運賃+対象サーチャージ)。
    //   OC実請求の逆算で検証済み(IE: 2265×0.75×42.50%=722円一致)。旧マスタは加算なし
    let fuelJPY = 0;
    const dhlFuel = this._fuelConf('dhl');
    if (dhlFuel) {
      fuelJPY = Math.round((cost + surcharge) * dhlFuel.eff / 100);
      surcharge += fuelJPY;
      surchargeReasons.push(this._fuelReason(dhlFuel));
    }

    const totalCost = cost + surcharge + tariffSeller + usFees;

    return {
      carrier: 'eBay SpeedPAK Ship via DHL',
      fuelJPY,
      detail: 'Zone ' + country.dhlZone,
      basicCost: cost,
      surcharge,
      surchargeReasons,
      euBreakdown,
      tariffSeller,
      usFees,
      totalCost,
      billableG: Math.ceil(billableKg * 1000),
      estimatedDays: '1〜5営業日',
      tracking: true,
      insurance: true
    };
  },

  _fedex(input, country, dims, vol5000, tariffJPY) {
    // FedEx FICP用ゾーン取得（fedexZonesマップから）
    const fedexZone = (this.master.fedexZones || {})[country.code];
    if (!fedexZone) return null;
    // 寸法制限：長さ≤274cm、長さ+周囲≤330cm（周囲=2*(幅+高さ)）
    if (dims[0] > 274) return null;
    const girth = 2 * (dims[1] + dims[2]);
    if (dims[0] + girth > 330) return null;
    // 重量制限：68kg
    let billableKg = Math.max(input.weightG / 1000, vol5000);
    if (billableKg > 68) return null;

    // ★v3.6.1: 非標準判定を運賃検索より先に行う(特別取扱-寸法は最低請求重量18kgが運賃ティアに波及)
    const isOversize = dims[0] > 243; // (長さ+胴回り>330は上でnull済み)
    const isAhsDim = !isOversize && (dims[0] > 121 || dims[1] > 76 || (dims[0] + girth) > 266);
    const isAhsWeight = input.weightG / 1000 > 25;
    if (isAhsDim && billableKg < 18) billableKg = 18; // ガイド2026-09: 特別取扱(寸法)は最低請求重量18kg

    // 料金検索：重量を切り上げて該当行を取得
    const fedexRates = this.master.rates.fedex || [];
    const tier = fedexRates.find(r => r.weight >= billableKg);
    if (!tier) return null;
    const cost = tier.zones[fedexZone];
    if (!cost) return null;

    const surchargeReasons = [];
    const sc = this.master.surcharges.fedex || {};

    // 非標準手数料 ★v3.6.1: 複数該当時は最高額1つのみ(ガイド2026-09。旧版は寸法+重量を重複加算していた)
    let nonStdJPY = 0;
    if (isOversize) {
      nonStdJPY = sc.oversizeFlat || 8800;
      surchargeReasons.push('オーバーサイズ');
    } else if (isAhsDim || isAhsWeight) {
      nonStdJPY = Math.max(sc.specialHandlingDimFlat || 3390, sc.specialHandlingWeightFlat || 3390);
      surchargeReasons.push(isAhsDim ? '特別取扱料金(寸法)' : '特別取扱料金(重量)');
      if (isAhsDim && isAhsWeight) surchargeReasons.push('※寸法+重量該当も課金は高い方1つ');
    }

    // ★v3.6.1: 混雑時割増金(国別円/kg×請求重量・最低37円/件。2026-09-21改定を日付切替。旧マスタは非加算)
    let demandJPY = 0;
    const demandPerKg = this._fedexDemandPerKg(country.code, input);
    if (demandPerKg != null && demandPerKg > 0) {
      demandJPY = Math.max(this._cfgNum('fedex_demand_min_jpy', 37), Math.round(demandPerKg * billableKg));
      surchargeReasons.push('混雑時割増金(' + demandPerKg + '円/kg)');
    }

    // ★v3.6.1: 非標準貨物混雑時割増金 NSSDS(2026-09-21新設・非標準該当時+770円・燃料対象)
    let nssdsJPY = 0;
    if (this.master.fedexDemand && (isOversize || isAhsDim || isAhsWeight)
        && this._todayYmd(input) >= this._cfgYmd('nssds_start', '2026-09-21')) {
      nssdsJPY = this._cfgNum('nssds_jpy', 770);
      surchargeReasons.push('非標準貨物混雑時割増金');
    }

    // ★v3.6.1: 燃料割増金 = 公表週率(割引なし) × (運賃+非標準+混雑時+NSSDS)。
    //   OC実請求の逆算で検証済み(基礎に混雑時割増金を含む)。旧マスタは非加算
    let fuelJPY = 0;
    const fedexFuel = this._fuelConf('fedex');
    if (fedexFuel) {
      fuelJPY = Math.round((cost + nonStdJPY + demandJPY + nssdsJPY) * fedexFuel.eff / 100);
      surchargeReasons.push(this._fuelReason(fedexFuel));
    }

    const surcharge = nonStdJPY + demandJPY + nssdsJPY + fuelJPY;

    // 米国向け関税：FICPは米国輸入手続き手数料が無料、関税転送も無料
    let tariffSeller = 0;
    let usFees = 0;
    let euBreakdown;
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      // 関税処理手数料 2.1% のみ加算（FICPは他の通関手数料が無料）
      usFees = Math.round(tariffJPY * (sc.usDutyProcessRate || 0.021));
      // ★v3.6.1: MPF簡易通関(2.69USD/件・アプリ設定 fedex_mpf_usd。旧マスタはキー無し=0)
      const mpfUSD = this._cfgNum('fedex_mpf_usd', 0);
      if (mpfUSD > 0) {
        usFees += Math.round(mpfUSD * this._rate());
        surchargeReasons.push('米国MPF(簡易通関)');
      }
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
    } else if (this._euDdpActive(country.code, input)) {
      // ★EU関税DDP(10/1〜): OC経由はDDP自動適用 → v1概算 / v2分解 をセラー負担で加算
      const eu = this._euOcTariff(country.code, input);
      tariffSeller = eu.tariffJPY;
      euBreakdown = eu.breakdown;
      if (tariffSeller > 0) surchargeReasons.push(eu.reason || 'EU関税DDP(セラー負担・概算)');
    }

    const totalCost = cost + surcharge + tariffSeller + usFees;

    return {
      carrier: 'eBay SpeedPAK Ship via FedEx',
      detail: 'FICP Zone ' + fedexZone,
      basicCost: cost,
      surcharge,
      surchargeReasons,
      euBreakdown,
      demandJPY,   // ★v3.6.1 内訳(UI/検証用)
      nssdsJPY,
      fuelJPY,
      tariffSeller,
      usFees,
      totalCost,
      billableG: Math.ceil(billableKg * 1000),
      estimatedDays: '2〜3営業日',
      tracking: true,
      insurance: true
    };
  }
};
