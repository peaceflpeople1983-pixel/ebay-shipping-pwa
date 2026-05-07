/**
 * カメラ＋OCRで eBay 注文ID を読み取る
 * eBay注文IDの形式: 数字8桁-数字5桁-数字5桁 (例: 14-12345-67890)
 * バーコードがあればBarcodeDetector APIで先に試す
 */
const OCR = {
  stream: null,
  callback: null,
  continuousTimer: null,
  busy: false,
 
  async open(callback) {
    this.callback = callback || null;
    document.getElementById('ocr-overlay').classList.remove('hidden');
    document.getElementById('ocr-status').textContent = 'カメラ準備中...';
    try {
      // 高解像度＋連続オートフォーカス
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
      document.getElementById('ocr-status').textContent = '注文IDをガイド枠に合わせる（自動認識中）';
      this._showROIGuide();
      this._tryBarcode();
      this._startContinuousOCR();
    } catch (err) {
      document.getElementById('ocr-status').textContent = 'カメラを起動できません: ' + err.message;
    }
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
 
  _startContinuousOCR() {
    // 1.5秒ごとに自動でOCR試行
    this.continuousTimer = setInterval(() => {
      if (!this.stream || this.busy) return;
      this.capture(true).catch(() => {});
    }, 1500);
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
              clearInterval(interval);
              this._onResult(matched, 'バーコード');
            }
          }
        } catch (_) {}
      }, 500);
    } catch (_) {}
  },
 
  async capture(silent) {
    if (this.busy) return;
    this.busy = true;
    try {
      const video = document.getElementById('ocr-video');
      const canvas = document.getElementById('ocr-canvas');
      // 中央水平帯をROIとして切り出し（注文IDが含まれる可能性が高い領域）
      const fullW = video.videoWidth;
      const fullH = video.videoHeight;
      const roiTop = Math.floor(fullH * 0.40);
      const roiH = Math.floor(fullH * 0.20);
      canvas.width = fullW;
      canvas.height = roiH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, roiTop, fullW, roiH, 0, 0, fullW, roiH);
      this._preprocess(canvas);
 
      if (!silent) document.getElementById('ocr-status').textContent = '読み取り中...';
 
      const result = await Tesseract.recognize(canvas, 'eng', {
        tessedit_char_whitelist: '0123456789-OoIlSsZz',
        tessedit_pageseg_mode: 7  // 単一行モード
      });
      const orderId = this._extractOrderId(result.data.text);
      if (orderId) {
        this._onResult(orderId, silent ? '自動認識' : 'OCR');
      } else if (!silent) {
        document.getElementById('ocr-status').textContent = '注文IDが見つかりません。ガイド枠に合わせて再撮影';
      }
    } catch (err) {
      if (!silent) document.getElementById('ocr-status').textContent = 'エラー: ' + err.message;
    } finally {
      this.busy = false;
    }
  },
 
  /**
   * 画像の前処理：グレースケール化＋二値化（テキスト認識精度UP）
   */
  _preprocess(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    // 平均輝度を計算（しきい値の動的設定用）
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i+1] + d[i+2]) / 3;
    }
    const avg = sum / (d.length / 4);
    const threshold = avg * 0.85;
    // グレースケール化＋二値化
    for (let i = 0; i < d.length; i += 4) {
      const gray = (d[i] + d[i+1] + d[i+2]) / 3;
      const v = gray > threshold ? 255 : 0;
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
  },
 
  _extractOrderId(text) {
    // OCRの誤認識補正：O→0, o→0, I/l/|→1, S/s→5, Z/z→2
    const cleaned = text
      .replace(/\s+/g, '')
      .replace(/[Oo]/g, '0')
      .replace(/[IlLi|]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Zz]/g, '2');
 
    // パターン1：標準形式 NN-NNNNN-NNNNN（区切りはハイフン or 任意の非数字）
    let m = cleaned.match(/(\d{2})[^\d]?(\d{5})[^\d]?(\d{5})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
 
    // パターン2：12桁連続数字
    m = cleaned.match(/\d{12}/);
    if (m) {
      const s = m[0];
      return s.slice(0, 2) + '-' + s.slice(2, 7) + '-' + s.slice(7);
    }
 
    // パターン3：14桁（バーコード等）
    m = cleaned.match(/\d{14}/);
    if (m) {
      const s = m[0];
      // 末尾12桁を採用
      const t = s.slice(2);
      return t.slice(0, 2) + '-' + t.slice(2, 7) + '-' + t.slice(7);
    }
    return null;
  },
 
  _onResult(orderId, source) {
    this.close();
    showToast('読み取り成功（' + source + '）: ' + orderId);
    if (this.callback) {
      this.callback(orderId);
    } else {
      // フォールバック：入力欄に転記
      const el = document.getElementById('input-order-id');
      if (el) el.value = orderId;
    }
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
