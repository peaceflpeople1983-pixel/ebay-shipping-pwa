/**
 * zonos_api.js — Zonos API ラベル発行 UI (PWAクライアント新規ファイル / v1.0 2026-09-20)
 *
 * 計画書: ZONOS_API_PLAN_v1.md / GAS側: apps_script_v3.17.0/zonos_api.gs
 *
 * 機能:
 *   - Zonos送信画面 (screen-zonos) の先頭に「⚡ APIでラベル発行」セクションを注入
 *     (Zonos.Screen._render をフック — zonos.js へのパッチ不要)
 *   - 発送日入力 (既定=翌日) → GAS zonosCreateLabel 実行
 *   - 応答のラベルPDF(base64)へ pdf-lib で発送日を上書き印字 (署名左横・8pt) → ダウンロード
 *   - 既存のPC受け渡し(手作業)フローはフォールバックとしてそのまま残る
 *
 * グローバル: window.ZonosApi
 */

(function () {
  'use strict';

  // 発送日印字の位置 (pt)。ラベルA4=595x842pt・署名欄の「見出しと署名の間」左寄せ
  // (v1.0の署名左横 y=466 は署名が左寄り配置の個体で重なった → 上段へ移動・2026-09-21検証済み)
  // pdf-lib は左下原点のため y = 842 - 357.5 ≈ 484
  const DATE_X = 172;
  const DATE_Y_FROM_BOTTOM = 484;
  const DATE_FONT_SIZE = 8;

  const PDF_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  let lastResult = null; // 直近の発行結果 (再ダウンロード用)

  // ============================================================
  // pdf-lib 遅延ロード (発行時のみ必要・ネットワークはどのみち必須)
  // ============================================================

  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDF_LIB_URL;
      s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib load failed'));
      s.onerror = () => reject(new Error('pdf-lib の読み込みに失敗 (ネットワーク確認)'));
      document.head.appendChild(s);
    });
  }

  // ============================================================
  // PDF加工: 発送日を署名左横に印字
  // ============================================================

  async function stampDateOnLabel(base64Pdf, dateStr) {
    const PDFLib = await loadPdfLib();
    const bytes = Uint8Array.from(atob(base64Pdf), c => c.charCodeAt(0));
    const doc = await PDFLib.PDFDocument.load(bytes);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const page = doc.getPages()[0];
    const text = dateStr.replace(/-/g, '/'); // 2026/09/25 形式
    page.drawText(text, {
      x: DATE_X,
      y: DATE_Y_FROM_BOTTOM,
      size: DATE_FONT_SIZE,
      font: font,
      color: PDFLib.rgb(0, 0, 0)
    });
    return doc.save(); // Uint8Array
  }

  function downloadPdf(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ============================================================
  // UIセクション
  // ============================================================

  function tomorrowStr() {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** screen-zonos 描画後に呼ばれ、APIセクションを先頭へ注入する */
  function injectSection() {
    const root = document.getElementById('zonos-content');
    if (!root || document.getElementById('zonos-api-sec')) return;
    const st = (window.Zonos && Zonos.Screen && Zonos.Screen.state) || {};
    const d = st.data;
    if (!d || d.error) return; // データ未取得・エラー時は出さない

    const hasDecl = !!(d.existingDeclaration && d.existingDeclaration.declarationId);
    const sec = document.createElement('div');
    sec.id = 'zonos-api-sec';
    sec.innerHTML =
      '<div class="zapi-title">⚡ APIでラベル発行 <span class="zapi-badge">NEW</span></div>' +
      (hasDecl
        ? '<div class="zapi-note">この注文は既にDeclaration ID取得済みです (' +
          escapeHtml(d.existingDeclaration.declarationId) + ')。再発行はできません。</div>'
        : '<div class="zapi-row">' +
            '<label>発送日 <input type="date" id="zapi-shipdate" value="' + tomorrowStr() + '"></label>' +
            '<button class="zapi-btn" id="zapi-issue">⚡ ラベル発行</button>' +
          '</div>' +
          '<div class="zapi-note">関税計算→Declaration ID→ラベルPDF(署名+発送日印字済み)まで自動。' +
          '運賃は後納・関税はZonos登録カードに引受後課金。</div>') +
      '<div id="zapi-result"></div>';
    root.insertBefore(sec, root.firstChild);
    injectStyles();

    const btn = document.getElementById('zapi-issue');
    if (btn) btn.onclick = () => issueLabel(d);
  }

  async function issueLabel(d) {
    const btn = document.getElementById('zapi-issue');
    const resultEl = document.getElementById('zapi-result');
    const shipDate = (document.getElementById('zapi-shipdate') || {}).value || tomorrowStr();

    const summary = 'APIでラベルを発行します:\n\n' +
      '注文: ' + d.orderId + (d.doukonCount > 1 ? ' (' + d.doukonCount + '点同梱)' : '') + '\n' +
      '申告価格合計: ¥' + Number(d.totalValue).toLocaleString() + '\n' +
      '重量: ' + (d.items[0] && d.items[0].weightG || '?') + 'g\n' +
      '発送日: ' + shipDate + '\n\n' +
      '※関税+手数料は引受後にZonos登録カードへ課金されます。実行しますか？';
    if (!window.confirm(summary)) return;

    btn.disabled = true;
    btn.textContent = '発行中... (10〜30秒)';
    resultEl.innerHTML = '';
    try {
      const r = await API._post({
        action: 'zonosCreateLabel',
        secret: API.config.secret,
        orderId: d.orderId,
        shipDate: shipDate
      });
      if (!r || r.error) throw new Error((r && r.error) || '不明なエラー');

      lastResult = r;
      // PDFに発送日を印字してダウンロード
      let pdfOk = true;
      try {
        const stamped = await stampDateOnLabel(r.labelBase64, r.shipDate);
        downloadPdf(stamped, 'airpacket_' + r.trackingNumber + '_' + r.shipDate + '.pdf');
      } catch (e) {
        pdfOk = false;
        console.error('PDF加工失敗:', e);
      }

      resultEl.innerHTML =
        '<div class="zapi-success">' +
          '✅ 発行成功<br>' +
          '追跡番号: <b>' + escapeHtml(r.trackingNumber) + '</b><br>' +
          'Declaration ID: ' + escapeHtml(r.declarationId) + '<br>' +
          '運賃(後納): ¥' + Number(r.rateJpy).toLocaleString() + ' (第' + r.zone + '地帯・' + r.weightG + 'g)<br>' +
          '関税+手数料(カード): ¥' + Number(r.dutyJpy + r.feeJpy).toLocaleString() +
          ' (関税' + Number(r.dutyJpy).toLocaleString() + '+手数料' + Number(r.feeJpy).toLocaleString() + ')<br>' +
          (pdfOk ? 'ラベルPDF(発送日印字済み)をダウンロードしました' :
            '⚠ PDF加工に失敗。<button id="zapi-redl">元のPDFを保存</button>') +
        '</div>';
      const redl = document.getElementById('zapi-redl');
      if (redl) redl.onclick = () => {
        const bytes = Uint8Array.from(atob(lastResult.labelBase64), c => c.charCodeAt(0));
        downloadPdf(bytes, 'airpacket_' + lastResult.trackingNumber + '.pdf');
      };
      if (typeof showToast === 'function') showToast('✓ ラベル発行: ' + r.trackingNumber);
      // 一覧・差出票へ反映
      if (window.App && typeof App.loadAll === 'function') App.loadAll();
    } catch (e) {
      resultEl.innerHTML = '<div class="zapi-error">❌ ' + escapeHtml(e.message || String(e)) + '</div>';
      btn.disabled = false;
      btn.textContent = '⚡ ラベル発行';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (document.getElementById('zapi-styles')) return;
    const st = document.createElement('style');
    st.id = 'zapi-styles';
    st.textContent = [
      '#zonos-api-sec { background: #eef4ff; border: 2px solid #1F3864; border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }',
      '.zapi-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; }',
      '.zapi-badge { background: #c62828; color: #fff; border-radius: 8px; padding: 1px 8px; font-size: 10px; vertical-align: middle; }',
      '.zapi-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }',
      '.zapi-row label { font-size: 13px; }',
      '.zapi-row input[type=date] { font-size: 14px; padding: 6px; border: 1px solid #ccc; border-radius: 6px; }',
      '.zapi-btn { background: #1F3864; color: #fff; border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; cursor: pointer; }',
      '.zapi-btn:disabled { background: #9aa5bd; }',
      '.zapi-note { font-size: 11px; color: #555; }',
      '.zapi-success { background: #e8f5e9; border-radius: 8px; padding: 10px; font-size: 13px; margin-top: 8px; line-height: 1.7; }',
      '.zapi-error { background: #fbe9e7; color: #c62828; border-radius: 8px; padding: 10px; font-size: 13px; margin-top: 8px; }',
      '.zapi-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 16px; }',
      '.zapi-panel { background: #fff; border-radius: 12px; max-width: 560px; width: 100%; max-height: 85vh; overflow-y: auto; padding: 16px; }',
      '.zapi-up-list { border: 1px solid #e0e0e0; border-radius: 8px; padding: 4px; margin: 10px 0; max-height: 40vh; overflow-y: auto; }',
      '.zapi-up-row { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid #f0f0f0; font-size: 13px; flex-wrap: wrap; }',
      '.zapi-up-row input[type=checkbox] { width: 20px !important; height: 20px !important; flex: none; margin: 0; padding: 0; appearance: auto; -webkit-appearance: checkbox; }',
      '.zapi-up-oid { font-weight: 600; font-family: monospace; }',
      '.zapi-up-meta { color: #555; font-size: 12px; }',
      '.zapi-up-doukon { background: #1F3864; color: #fff; border-radius: 8px; padding: 1px 7px; font-size: 11px; }',
      '.zapi-up-empty { padding: 24px 12px; text-align: center; color: #666; font-size: 13px; }',
      '.zapi-up-verify { background: #fff8e1; border-radius: 8px; padding: 10px; margin-bottom: 10px; font-size: 13px; }',
      '.zapi-up-verify input { width: 70px; font-size: 15px; padding: 6px; border: 1px solid #ccc; border-radius: 6px; margin-left: 6px; }',
      '.zapi-actions { display: flex; gap: 10px; justify-content: flex-end; }',
      '.zapi-sec { background: #e8e8e8; border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; cursor: pointer; }'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ============================================================
  // eBay追跡番号 一括登録 (差出後・C方式)
  //   「📤 eBay登録」→ API発行済み・eBay未登録の小包一覧 →
  //   窓口で受け取った受領証枚数を入力 → 件数照合 → 一括登録
  // ============================================================

  const UPLOAD_MODAL_ID = 'zapi-upload-modal';

  async function openUploadModal() {
    closeUploadModal();
    injectStyles();
    let targets;
    try {
      if (typeof showToast === 'function') showToast('対象を取得中...');
      const r = await API._get('?action=zonosGetUploadTargets');
      if (r.error) throw new Error(r.error);
      targets = r.targets || [];
    } catch (e) {
      if (typeof showToast === 'function') showToast('取得失敗: ' + (e.message || e));
      return;
    }

    const wrap = document.createElement('div');
    wrap.id = UPLOAD_MODAL_ID;
    wrap.className = 'zapi-overlay';
    let rows = '';
    if (targets.length === 0) {
      rows = '<div class="zapi-up-empty">対象がありません<br>' +
        '<span class="zapi-note">条件: APIでラベル発行済み・eBay未登録の小包</span></div>';
    } else {
      rows = targets.map((t, i) =>
        '<label class="zapi-up-row">' +
          '<input type="checkbox" data-idx="' + i + '"' + (t.shipDate ? ' checked' : '') + '>' +
          '<span class="zapi-up-oid">' + escapeHtml(t.orderId) + '</span>' +
          (t.doukonCount > 1 ? '<span class="zapi-up-doukon">' + t.doukonCount + '点同梱</span>' : '') +
          '<span class="zapi-up-meta">' + escapeHtml(t.tracking) +
            (t.shipDate ? ' / 発送日 ' + escapeHtml(t.shipDate) : '') + '</span>' +
        '</label>'
      ).join('');
    }
    wrap.innerHTML =
      '<div class="zapi-panel">' +
        '<div class="zapi-title">📤 eBayへ追跡番号を一括登録</div>' +
        '<div class="zapi-note">窓口で差し出した小包にチェック（同梱はグループ内の全注文へ登録されます）</div>' +
        '<div class="zapi-up-list">' + rows + '</div>' +
        (targets.length ? (
          '<div class="zapi-up-verify">' +
            '<label>窓口で受け取った受領証（ご依頼主様控）の枚数: ' +
            '<input type="number" id="zapi-receipt-count" min="0" placeholder="枚数"></label>' +
            '<div class="zapi-note">選択した小包数と一致しないと登録できません（取り違え・出し忘れの検知）</div>' +
          '</div>') : '') +
        '<div class="zapi-actions">' +
          '<button class="zapi-sec" id="zapi-up-cancel">閉じる</button>' +
          (targets.length ? '<button class="zapi-btn" id="zapi-up-exec">eBayへ登録</button>' : '') +
        '</div>' +
        '<div id="zapi-up-result"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.getElementById('zapi-up-cancel').onclick = closeUploadModal;
    wrap.onclick = (e) => { if (e.target === wrap) closeUploadModal(); };

    const execBtn = document.getElementById('zapi-up-exec');
    if (execBtn) execBtn.onclick = async () => {
      const checked = [];
      wrap.querySelectorAll('.zapi-up-list input[type=checkbox]:checked')
        .forEach(cb => checked.push(targets[parseInt(cb.dataset.idx, 10)]));
      const resultEl = document.getElementById('zapi-up-result');
      if (checked.length === 0) { resultEl.innerHTML = '<div class="zapi-error">小包が選択されていません</div>'; return; }
      const receiptCount = parseInt((document.getElementById('zapi-receipt-count') || {}).value, 10);
      if (!(receiptCount >= 0)) {
        resultEl.innerHTML = '<div class="zapi-error">受領証の枚数を入力してください</div>';
        return;
      }
      if (receiptCount !== checked.length) {
        resultEl.innerHTML = '<div class="zapi-error">⚠ 枚数不一致: 受領証 ' + receiptCount +
          '枚 / 選択 ' + checked.length + '個<br>差し出した小包と選択が合っているか確認してください' +
          '（出し忘れ・チェック漏れの可能性）</div>';
        return;
      }
      execBtn.disabled = true;
      execBtn.textContent = '登録中...';
      try {
        const r = await API._post({
          action: 'zonosUploadShipped',
          secret: API.config.secret,
          orderIds: checked.map(t => t.orderId)
        });
        if (r.error) throw new Error(r.error);
        let html = '<div class="zapi-success">✅ 登録完了: ' + r.uploaded + '件' +
          (r.skipped ? ' (既登録スキップ ' + r.skipped + ')' : '') + '</div>';
        if (r.failed && r.failed.length) {
          html += '<div class="zapi-error">❌ 失敗 ' + r.failed.length + '件:<br>' +
            r.failed.map(f => escapeHtml(f.orderId) + ': ' + escapeHtml(f.error)).join('<br>') + '</div>';
        }
        resultEl.innerHTML = html;
        if (typeof showToast === 'function') showToast('eBay登録: ' + r.uploaded + '件完了');
        if (window.App && typeof App.loadAll === 'function') App.loadAll();
        if (!(r.failed && r.failed.length)) setTimeout(closeUploadModal, 2500);
      } catch (e) {
        resultEl.innerHTML = '<div class="zapi-error">❌ ' + escapeHtml(e.message || String(e)) + '</div>';
        execBtn.disabled = false;
        execBtn.textContent = 'eBayへ登録';
      }
    };
  }

  function closeUploadModal() {
    const el = document.getElementById(UPLOAD_MODAL_ID);
    if (el) el.remove();
  }

  // ============================================================
  // フック: Zonos.Screen._render の後にセクション注入
  // ============================================================

  function init() {
    const btn = document.getElementById('btn-ebay-upload');
    if (btn) btn.onclick = openUploadModal;
    if (!(window.Zonos && Zonos.Screen && typeof Zonos.Screen._render === 'function')) {
      console.warn('ZonosApi: Zonos.Screen が見つかりません (zonos.js より後に読み込むこと)');
      return;
    }
    const orig = Zonos.Screen._render.bind(Zonos.Screen);
    Zonos.Screen._render = function () {
      orig();
      try { injectSection(); } catch (e) { console.error('ZonosApi inject error:', e); }
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.ZonosApi = { injectSection, stampDateOnLabel, _issueLabel: issueLabel };
})();
