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

  calculate(input) {
    if (!this.master) throw new Error('Master data not loaded');
    const country = this.master.countries.find(c => c.code === input.country);
    if (!country) return { candidates: [], context: { error: 'Unknown country' } };

    const dims = [input.lengthCm, input.widthCm, input.heightCm].sort((a, b) => b - a);
    const vol8000 = (input.lengthCm * input.widthCm * input.heightCm) / 8000;
    const vol5000 = (input.lengthCm * input.widthCm * input.heightCm) / 5000;
    const candidates = [];

    const ep = this._epacket(input, country, dims);
    if (ep) candidates.push(ep);

    if (country.ecoSupported) {
      const eco = this._eco(input, country, dims, vol8000);
      if (eco) candidates.push(eco);
    }

    const dhl = this._dhl(input, country, dims, vol5000);
    if (dhl) candidates.push(dhl);

    candidates.sort((a, b) => a.totalCost - b.totalCost);
    return {
      candidates,
      context: {
        actualG: input.weightG,
        vol8000G: Math.ceil(vol8000 * 1000),
        vol5000G: Math.ceil(vol5000 * 1000),
        country: country.name
      }
    };
  },

  _epacket(input, country, dims) {
    if (!country.epacketZone) return { excluded: true, reason: 'ePacket対象外の国' };
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
      totalCost: cost,
      billableG: input.weightG,
      estimatedDays: '5〜21日',
      tracking: true,
      insurance: false
    };
  },

  _eco(input, country, dims, vol8000) {
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
    if (country.code === 'DE') {
      // バルキー条件などは省略（必要なら拡張）
    }

    return {
      carrier: 'eBay SpeedPAK Economy',
      detail: country.name,
      basicCost: row[1],
      surcharge,
      surchargeReasons,
      totalCost: row[1] + surcharge,
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

  _dhl(input, country, dims, vol5000) {
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

    return {
      carrier: 'eBay SpeedPAK Ship via DHL',
      detail: 'Zone ' + country.dhlZone,
      basicCost: cost,
      surcharge,
      surchargeReasons,
      totalCost: cost + surcharge,
      billableG: Math.ceil(billableKg * 1000),
      estimatedDays: '1〜5営業日',
      tracking: true,
      insurance: true
    };
  }
};
