/**
 * カメラ＋OCRで eBay 注文ID を読み取る
 *
 * 改善ポイント:
 *   A. 既知注文IDとの照合（Levenshtein距離 ≤2 で自動補正）
 *   B. 連続合致判定（2回連続で同じIDが出たら採用）
 *   C. 信頼度しきい値（tesseractの conf < 70 は破棄）
 *   穏やかな前処理（グレースケールのみ、二値化なし）
 *   ROIガイド（中央水平帯）
 *   バーコード自動検出
 */
const OCR = {
  stream: null,
  callback: null,
  knownOrderIds: [],
  continuousTimer: null,
  busy: false,
  // 連続合致判定用
  lastCandidate: null,
  consensusCount: 0,
  totalAttempts: 0,
  // 信頼度しきい値
  CONFIDENCE_MIN: 70,
  // 連続合致でこの数を超えたら採用
  CONSENSUS_REQUIRED: 2,
  // この回数だけ試行して見つからなければ警告
  MAX_ATTEMPTS_BEFORE_WARN: 15,
 
  setKnownOrders(orders) {
    this.knownOrderIds = (orders || []).map(o => o.orderId).filter(Boolean);
  },
 
  async open(callback) {
    this.callback = callback || null;
    this.lastCandidate = null;
    this.consensusCount = 0;
    this.totalAttempts = 0;
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
      this._setStatus('注文IDをガイド枠に合わせる（自動認識中）');
      this._showROIGuide();
      this._tryBarcode();
      this._startContinuousOCR();
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
            const text = codes[0].rawValue;
            const matched = this._extractOrderId(text);
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
 
  _startContinuousOCR() {
    // 1.8秒ごとに自動でOCR試行（処理が重なる場合はスキップ）
    this.continuousTimer = setInterval(() => {
      if (!this.stream || this.busy) return;
      this.capture(true).catch(() => {});
    }, 1800);
  },
 
  async capture(silent) {
    if (this.busy) return;
    this.busy = true;
    try {
      const video = document.getElementById('ocr-video');
      const canvas = document.getElementById('ocr-canvas');
      // 中央水平帯をROIとして切り出し
      const fullW = video.videoWidth;
      const fullH = video.videoHeight;
      const roiTop = Math.floor(fullH * 0.40);
      const roiH = Math.floor(fullH * 0.20);
      canvas.width = fullW;
      canvas.height = roiH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, roiTop, fullW, roiH, 0, 0, fullW, roiH);
      // 穏やかな前処理（グレースケールのみ）
      this._toGrayscale(canvas);
 
      this.totalAttempts++;
      if (!silent) this._setStatus('読み取り中...');
 
      const result = await Tesseract.recognize(canvas, 'eng', {
        tessedit_char_whitelist: '0123456789-',
        tessedit_pageseg_mode: 7  // 単一行モード
      });
 
      // C: 信頼度しきい値判定
      const conf = result.data && result.data.confidence;
      if (conf !== undefined && conf < this.CONFIDENCE_MIN) {
        if (!silent) this._setStatus('信頼度低（' + Math.round(conf) + '%）...');
        return;
      }
 
      const candidate = this._extractOrderId(result.data.text);
      if (!candidate) {
        if (this.totalAttempts > this.MAX_ATTEMPTS_BEFORE_WARN && !silent) {
          this._setStatus('注文IDが見つかりません。明るい場所でガイド枠に合わせてください');
        }
        return;
      }
 
      // A: 既知注文IDと突合
      const validated = this._validateAgainstKnown(candidate);
      if (!validated) {
        if (this.totalAttempts > this.MAX_ATTEMPTS_BEFORE_WARN && !silent) {
          this._setStatus('読み取りID「' + candidate + '」は既存注文と一致しません');
        }
        return;
      }
 
      // B: 連続合致判定
      if (validated === this.lastCandidate) {
        this.consensusCount++;
        if (this.consensusCount >= this.CONSENSUS_REQUIRED) {
          this._onResult(validated, 'OCR');
          return;
        }
        this._setStatus('確認中... (' + this.consensusCount + '/' + this.CONSENSUS_REQUIRED + ')');
      } else {
        this.lastCandidate = validated;
        this.consensusCount = 1;
        this._setStatus('検出: ' + validated + '（再確認中...）');
      }
    } catch (err) {
      if (!silent) this._setStatus('エラー: ' + err.message);
    } finally {
      this.busy = false;
    }
  },
 
  /**
   * 穏やかなグレースケール化のみ（二値化はしない）
   */
  _toGrayscale(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      d[i] = d[i+1] = d[i+2] = gray;
    }
    ctx.putImageData(img, 0, 0);
  },
 
  /**
   * 候補を既知注文IDと照合。Levenshtein距離 ≤2 なら最も近いIDを返す
   */
  _validateAgainstKnown(candidate) {
    if (!this.knownOrderIds.length) return candidate; // 既知リスト未登録なら素通り
    let best = null, bestDist = 99;
    for (const known of this.knownOrderIds) {
      const d = this._levenshtein(candidate, known);
      if (d < bestDist) { bestDist = d; best = known; }
      if (d === 0) return known;
    }
    return bestDist <= 2 ? best : null;
  },
 
  /**
   * Levenshtein距離（編集距離）
   */
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
 
  _extractOrderId(text) {
    if (!text) return null;
    // 改行・空白を除去（Order:などの英字残骸はwhitelistで既に除外されている前提）
    const cleaned = String(text).replace(/\s+/g, '');
 
    // 厳密形式: NN-NNNNN-NNNNN（2桁-5桁-5桁・ハイフン2回・前後に数字が連続しない）
    let m = cleaned.match(/(?<!\d)(\d{2})-(\d{5})-(\d{5})(?!\d)/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
 
    // 緩和形式: ちょうど12桁の連続数字（ハイフンがOCRで欠落した場合）
    // 前後に数字が連続する場合は対象外（誤って14桁の一部を切り出すのを防止）
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
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer);
      this.continuousTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    const guide = document.getElementById('ocr-roi-guide');
    if (guide) guide.classList.add('hidden');
    document.getElementById('ocr-overlay').classList.add('hidden');
  }
};
