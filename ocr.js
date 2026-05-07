/**
 * カメラ＋GPT-4o Vision で eBay 注文ID を読み取る
 *
 * 方式:
 *   - 撮影ボタン押下で1枚だけキャプチャ → Apps Script経由でGPT-4o Visionに送信
 *   - tesseract.js は使用しない（端末内処理を廃止）
 *   - 結果は既知注文IDとLevenshtein距離で照合（誤読補正）
 *   - バーコードは引き続き端末内で検出
 */
const OCR = {
  stream: null,
  callback: null,
  knownOrderIds: [],
  busy: false,
 
  setKnownOrders(orders) {
    this.knownOrderIds = (orders || []).map(o => o.orderId).filter(Boolean);
  },
 
  async open(callback) {
    this.callback = callback || null;
    document.getElementById('ocr-overlay').classList.remove('hidden');
    this._setStatus('カメラ準備中...');
 
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          focusMode: 'continuous'
        }
      });
      const video = document.getElementById('ocr-video');
      video.srcObject = this.stream;
      await video.play();
      this._setStatus('注文IDをガイド枠に合わせて「撮影」をタップ');
      this._showROIGuide();
      this._tryBarcode();
    } catch (err) {
      this._setStatus('カメラを起動できません: ' + err.message);
    }
  },
 
  _setStatus(msg) {
    const el = document.getElementById('ocr-status');
    if (el) el.textContent = msg;
  },
 
  _showROIGuide() {
    let guide = document.getElementById('ocr-roi-guide');
    if (!guide) {
      guide = document.createElement('div');
      guide.id = 'ocr-roi-guide';
      guide.className = 'ocr-roi-guide';
      const overlay = document.getElementById('ocr-overlay');
      overlay.querySelector('.overlay-content').appendChild(guide);
    }
    guide.classList.remove('hidden');
  },
 
  /**
   * バーコード検出（端末内・無料）：注文IDが12桁数字としてエンコードされている場合に検出
   */
  async _tryBarcode() {
    if (!('BarcodeDetector' in window)) return;
    try {
      const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'qr_code', 'ean_13'] });
      const video = document.getElementById('ocr-video');
      const interval = setInterval(async () => {
        if (!this.stream) { clearInterval(interval); return; }
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            const matched = this._extractOrderIdLocal(codes[0].rawValue);
            if (matched) {
              const validated = this._validateAgainstKnown(matched);
              if (validated) {
                clearInterval(interval);
                this._onResult(validated, 'バーコード');
              }
            }
          }
        } catch (_) {}
      }, 500);
    } catch (_) {}
  },
 
  /**
   * 撮影ボタン押下時：1枚だけ撮影してGPT-4o Visionに送信
   */
  async capture() {
    if (this.busy) return;
    this.busy = true;
    try {
      this._setStatus('撮影 → AI解析中...（2〜4秒）');
 
      const video = document.getElementById('ocr-video');
      const canvas = document.getElementById('ocr-canvas');
 
      // ROIで中央水平帯のみを切り出し（注文IDが含まれる領域）
      const fullW = video.videoWidth;
      const fullH = video.videoHeight;
      const roiTop = Math.floor(fullH * 0.30);
      const roiH = Math.floor(fullH * 0.40);
 
      // 解析対象の最大幅は800px に縮小（API送信量を抑える）
      const targetW = Math.min(fullW, 800);
      const scale = targetW / fullW;
      canvas.width = targetW;
      canvas.height = Math.floor(roiH * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, roiTop, fullW, roiH, 0, 0, canvas.width, canvas.height);
 
      // JPEG品質0.7でbase64エンコード
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      const base64 = dataUrl.split(',')[1];
 
      // Apps Script経由でGPT-4o Visionに送信
      const result = await API.extractOrderId(base64);
 
      if (result.error) {
        this._setStatus('エラー: ' + result.error);
        return;
      }
 
      if (!result.orderId) {
        this._setStatus('注文IDが見つかりません: 「' + (result.raw || '判定なし') + '」');
        return;
      }
 
      // 既知注文IDと照合
      const validated = this._validateAgainstKnown(result.orderId);
      if (!validated) {
        this._setStatus('読取ID「' + result.orderId + '」は既存注文と一致しません');
        return;
      }
 
      this._onResult(validated, 'AI Vision');
    } catch (err) {
      this._setStatus('エラー: ' + err.message);
    } finally {
      this.busy = false;
    }
  },
 
  _validateAgainstKnown(candidate) {
    if (!this.knownOrderIds.length) return candidate;
    let best = null, bestDist = 99;
    for (const known of this.knownOrderIds) {
      if (known === candidate) return known;
      const d = this._levenshtein(candidate, known);
      if (d < bestDist) { bestDist = d; best = known; }
    }
    return bestDist <= 1 ? best : null; // GPT-4oは精度高いため距離1で十分
  },
 
  _levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(new Array(b.length).fill(0)));
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i-1] === b[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
      }
    }
    return dp[a.length][b.length];
  },
 
  /**
   * バーコード文字列から注文ID形式を抽出（端末内処理用）
   */
  _extractOrderIdLocal(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/\s+/g, '');
    let m = cleaned.match(/(?<!\d)(\d{2})-(\d{5})-(\d{5})(?!\d)/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = cleaned.match(/(?<!\d)(\d{12})(?!\d)/);
    if (m) {
      const s = m[1];
      return s.slice(0, 2) + '-' + s.slice(2, 7) + '-' + s.slice(7, 12);
    }
    return null;
  },
 
  _onResult(orderId, source) {
    this.close();
    showToast('読み取り成功（' + source + '）: ' + orderId);
    if (this.callback) this.callback(orderId);
  },
 
  close() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    const guide = document.getElementById('ocr-roi-guide');
    if (guide) guide.classList.add('hidden');
    document.getElementById('ocr-overlay').classList.add('hidden');
  }
};
