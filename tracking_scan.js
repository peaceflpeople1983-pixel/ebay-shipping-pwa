/**
 * tracking_scan.js — 追跡番号スキャン機能 (PWAクライアント新規ファイル / v1.0)
 *
 * 仕様: TRACKING_UPLOAD_PLAN_v1.md 参照
 * モックアップ: tracking_upload_mockup_v1.html 参照
 *
 * 主な機能:
 *   - カメラ起動 + ROI枠表示 (Japan Post追跡ラベル向け)
 *   - BarcodeDetector による Code 128 自動検出
 *   - GPT-4o Vision OCR フォールバック
 *   - 形式バリデーション (/^[A-Z]{2}\d{9}JP$/)
 *   - 確認ダイアログ + 手動入力ボトムシート
 *   - eBay API への uploadTracking 呼出
 *   - 成功時の振動フィードバック (navigator.vibrate)
 *
 * 既存ファイルとの関係:
 *   - 既存 OCR.js とは独立 (異なるオーバーレイ要素を使用)
 *   - 既存 API オブジェクトを利用
 *   - app.js から TrackingScan.openForTracking(o) で呼出
 *
 * グローバル: window.TrackingScan
 */

(function() {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================

  const JP_TRACKING_PATTERN = /^[A-Z]{2}\d{9}JP$/;
  const RETURN_DELAY_MS = 1500;  // 成功後、注文一覧に戻るまでの遅延
  const BARCODE_INTERVAL_MS = 500;

  // ============================================================
  // ヘルパー
  // ============================================================

  function isTrackingTargetOrder(o) {
    if (!o) return false;
    if (!window.Zonos || !window.Zonos.isZonosTargetOrder) return false;
    if (!window.Zonos.isZonosTargetOrder(o)) return false;
    if (!o.declarationId) return false;       // Zonos完了済が必須
    if (o.trackingNumber) return false;        // 既発送は対象外
    if (o.doukonRole === 'sub') return false;  // 同梱サブは代表で処理
    return true;
  }

  /**
   * 注文カード用の「📮 追跡番号スキャン」ボタンHTML
   */
  function buildTrackingButton(o) {
    if (!isTrackingTargetOrder(o)) return '';
    const doukonLabel = (o.doukonRole === 'lead' && o.doukonCount > 1)
      ? ' (' + o.doukonCount + '点まとめて)'
      : '';
    return '<button class="tracking-scan-card-btn" data-tracking-order-id="' +
      escapeAttrT_(o.orderId) + '">📮 追跡番号スキャン' + doukonLabel + '</button>';
  }

  // ============================================================
  // TrackingScan メインモジュール
  // ============================================================

  const TrackingScan = {
    stream: null,
    orderId: null,
    orderData: null,
    barcodeInterval: null,
    busy: false,
    pendingTracking: null,
    pendingSource: null,

    /**
     * スキャン画面を開く
     * @param {string} orderId
     * @param {Object} orderData - state.orders から取得
     */
    async openForTracking(orderId, orderData) {
      this.orderId = orderId;
      this.orderData = orderData || null;
      this.busy = false;
      this.pendingTracking = null;
      this.pendingSource = null;

      showScreen('screen-tracking-scan');
      this._updateTargetInfo();
      await this._startCamera();
      this._startBarcodeDetection();
    },

    /**
     * 戻る (画面 closes + camera stops)
     */
    close() {
      this._stopCamera();
      this._hideConfirmDialog();
      this.hideManualInput();
      this._hideUploadToast();
      this.orderId = null;
      this.orderData = null;
      this.pendingTracking = null;
      this.busy = false;
    },

    // ──────────────────────────────────────────────────────────
    // カメラ制御
    // ──────────────────────────────────────────────────────────

    _updateTargetInfo() {
      const orderIdEl = document.getElementById('tracking-target-order');
      const titleEl = document.getElementById('tracking-target-title');
      if (orderIdEl) orderIdEl.textContent = this.orderId || '—';
      if (titleEl && this.orderData) {
        titleEl.textContent = truncate_(this.orderData.itemTitle || '', 40);
      } else if (titleEl) {
        titleEl.textContent = '';
      }
    },

    async _startCamera() {
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
        const video = document.getElementById('tracking-video');
        if (video) {
          video.srcObject = this.stream;
          await video.play();
        }
        this._setStatus('バーコード自動検出中... タップでピント合わせ');
        this._bindTapFocus();
      } catch (err) {
        this._setStatus('カメラ起動失敗: ' + (err.message || err));
      }
    },

    _stopCamera() {
      if (this.barcodeInterval) {
        clearInterval(this.barcodeInterval);
        this.barcodeInterval = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
    },

    _bindTapFocus() {
      if (this._tapFocusBound) return;
      const wrap = document.getElementById('tracking-video-wrap');
      if (!wrap) return;
      wrap.addEventListener('click', () => this._refocus());
      this._tapFocusBound = true;
    },

    async _refocus() {
      try {
        if (!this.stream) return;
        const track = this.stream.getVideoTracks()[0];
        if (!track || !track.applyConstraints) return;
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps && caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch (_) {}
    },

    _setStatus(msg) {
      const el = document.getElementById('tracking-scan-status');
      if (el) el.textContent = msg;
    },

    // ──────────────────────────────────────────────────────────
    // バーコード検出 (Code 128)
    // ──────────────────────────────────────────────────────────

    _startBarcodeDetection() {
      if (!('BarcodeDetector' in window)) {
        console.warn('BarcodeDetector not supported on this device');
        return;
      }
      try {
        const detector = new BarcodeDetector({
          formats: ['code_128', 'code_39', 'qr_code']
        });
        const video = document.getElementById('tracking-video');
        if (!video) return;

        this.barcodeInterval = setInterval(async () => {
          if (!this.stream || this.busy) return;
          try {
            const codes = await detector.detect(video);
            for (const code of codes) {
              const tracking = this._extractTrackingFromText(code.rawValue);
              if (tracking) {
                clearInterval(this.barcodeInterval);
                this.barcodeInterval = null;
                this._onScanResult(tracking, 'バーコード');
                return;
              }
            }
          } catch (_) {}
        }, BARCODE_INTERVAL_MS);
      } catch (e) {
        console.warn('BarcodeDetector setup failed:', e);
      }
    },

    _extractTrackingFromText(text) {
      if (!text) return null;
      const cleaned = String(text).replace(/\s+/g, '').toUpperCase();
      const match = cleaned.match(/[A-Z]{2}\d{9}JP/);
      return match ? match[0] : null;
    },

    // ──────────────────────────────────────────────────────────
    // 撮影 + AI Vision OCR
    // ──────────────────────────────────────────────────────────

    async capture() {
      if (this.busy) return;
      this.busy = true;
      try {
        this._setStatus('ピント合わせ中...');
        this._refocus();
        await new Promise(r => setTimeout(r, 400));
        this._setStatus('撮影 → AI解析中... (2-4秒)');

        const video = document.getElementById('tracking-video');
        const canvas = document.getElementById('tracking-canvas');

        // ROI: 中央水平帯のみ切出 (既存OCRと同じ 34%/32%)
        const fullW = video.videoWidth;
        const fullH = video.videoHeight;
        const roiTop = Math.floor(fullH * 0.34);
        const roiH = Math.floor(fullH * 0.32);

        const targetW = Math.min(fullW, 1200);
        const scale = targetW / fullW;
        canvas.width = targetW;
        canvas.height = Math.floor(roiH * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, roiTop, fullW, roiH, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        const base64 = dataUrl.split(',')[1];

        const result = await this._fetchOcr(base64);

        if (result.error) {
          this._setStatus('エラー: ' + result.error);
          return;
        }
        if (!result.trackingNumber) {
          this._setStatus('追跡番号が見つかりません: 「' + (result.raw || '判定なし') + '」');
          return;
        }

        this._onScanResult(result.trackingNumber, 'AI Vision');
      } catch (err) {
        this._setStatus('エラー: ' + (err.message || err));
      } finally {
        this.busy = false;
      }
    },

    async _fetchOcr(base64) {
      const body = {
        action: 'extractTrackingNumber',
        secret: API.config.secret || '',
        image: base64
      };
      const res = await fetch(API.config.url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain' }
      });
      if (!res.ok) throw new Error('OCR API error: ' + res.status);
      return res.json();
    },

    // ──────────────────────────────────────────────────────────
    // スキャン結果処理 → 確認ダイアログ
    // ──────────────────────────────────────────────────────────

    _onScanResult(tracking, source) {
      tracking = String(tracking).trim().toUpperCase();

      // 形式チェック
      if (!JP_TRACKING_PATTERN.test(tracking)) {
        this._setStatus('形式不正: ' + tracking + ' (再スキャンしてください)');
        // バーコード検出を再開
        if (!this.barcodeInterval && this.stream) {
          this._startBarcodeDetection();
        }
        return;
      }

      this.pendingTracking = tracking;
      this.pendingSource = source;
      this._showConfirmDialog();
    },

    _showConfirmDialog() {
      const overlay = document.getElementById('tracking-confirm-overlay');
      const trackingEl = document.getElementById('tracking-confirm-number');
      const sourceEl = document.getElementById('tracking-confirm-source');
      const doukonEl = document.getElementById('tracking-confirm-doukon');

      if (trackingEl) trackingEl.textContent = this.pendingTracking;
      if (sourceEl) {
        sourceEl.textContent = this.pendingSource === 'バーコード'
          ? 'バーコード自動検出'
          : (this.pendingSource === '手動入力' ? '手動入力' : 'AI Vision 認識');
      }

      // 同梱表示
      if (doukonEl) {
        if (this.orderData && this.orderData.doukonGroupId && this.orderData.doukonCount > 1) {
          const items = (this.orderData.doukonItems || []).map(it =>
            '<li>' + escapeHtmlT_(it.orderId) + ' - ' + escapeHtmlT_(truncate_(it.itemTitle || '', 30)) + '</li>'
          ).join('');
          doukonEl.innerHTML = '<strong>📦 同梱 (' + this.orderData.doukonCount + '件まとめて):</strong>' +
            (items ? '<ul>' + items + '</ul>' : '');
          doukonEl.classList.remove('hidden');
        } else {
          doukonEl.classList.add('hidden');
        }
      }

      // ボタンのテキストを同梱対応
      const confirmBtn = document.getElementById('btn-tracking-confirm');
      if (confirmBtn) {
        if (this.orderData && this.orderData.doukonCount > 1) {
          confirmBtn.textContent = this.orderData.doukonCount + '件まとめて登録';
        } else {
          confirmBtn.textContent = 'eBayへ登録';
        }
      }

      if (overlay) overlay.classList.remove('hidden');
    },

    _hideConfirmDialog() {
      const overlay = document.getElementById('tracking-confirm-overlay');
      if (overlay) overlay.classList.add('hidden');
    },

    /**
     * 再スキャン (確認ダイアログから戻る)
     */
    rescan() {
      this._hideConfirmDialog();
      this.pendingTracking = null;
      this._setStatus('バーコード自動検出中...');
      if (!this.barcodeInterval && this.stream) {
        this._startBarcodeDetection();
      }
    },

    /**
     * eBayへの登録実行 (確認ダイアログから「登録」タップ)
     */
    async confirmUpload() {
      if (!this.pendingTracking || !this.orderId) return;
      const tracking = this.pendingTracking;
      const orderId = this.orderId;

      this._hideConfirmDialog();
      this._stopCamera();
      this._showUploadToast('eBay へアップロード中...', 'progress');

      try {
        const body = {
          action: 'uploadTracking',
          secret: API.config.secret || '',
          orderId: orderId,
          trackingNumber: tracking,
          options: {}
        };
        const res = await fetch(API.config.url, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'text/plain' }
        });
        const result = await res.json();

        if (result.error) {
          this._showUploadToast('失敗: ' + result.error, 'error');
          return;
        }

        if (result.success) {
          const msg = 'eBay 発送マーク完了' +
            (result.isDoukon ? ' (' + result.totalRows + '件)' : '');
          this._showUploadToast(msg, 'success');
          if (navigator.vibrate) navigator.vibrate(100);

          // 注文一覧を更新
          if (typeof App !== 'undefined' && App.loadAll) {
            try { await App.loadAll(); } catch (_) {}
          }

          // 注文一覧に戻る
          setTimeout(() => {
            this._hideUploadToast();
            this.close();
            if (typeof showScreenGlobal === 'function') {
              showScreenGlobal('screen-list');
            } else {
              showScreen('screen-list');
            }
          }, RETURN_DELAY_MS);
        } else {
          // ★ needsManual (eBay側でorderが認識されない稀ケース) を最優先で表示
          const needsManualResults = (result.results || []).filter(r => r.needsManual);
          if (needsManualResults.length > 0) {
            // ★ v3.18.17: 破損注文向け — シートにのみ記録して「発送済」にする選択肢を提示。
            //   (eBay への登録は Seller Hub で手動実施する運用)
            const recordOnly = confirm(
              '⚠ eBay側でこの注文を認識できません(API破損注文)。\n\n' +
              'Seller Hub で手動アップロードする前提で、追跡番号をシートにのみ記録して「発送済」にしますか？\n' +
              '(記録すると一覧・追跡スキャン待ちから消えます)'
            );
            if (!recordOnly) {
              this._showUploadToast('⚠ eBay側で更新不可。Seller Hubで手動アップロードしてください', 'error');
              return;
            }
            try {
              const body2 = {
                action: 'uploadTracking',
                secret: API.config.secret || '',
                orderId: orderId,
                trackingNumber: tracking,
                options: { sheetOnly: true }
              };
              const res2 = await fetch(API.config.url, {
                method: 'POST',
                body: JSON.stringify(body2),
                headers: { 'Content-Type': 'text/plain' }
              });
              const result2 = await res2.json();
              if (result2 && result2.success) {
                this._showUploadToast('📋 シートに記録しました (発送済扱い)', 'success');
                if (navigator.vibrate) navigator.vibrate(100);
                if (typeof App !== 'undefined' && App.loadAll) {
                  try { await App.loadAll(); } catch (_) {}
                }
                setTimeout(() => {
                  this._hideUploadToast();
                  this.close();
                  if (typeof showScreenGlobal === 'function') {
                    showScreenGlobal('screen-list');
                  } else {
                    showScreen('screen-list');
                  }
                }, RETURN_DELAY_MS);
              } else {
                this._showUploadToast('記録失敗: ' + ((result2 && result2.error) || 'unknown'), 'error');
              }
            } catch (e2) {
              this._showUploadToast('記録エラー: ' + e2.message, 'error');
            }
            return;
          }

          // 部分失敗
          const failedCount = (result.results || []).filter(r => !r.success).length;
          const msg = '部分失敗: ' + failedCount + '件失敗 (' + (result.results || [])
            .filter(r => !r.success)
            .map(r => r.error || 'unknown')
            .join(' / ') + ')';
          this._showUploadToast(msg, 'error');
        }
      } catch (e) {
        this._showUploadToast('通信エラー: ' + e.message, 'error');
      }
    },

    // ──────────────────────────────────────────────────────────
    // 手動入力ボトムシート
    // ──────────────────────────────────────────────────────────

    showManualInput() {
      const overlay = document.getElementById('tracking-manual-overlay');
      const subEl = document.getElementById('tracking-manual-sub');
      const inputEl = document.getElementById('tracking-manual-input');
      if (subEl && this.orderId) {
        subEl.textContent = this.orderId +
          (this.orderData && this.orderData.itemTitle
            ? ' / ' + truncate_(this.orderData.itemTitle, 30)
            : '');
      }
      if (inputEl) {
        inputEl.value = '';
        setTimeout(() => inputEl.focus(), 100);
      }
      if (overlay) overlay.classList.remove('hidden');
    },

    hideManualInput() {
      const overlay = document.getElementById('tracking-manual-overlay');
      if (overlay) overlay.classList.add('hidden');
    },

    submitManualInput() {
      const input = document.getElementById('tracking-manual-input');
      if (!input) return;
      const tracking = String(input.value || '').trim().toUpperCase();
      if (!JP_TRACKING_PATTERN.test(tracking)) {
        if (typeof showToast === 'function') {
          showToast('形式不正: 2文字 + 9桁 + JP (例: EE123456789JP)');
        }
        return;
      }
      this.hideManualInput();
      this._onScanResult(tracking, '手動入力');
    },

    // ──────────────────────────────────────────────────────────
    // トースト表示
    // ──────────────────────────────────────────────────────────

    _showUploadToast(msg, type) {
      let toast = document.getElementById('tracking-upload-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'tracking-upload-toast';
        document.body.appendChild(toast);
      }
      toast.className = 'tracking-upload-toast ' + (type || '');
      toast.innerHTML = type === 'progress'
        ? '<div class="tracking-upload-spinner"></div><span>' + escapeHtmlT_(msg) + '</span>'
        : '<span style="font-size:18px;">' + (type === 'success' ? '✓' : '⚠') + '</span><span>' + escapeHtmlT_(msg) + '</span>';
      toast.classList.remove('hidden');

      if (type !== 'progress') {
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this._hideUploadToast(), 5000);
      }
    },

    _hideUploadToast() {
      const toast = document.getElementById('tracking-upload-toast');
      if (toast) toast.classList.add('hidden');
      clearTimeout(this._toastTimer);
    }
  };

  // ============================================================
  // ユーティリティ
  // ============================================================

  function escapeHtmlT_(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttrT_(s) {
    return escapeHtmlT_(s);
  }
  function truncate_(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(id);
    if (target) target.classList.remove('hidden');
  }

  // ============================================================
  // グローバルエクスポート
  // ============================================================
  window.TrackingScan = {
    openForTracking: function(orderId, orderData) {
      return TrackingScan.openForTracking(orderId, orderData);
    },
    capture: function() {
      return TrackingScan.capture();
    },
    rescan: function() {
      return TrackingScan.rescan();
    },
    confirmUpload: function() {
      return TrackingScan.confirmUpload();
    },
    showManualInput: function() {
      return TrackingScan.showManualInput();
    },
    hideManualInput: function() {
      return TrackingScan.hideManualInput();
    },
    submitManualInput: function() {
      return TrackingScan.submitManualInput();
    },
    close: function() {
      return TrackingScan.close();
    },
    isTrackingTargetOrder: isTrackingTargetOrder,
    buildTrackingButton: buildTrackingButton,
    JP_TRACKING_PATTERN: JP_TRACKING_PATTERN
  };

})();
