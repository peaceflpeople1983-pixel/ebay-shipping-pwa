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
    return {
      candidates,
      excluded, // v3.11
      context: {
        actualG: input.weightG,
        vol8000G: Math.ceil(vol8000 * 1000),
        vol5000G: Math.ceil(vol5000 * 1000),
        country: country.name,
        tariffJPY: tariffJPY,
        tariffRate: input.tariffRate || 0,
        euDdp: this._euDdpActive(country.code, input) // ★EU関税DDP適用中か(UI推奨表示用)
      }
    };
  },

  _epacket(input, country, dims, tariffJPY) {
    // v3.11: 除外時に理由を画面表示できるよう { _excluded:true, name, reason } を返す
    const NAME = 'ePacketライト';
    const ex = (reason) => ({ _excluded: true, name: NAME, reason });

    // ★EU関税DDP(10/1〜): 150€以下(価格不明含む)はDDPラベル必須のため日本郵便は使えない
    if (this._euDdpActive(country.code, input)) {
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
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      usFees = 245 + Math.round(tariffJPY * 0.021); // 米国輸入通関手数料 + 関税処理手数料2.1%
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
      if (usFees > 0) surchargeReasons.push('米国通関手数料');
    } else if (this._euDdpActive(country.code, input)) {
      // ★EU関税DDP(10/1〜): SpeedPAKはDDP自動適用 → 3€+手数料2.1%の概算をセラー負担で加算
      tariffSeller = this._euDdpConf().tariffJPY;
      if (tariffSeller > 0) surchargeReasons.push('EU関税DDP(セラー負担・概算)');
    }

    const totalCost = row[1] + surcharge + tariffSeller + usFees;

    return {
      carrier: 'eBay SpeedPAK Economy',
      detail: country.name,
      basicCost: row[1],
      surcharge,
      surchargeReasons,
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
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      usFees = Math.round(tariffJPY * 0.021); // 関税処理手数料2.1%（DHLは通関手数料は別途）
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
    } else if (this._euDdpActive(country.code, input)) {
      // ★EU関税DDP(10/1〜): OC経由はDDP自動適用 → 概算をセラー負担で加算
      tariffSeller = this._euDdpConf().tariffJPY;
      if (tariffSeller > 0) surchargeReasons.push('EU関税DDP(セラー負担・概算)');
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
      // ★EU関税DDP(10/1〜): OC経由はDDP自動適用 → 概算をセラー負担で加算
      tariffSeller = this._euDdpConf().tariffJPY;
      if (tariffSeller > 0) surchargeReasons.push('EU関税DDP(セラー負担・概算)');
    }

    const totalCost = cost + surcharge + tariffSeller + usFees;

    return {
      carrier: 'eBay SpeedPAK Ship via FedEx',
      detail: 'FICP Zone ' + fedexZone,
      basicCost: cost,
      surcharge,
      surchargeReasons,
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
