/**
 * カメラ＋OCRで eBay 注文ID を読み取る
 * eBay注文IDの形式: 数字8桁-数字5桁-数字5桁 (例: 14-12345-67890)
 * バーコードがあればBarcodeDetector APIで先に試す
 */
const OCR = {
  stream: null,

  async open() {
    document.getElementById('ocr-overlay').classList.remove('hidden');
    document.getElementById('ocr-status').textContent = 'カメラ準備中...';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      const video = document.getElementById('ocr-video');
      video.srcObject = this.stream;
      await video.play();
      document.getElementById('ocr-status').textContent = '注文IDを画面中央に合わせて撮影';
      // バーコード自動検出を試行
      this._tryBarcode();
    } catch (err) {
      document.getElementById('ocr-status').textContent = 'カメラを起動できません: ' + err.message;
    }
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

  async capture() {
    const video = document.getElementById('ocr-video');
    const canvas = document.getElementById('ocr-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    document.getElementById('ocr-status').textContent = '読み取り中...';

    try {
      const result = await Tesseract.recognize(canvas, 'eng', {
        tessedit_char_whitelist: '0123456789-'
      });
      const text = result.data.text;
      const orderId = this._extractOrderId(text);
      if (orderId) {
        this._onResult(orderId, 'OCR');
      } else {
        document.getElementById('ocr-status').textContent = '注文IDが見つかりません。撮り直してください。';
      }
    } catch (err) {
      document.getElementById('ocr-status').textContent = 'エラー: ' + err.message;
    }
  },

  _extractOrderId(text) {
    // eBay注文ID形式：12-34567-89012 もしくは類似のハイフン区切り数字
    const m = text.replace(/\s+/g, '').match(/\d{2}-\d{5}-\d{5}/);
    if (m) return m[0];
    // バーコード等で連続数字の場合、ハイフン挿入を試行
    const m2 = text.replace(/\s+/g, '').match(/\d{12,14}/);
    if (m2) {
      const s = m2[0];
      if (s.length === 12) return s.slice(0, 2) + '-' + s.slice(2, 7) + '-' + s.slice(7);
    }
    return null;
  },

  _onResult(orderId, source) {
    document.getElementById('input-order-id').value = orderId;
    this.close();
    showToast('読み取り成功（' + source + '）: ' + orderId);
  },

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    document.getElementById('ocr-overlay').classList.add('hidden');
  }
};
