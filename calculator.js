/**
 * 発送会社最適選定ロジック
 *
 * masterData: Apps Scriptから取得したマスタデータ
 * input: { country, weightG, lengthCm, widthCm, heightCm }
 * 戻り値: { candidates: [{carrier, totalCost, ...}], context: {...} }
 */
const Calculator = {
  master: null,
  setMaster(m) { this.master = m; },
 
  // 為替レート（USD→JPY、概算）。実運用で必要があればAI設定で外出し可
  exchangeRate: 150,
 
  calculate(input) {
    if (!this.master) throw new Error('Master data not loaded');
    const country = this.master.countries.find(c => c.code === input.country);
    if (!country) return { candidates: [], context: { error: 'Unknown country' } };
 
    const dims = [input.lengthCm, input.widthCm, input.heightCm].sort((a, b) => b - a);
    const vol8000 = (input.lengthCm * input.widthCm * input.heightCm) / 8000;
    const vol5000 = (input.lengthCm * input.widthCm * input.heightCm) / 5000;
 
    // 米国向けの関税概算（円）
    const tariffJPY = (country.code === 'US' && input.itemPriceUSD && input.tariffRate)
      ? Math.round(input.itemPriceUSD * input.tariffRate / 100 * this.exchangeRate)
      : 0;
 
    const candidates = [];
 
    const ep = this._epacket(input, country, dims, tariffJPY);
    if (ep) candidates.push(ep);
 
    if (country.ecoSupported) {
      const eco = this._eco(input, country, dims, vol8000, tariffJPY);
      if (eco) candidates.push(eco);
    }
 
    const dhl = this._dhl(input, country, dims, vol5000, tariffJPY);
    if (dhl) candidates.push(dhl);
 
    const fedex = this._fedex(input, country, dims, vol5000, tariffJPY);
    if (fedex) candidates.push(fedex);
 
    candidates.sort((a, b) => a.totalCost - b.totalCost);
    return {
      candidates,
      context: {
        actualG: input.weightG,
        vol8000G: Math.ceil(vol8000 * 1000),
        vol5000G: Math.ceil(vol5000 * 1000),
        country: country.name,
        tariffJPY: tariffJPY,
        tariffRate: input.tariffRate || 0
      }
    };
  },
 
  _epacket(input, country, dims, tariffJPY) {
    if (!country.epacketZone) return null;
    if (input.weightG > 2000) return null;
    if (dims[0] > 60) return null;
    if (dims[0] + dims[1] + dims[2] > 90) return null;
    if (dims[0] < 14.8 || dims[1] < 10.5) return null;
 
    const w100 = Math.ceil(input.weightG / 100) * 100;
    const row = this.master.rates.epacket.find(r => r[0] === w100);
    if (!row) return null;
    const cost = row[country.epacketZone];
 
    return {
      carrier: 'ePacketライト',
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
    if (billableKg > 25) return null;
    if (country.code === 'GB' && input.weightG / 1000 > 15) return null;
    if (country.code === 'AU' && input.weightG / 1000 > 22) return null;
 
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
 
    // 米国向け関税＋通関手数料（Orange Connex経由はセラー負担）
    let usFees = 0;
    let tariffSeller = 0;
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      usFees = 245 + Math.round(tariffJPY * 0.021); // 米国輸入通関手数料 + 関税処理手数料2.1%
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
      if (usFees > 0) surchargeReasons.push('米国通関手数料');
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
      estimatedDays: '6〜12営業日',
      tracking: true,
      insurance: true
    };
  },
 
  _ecoTable(code) {
    if (code === 'US') return this.master.rates.ecoUSA48;
    if (code === 'GB') return this.master.rates.ecoUK;
    if (code === 'DE') return this.master.rates.ecoDE;
    if (code === 'AU') return this.master.rates.ecoAU;
    return null;
  },
 
  _ecoSizeOk(input, country, dims) {
    const c = country.code;
    if (c === 'US') return dims[0] <= 66 && (dims[0] + 2 * (dims[1] + dims[2])) <= 274;
    if (c === 'GB') return dims[0] <= 120 && (dims[0] + 2 * (dims[1] + dims[2])) <= 225;
    if (c === 'DE') return dims[0] <= 110 && dims[1] <= 50 && dims[2] <= 50;
    if (c === 'AU') return dims[0] <= 105 && (input.lengthCm * input.widthCm * input.heightCm) <= 250000;
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
    }
 
    const totalCost = cost + surcharge + tariffSeller + usFees;
 
    return {
      carrier: 'eBay SpeedPAK Ship via DHL',
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
    const billableKg = Math.max(input.weightG / 1000, vol5000);
    if (billableKg > 68) return null;
 
    // 料金検索：重量を切り上げて該当行を取得
    const fedexRates = this.master.rates.fedex || [];
    const tier = fedexRates.find(r => r.weight >= billableKg);
    if (!tier) return null;
    const cost = tier.zones[fedexZone];
    if (!cost) return null;
 
    let surcharge = 0;
    const surchargeReasons = [];
    const sc = this.master.surcharges.fedex || {};
    // オーバーサイズ：長さ243cm超 or 長さ+胴回り330cm超
    if (dims[0] > 243 || (dims[0] + girth) > 330) {
      surcharge += sc.oversizeFlat || 8800;
      surchargeReasons.push('オーバーサイズ');
    } else if (dims[0] > 121 || dims[1] > 76 || (dims[0] + girth) > 266) {
      // 特別取扱料金（寸法）：長さ121cm超 or 二番目76cm超 or 長さ+胴回り266cm超
      surcharge += sc.specialHandlingDimFlat || 3390;
      surchargeReasons.push('特別取扱料金(寸法)');
    }
    if (input.weightG / 1000 > 25) {
      surcharge += sc.specialHandlingWeightFlat || 3390;
      surchargeReasons.push('特別取扱料金(重量)');
    }
 
    // 米国向け関税：FICPは米国輸入手続き手数料が無料、関税転送も無料
    let tariffSeller = 0;
    let usFees = 0;
    if (country.code === 'US') {
      tariffSeller = tariffJPY;
      // 関税処理手数料 2.1% のみ加算（FICPは他の通関手数料が無料）
      usFees = Math.round(tariffJPY * (sc.usDutyProcessRate || 0.021));
      if (tariffSeller > 0) surchargeReasons.push('米国関税(セラー負担)');
    }
 
    const totalCost = cost + surcharge + tariffSeller + usFees;
 
    return {
      carrier: 'eBay SpeedPAK Ship via FedEx',
      detail: 'FICP Zone ' + fedexZone,
      basicCost: cost,
      surcharge,
      surchargeReasons,
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
