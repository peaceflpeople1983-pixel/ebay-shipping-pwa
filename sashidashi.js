/**
 * sashidashi.js — 料金後納郵便物差出票 出力機能 (PWAクライアント新規ファイル / v1.0)
 *
 * 背景:
 *   料金後納の承認取得(2026-09-16)に伴い、後納で差し出す際は
 *   「料金後納郵便物差出票」の窓口提出が毎回必要になった。
 *   本モジュールは確定済み(ePacketライト=国際エアパケット)・未発送の注文を
 *   重量帯×料金でグループ化し、郵送された正式様式を再現したA4帳票を
 *   ブラウザ印刷(PDF保存可)で出力する。
 *
 * 使い方:
 *   一覧画面ツールバーの「📮 差出票」ボタン → 対象注文をチェックで調整 → 「差出票を出力」
 *   → 新しいウィンドウに様式が開くので印刷 (Ctrl+P / PDFに保存)
 *
 * 既存ファイルとの関係:
 *   - App / Calculator / showToast に読み取りでのみ依存 (書込みなし)
 *   - app.js へのパッチ不要 (ボタンbindは本ファイル内で行う)
 *   - index.html へは ボタン1個 + script タグ1行 を追加 (SASHIDASHI_DEPLOY_GUIDE.md 参照)
 *
 * グローバル: window.Sashidashi
 */

(function() {
  'use strict';

  // ============================================================
  // 定数 (郵送された様式の記載内容。変更時はここだけ直す)
  // ============================================================

  const SENDER = {
    address: '島田市高島町11-43-16',
    name: '平原　優',
    // 様式に印字されている後納承認番号 (ハイフン区切り表記)
    approvalNo: '2001225310-000001-0000000001-000001'
  };

  // 様式のQRコード再現 (原本PDFから解読した内容と同一ペイロード・Shift_JIS。
  // 内容: CCH:01;CID:20012253100000010000000001000001;CN1:平原 優;CN2:;CPN:0000000;CAR:;CPD:20260911;
  // 固定値のため静的画像として埋め込む)
  const QR_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAEsAQAAAABRBrPYAAADJUlEQVR4nO1aMXLjMAxc0DcjXUV1Kekf5Al+mqj7mZ/gH4hlOqk6qbBws5DtXFwpM7qzJRkFhwkxGQEEFgswopggrZuiBbzU7uTlkDt5OWRhDklCiehlX0ne7m+H14PnN2GqWqmqNcTrMQ5AipIjCfricrAEE2ZWEykAbcVuPURpC5SfB4swYS61H3/ts+a9Rvt2iuefH++1+i5996+5ZVgq8A3UfxT49fvtJENfnB77be5xaqoNMACodh2Cnn06qPB3drAIE2ZVq0Rkj12HpOjDMe7acIyuLy4HSzBhguhNhqwBRJsQpfMatfO3o2ZjlCC6vkgRfVAdWB6BVlRyOx4ZwrObMLfakDVBXNaQNPi6OudeBVnaV5ovxYTpakm1uxJBsfyHrwGLiUd/2/9WC6I5gnBbjV5hJLBMQDt65flNmF+tFT1LIJVmeZQi6a67IsSjv22+ulAz+INqhxAHeI28epaJoPxxW3UBo0NU63IwNMi0HjNAuFyq5eYcAkYDPVByF8dYyVRtWZFDQhwI/0OWDmRGNRz8UckGebyxugBePfvkoJYQIHMkLkQDB4uJ9Vz9t8ABN87MXMDoGkq5IoeUdvXjiCy34PdKSsD83yIlCKIcFRoVFg6THBkC+8U1UQI3XS0ZQbCZKqwunHPYMg4YHvptc2e9aoPyCxFgBvjrwXqyfoIocc/g3xBC9UIJ1CgBsXBbDnG2DpwecVOJhKM6BseuLZgLTJIlmDBRbafpIMgadsztQYB2X6lP+3JEgiWYMC8MntkbsjKKNQ0DSaOBg2izMdLorFBaNeAkhR3z+OoiA1oWz1Uxh6SOWe84LFGvR0WWSAnYL/RF2NbV43PITKp43YFu8KpYV6s4NULEnpcZ/NEeFKTzR+W4kc+QqwKH8vq8TDEYbA+RY8XI4rAIE2Z+fBT4E0cIpz3zoIrmFdcK/aPPboL7V2oDF+uYtGvFwFNXxBxwGZtwWIaRHpvNHKABpY1SNgeDuLw7Zw0qISSwS6jUs2kUOawJBieIXoGytPmyDVbZUZZ8iC8tTNYRIfL6t8zlXJZ7qX2Vl0PuZF6H/AGyABPOuvPjFQAAAABJRU5ErkJggg==';

  // 対象とする発送方法 (calculator.js の carrier 名と一致させる)
  const TARGET_CARRIER = 'ePacketライト';

  // 1ページの明細行数 (原本様式は12行 + 合計行)
  const ROWS_PER_PAGE = 12;

  // ============================================================
  // ヘルパー
  // ============================================================

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function yen(n) {
    return Number(n).toLocaleString('ja-JP');
  }

  /** order.weightG (実体はkg/gが混在) → g に正規化。app.js v3.12 と同じ救済ロジック */
  function weightToG(wRaw) {
    if (typeof wRaw !== 'number' || wRaw <= 0) return null;
    return (wRaw < 10) ? Math.round(wRaw * 1000) : Math.round(wRaw);
  }

  /** 100g切上げの量目 (料金表の行キーと同じ) */
  function w100Of(g) {
    return Math.ceil(g / 100) * 100;
  }

  /** 国コード → ePacket地帯番号 (マスタ国データから)。不明は null */
  function zoneOf(countryCode) {
    try {
      const list = (window.App && App.state.masterData && App.state.masterData.countries) || [];
      const c = list.find(x => x.code === countryCode);
      return (c && c.epacketZone) ? c.epacketZone : null;
    } catch (e) { return null; }
  }

  // ============================================================
  // 対象注文の収集
  // ============================================================

  /**
   * 差出票の候補注文を返す。
   * 条件: 発送方法確定済み(ePacketライト) / 未FULFILLED / キャンセルでない / 同梱の子でない
   * (同梱は lead 1件 = 物理1個として数える。lead の重量・料金が小包全体の値)
   * v1.2: 「追跡番号なし」条件を撤廃 — Zonos APIラベル発行では差出し前に追跡番号が付くため。
   *       eBayへ追跡登録(FULFILLED)された時点で差出済みとみなして除外する
   */
  function collectCandidates() {
    const orders = (window.App && Array.isArray(App.state.orders)) ? App.state.orders : [];
    return orders.filter(o =>
      o &&
      o.selectedCarrier === TARGET_CARRIER &&
      o.fulfillmentStatus !== 'FULFILLED' &&
      !o.cancelledAt &&
      o.doukonRole !== 'sub'
    );
  }

  /** 注文1件 → 明細計算用の行データ */
  function toItem(o) {
    const g = weightToG(o.weightG);
    const cost = (typeof o.shippingCost === 'number') ? o.shippingCost
               : (o.shippingCost ? parseInt(String(o.shippingCost).replace(/[^\d]/g, ''), 10) : null);
    return {
      orderId: o.orderId,
      country: o.country || '',
      doukonCount: (o.doukonRole === 'lead' && o.doukonCount > 1) ? o.doukonCount : 1,
      weightG: g,
      w100: g ? w100Of(g) : null,
      zone: zoneOf(o.country),
      cost: (cost && cost > 0) ? cost : null,
      shipDate: String(o.zonosShipDate || ''),  // API発行時の発送日 (日付指定フィルタ用 v1.3)
      printed: !!o.sashidashiPrintedAt,         // 差出票印刷済み (追加分のみ発行用 v1.4)
      ok: !!(g && cost && cost > 0)
    };
  }

  /** チェック済みitem群 → (地帯, 量目, 料金) でグループ化した明細行 */
  function groupItems(items) {
    const map = new Map();
    for (const it of items) {
      const key = (it.zone || '?') + '|' + it.w100 + '|' + it.cost;
      if (!map.has(key)) {
        map.set(key, { zone: it.zone, w100: it.w100, cost: it.cost, count: 0 });
      }
      map.get(key).count++;
    }
    return Array.from(map.values())
      .sort((a, b) => (a.zone || 0) - (b.zone || 0) || a.w100 - b.w100)
      .map(r => Object.assign(r, { total: r.cost * r.count }));
  }

  // ============================================================
  // 選択モーダル
  // ============================================================

  const MODAL_ID = 'sashidashi-modal';

  function openModal() {
    closeModal();
    const cands = collectCandidates().map(toItem);
    const wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    wrap.className = 'sashidashi-overlay';

    let rows = '';
    if (cands.length === 0) {
      rows = '<div class="sashidashi-empty">対象がありません<br><span class="muted">条件: 発送方法が「' + esc(TARGET_CARRIER) + '」で確定済み・未発送の注文</span></div>';
    } else {
      rows = cands.map((it, i) => {
        const warn = it.ok ? '' :
          '<span class="sashidashi-warn">⚠ ' + (!it.weightG ? '重量未入力' : '料金なし') + '（出力対象外）</span>';
        const doukon = it.doukonCount > 1 ? ' <span class="sashidashi-doukon">' + it.doukonCount + '点同梱</span>' : '';
        const printedBadge = it.printed ? ' <span class="sashidashi-printed">票印刷済</span>' : '';
        return '<label class="sashidashi-row' + (it.ok ? '' : ' ng') + '">' +
          '<input type="checkbox" data-idx="' + i + '" data-shipdate="' + esc(it.shipDate) + '" data-printed="' + (it.printed ? '1' : '') + '"' + (it.ok ? '' : ' disabled') + '>' +
          '<span class="sashidashi-oid">' + esc(it.orderId) + '</span>' + doukon + printedBadge +
          '<span class="sashidashi-meta">' + esc(it.country) + ' / ' +
            (it.weightG ? it.weightG + 'g → ' + it.w100 + 'gまで' : '重量?') + ' / ' +
            (it.cost ? '¥' + yen(it.cost) : '¥?') +
            (it.shipDate ? ' / 発送日 ' + esc(it.shipDate) : '') + '</span>' +
          warn +
        '</label>';
      }).join('');
    }

    const kindOptions = Object.keys(KINDS)
      .map(k => '<option value="' + k + '">' + KINDS[k].label + '</option>').join('');

    const todayStr = (() => { const d = new Date(); const p2 = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); })();

    wrap.innerHTML =
      '<div class="sashidashi-panel">' +
        '<div class="sashidashi-title">📮 料金後納郵便物差出票の出力</div>' +
        '<div class="sashidashi-date-row">差出日: <input type="date" id="sashidashi-date" value="' + todayStr + '">' +
          '<span class="sashidashi-sub">発送日が一致する小包を自動選択（発送日なしは差出日=今日のとき選択）</span></div>' +
        '<div class="sashidashi-sub">窓口へ差し出す小包にチェック（同梱グループは1個として数えます）</div>' +
        '<div class="sashidashi-list">' + rows + '</div>' +
        '<div class="sashidashi-manual-title">その他の郵便物（Hirogete分など・後納でまとめて差し出すもの）</div>' +
        '<div id="sashidashi-manual-list"></div>' +
        '<button class="sashidashi-manual-add" id="sashidashi-manual-add">＋ 行を追加</button>' +
        '<div class="sashidashi-summary" id="sashidashi-summary"></div>' +
        '<div class="sashidashi-actions">' +
          '<button class="secondary" id="sashidashi-cancel">閉じる</button>' +
          '<button class="primary" id="sashidashi-print">差出票を出力</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wrap);
    injectStyles();

    // ── その他の郵便物 (手入力行) ──
    const manualList = document.getElementById('sashidashi-manual-list');
    const addManualRow = () => {
      const div = document.createElement('div');
      div.className = 'sashidashi-manual-row';
      div.innerHTML =
        '<select class="m-kind" title="郵便物の種類">' + kindOptions + '</select>' +
        '<input class="m-zone" placeholder="地帯(任意)" title="地帯 例: 第2地帯">' +
        '<input class="m-w" type="number" min="1" placeholder="量目g" title="量目(gまで)">' +
        '<input class="m-n" type="number" min="1" value="1" placeholder="個数" title="個数">' +
        '<input class="m-p" type="number" min="1" placeholder="料金/個" title="一個の料金(円)">' +
        '<select class="m-note" title="摘要"><option value="goods">物品</option><option value="docs">書類</option></select>' +
        '<button class="m-del" title="行を削除">✕</button>';
      manualList.appendChild(div);
      div.querySelector('.m-del').onclick = () => { div.remove(); updateSummary(); };
      div.querySelectorAll('input,select').forEach(el => { el.onchange = updateSummary; el.oninput = updateSummary; });
    };
    document.getElementById('sashidashi-manual-add').onclick = addManualRow;

    /** 手入力行 → 帳票行 (量目・個数・料金が揃った行のみ) */
    const readManualRows = () => {
      const out = [];
      manualList.querySelectorAll('.sashidashi-manual-row').forEach(div => {
        const wG = parseInt(div.querySelector('.m-w').value, 10);
        const n = parseInt(div.querySelector('.m-n').value, 10);
        const p = parseInt(div.querySelector('.m-p').value, 10);
        if (!(wG > 0 && n > 0 && p > 0)) return;
        out.push({
          kindKey: div.querySelector('.m-kind').value,
          zoneLabel: div.querySelector('.m-zone').value.trim(),
          wLabel: wG, count: n, cost: p, total: p * n,
          note: div.querySelector('.m-note').value
        });
      });
      return out;
    };

    /** 自動集計 (エアパケット) + 手入力行 → 帳票行リスト */
    const buildRows = () => {
      const auto = groupItems(getCheckedItems(cands)).map(g => ({
        kindKey: 'airpacket',
        zoneLabel: g.zone ? '第' + g.zone + '地帯' : '',
        wLabel: g.w100, count: g.count, cost: g.cost, total: g.total,
        note: 'goods'
      }));
      return auto.concat(readManualRows());
    };

    const updateSummary = () => {
      const rows2 = buildRows();
      const totalCount = rows2.reduce((s, r) => s + r.count, 0);
      const totalYen = rows2.reduce((s, r) => s + r.total, 0);
      document.getElementById('sashidashi-summary').textContent =
        rows2.length === 0 ? '' :
        '合計 ' + totalCount + '個 / ' + rows2.length + '行 / ¥' + yen(totalYen);
    };
    // 差出日に応じてチェックを付け直す (発送日一致 or 発送日なし×今日)
    const applyDateSelection = () => {
      const sel = (document.getElementById('sashidashi-date') || {}).value || todayStr;
      wrap.querySelectorAll('.sashidashi-list input[type=checkbox]').forEach(cb => {
        if (cb.disabled) return;
        const sd = cb.dataset.shipdate || '';
        const dateMatch = sd ? (sd === sel) : (sel === todayStr);
        cb.checked = dateMatch && !cb.dataset.printed; // 印刷済みは追加分から除外(手動で再チェック可)
      });
      updateSummary();
    };
    wrap.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = updateSummary);
    const dateEl = document.getElementById('sashidashi-date');
    if (dateEl) dateEl.onchange = applyDateSelection;
    applyDateSelection();

    document.getElementById('sashidashi-cancel').onclick = closeModal;
    document.getElementById('sashidashi-print').onclick = () => {
      const rows2 = buildRows();
      if (rows2.length === 0) {
        if (typeof showToast === 'function') showToast('出力対象がありません（チェックまたは行の追加をしてください）');
        return;
      }
      // 差出票印刷済みマークを記録 (v1.4: 追加分のみ発行のため。失敗しても出力は続行)
      try {
        const ids = getCheckedItems(cands).map(it => it.orderId);
        if (ids.length && window.API && API._post) {
          API._post({ action: 'zonosMarkSashidashiPrinted', secret: API.config.secret, orderIds: ids })
            .then(r => { if (r && r.success && window.App && App.loadAll) App.loadAll(); })
            .catch(e => console.warn('差出票印刷済みマーク失敗:', e));
        }
      } catch (e) { console.warn('差出票印刷済みマーク失敗:', e); }
      openPrintWindow(rows2);
    };
    wrap.onclick = (e) => { if (e.target === wrap) closeModal(); };
  }

  function getCheckedItems(cands) {
    const out = [];
    document.querySelectorAll('#' + MODAL_ID + ' input[type=checkbox]:checked').forEach(cb => {
      const it = cands[parseInt(cb.dataset.idx, 10)];
      if (it && it.ok) out.push(it);
    });
    return out;
  }

  function closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
  }

  // ============================================================
  // 帳票HTML (原本様式の再現)
  // ============================================================

  /**
   * 郵便物の種類 (差出票の○印セット)。
   * v1.1: Hirogete分等を同じ差出票に載せるため種別を追加 (窓口精算→後納一本化・2026-09-17)
   */
  const KINDS = {
    airpacket:         { label: '国際エアパケット',                maru: ['epacket', 'air'] },
    kokusai_air:       { label: '国際郵便（印刷物・小形包装物）・航空', maru: ['yubin', 'air'] },
    ems:               { label: 'ＥＭＳ',                          maru: ['ems'] },
    kozutsumi_air:     { label: '国際小包・航空',                  maru: ['kozutsumi', 'air'] },
    kozutsumi_sal:     { label: '国際小包・ＳＡＬ',                maru: ['kozutsumi', 'sal'] },
    kozutsumi_surface: { label: '国際小包・船便',                  maru: ['kozutsumi', 'fune'] }
  };

  /** 郵便物の種類セル: 原本の選択肢を印字し、種別に応じた項目を○で囲む (kindKey=null は空行用) */
  function kindCellHtml(kindKey) {
    const m = (kindKey && KINDS[kindKey]) ? KINDS[kindKey].maru : [];
    const w = (token, text) => m.indexOf(token) !== -1 ? '<span class="maru">' + text + '</span>' : text;
    return '<div class="kind">' + w('ems', 'ＥＭＳ') + '　' + w('yubin', '国際郵便') + '<br>' +
      w('kozutsumi', '国際小包') + '　' + w('epacket', '国際eパケット') + '<br>' +
      '（' + w('air', '航空') + '　' + w('sal', 'ＳＡＬ') + '　' + w('fune', '船便') + '）</div>';
  }

  function tokushuCellHtml() {
    return '<div class="kind">速　達・書　留<br>保険付（　　　）</div>';
  }

  function pageHtml(groupRows, pageNo, pageTotal, grandTotal) {
    let body = '';
    for (let i = 0; i < ROWS_PER_PAGE; i++) {
      const r = groupRows[i];
      if (r) {
        body +=
          '<tr>' +
            '<td class="c-kind">' + kindCellHtml(r.kindKey) + '</td>' +
            '<td class="c-zone">' + esc(r.zoneLabel || '') + '</td>' +
            '<td class="c-tok">' + tokushuCellHtml() + '</td>' +
            '<td class="c-w"><b>' + yen(r.wLabel) + '</b> gまで</td>' +
            '<td class="c-n"><b>' + yen(r.count) + '</b></td>' +
            '<td class="c-price"><b>' + yen(r.cost) + '</b></td>' +
            '<td class="c-total"><b>' + yen(r.total) + '</b><span class="en">円</span></td>' +
            '<td class="c-note">' + (r.note === 'docs'
              ? '<span class="maru">書類</span><br>物品'
              : '書類<br><span class="maru">物品</span>') + '</td>' +
          '</tr>';
      } else if (i < 8) {
        body +=
          '<tr>' +
            '<td class="c-kind">' + kindCellHtml(null) + '</td>' +
            '<td class="c-zone"></td>' +
            '<td class="c-tok">' + tokushuCellHtml() + '</td>' +
            '<td class="c-w">gまで</td>' +
            '<td class="c-n"></td>' +
            '<td class="c-price"></td>' +
            '<td class="c-total"><span class="en">円</span></td>' +
            '<td class="c-note">書類<br>物品</td>' +
          '</tr>';
      } else {
        body +=
          '<tr class="short">' +
            '<td class="c-kind"></td><td class="c-zone"></td><td class="c-tok"></td>' +
            '<td class="c-w">gまで</td><td class="c-n"></td><td class="c-price"></td>' +
            '<td class="c-total"><span class="en">円</span></td><td class="c-note"></td>' +
          '</tr>';
      }
    }

    const isLast = pageNo === pageTotal;
    const pageSuffix = pageTotal > 1 ? '　（' + pageNo + '／' + pageTotal + '枚目）' : '';

    return '<div class="sheet">' +
      '<div class="title">料金後納郵便物差出票' + pageSuffix + '</div>' +
      '<div class="head">' +
        '<div class="stamp"><div class="stamp-label">日付印</div></div>' +
        '<div class="qr"><img src="' + QR_DATA_URI + '" alt="QR"></div>' +
        '<div class="sender">' +
          '<div class="sender-row"><span class="lbl">住　　　所</span>' + esc(SENDER.address) + '</div>' +
          '<div class="sender-row"><span class="lbl">差出人氏名</span>' + esc(SENDER.name) + '　<span class="inkan">印</span></div>' +
          '<div class="approval">' + esc(SENDER.approvalNo) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="decl">次のとおり、後納郵便物等を差し出します。<br>' +
        'なお、この郵便物等は、郵便法等の法令に違反した内容の郵便物等ではないことを確認します。</div>' +
      '<table>' +
        '<tr class="th">' +
          '<th class="c-kind">郵便物の種類</th><th class="c-zone">地帯</th>' +
          '<th class="c-tok">特殊取扱の種類</th><th class="c-w">量目別</th>' +
          '<th class="c-n">個　数</th><th class="c-price">一個の料金</th>' +
          '<th class="c-total">合 計 金 額</th><th class="c-note">摘要</th>' +
        '</tr>' +
        body +
        '<tr class="gokei">' +
          '<td colspan="6" class="gokei-lbl">合　　　　　　計</td>' +
          '<td class="c-total">' + (isLast ? '<b>' + yen(grandTotal) + '</b>' : '') + '<span class="en">円</span></td>' +
          '<td class="c-note"></td>' +
        '</tr>' +
      '</table>' +
      '<div class="foot">「郵便物の種類」「特殊取扱の種類」「摘要」欄は該当するものを○印で囲む</div>' +
    '</div>';
  }

  /**
   * 帳票ビューを開く (同一ページ内オーバーレイ + window.print)。
   * window.open はPWA・ポップアップブロック環境で失敗するため使わない
   * (既存のピックアップシート印刷 #screen-print と同じ方式)。
   */
  const PRINT_ROOT_ID = 'sashidashi-print-root';

  function openPrintWindow(groupRows) {
    closePrintView();
    const grandTotal = groupRows.reduce((s, r) => s + r.total, 0);
    const pageTotal = Math.max(1, Math.ceil(groupRows.length / ROWS_PER_PAGE));
    let sheets = '';
    for (let p = 0; p < pageTotal; p++) {
      sheets += pageHtml(groupRows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE), p + 1, pageTotal, grandTotal);
    }

    const root = document.createElement('div');
    root.id = PRINT_ROOT_ID;
    root.innerHTML =
      '<div class="toolbar noprint">' +
        '<button id="sashidashi-do-print">🖨 印刷 / PDFに保存</button>' +
        '<button id="sashidashi-close-print">✕ 閉じる</button>' +
        '<span class="hint">A4縦・余白「なし」または「既定」を推奨</span>' +
      '</div>' +
      sheets;
    document.body.appendChild(root);
    document.body.classList.add('sashidashi-printing');
    injectPrintStyles();
    root.querySelector('#sashidashi-do-print').onclick = () => window.print();
    root.querySelector('#sashidashi-close-print').onclick = closePrintView;
    closeModal();
  }

  function closePrintView() {
    const el = document.getElementById(PRINT_ROOT_ID);
    if (el) el.remove();
    document.body.classList.remove('sashidashi-printing');
  }

  function injectPrintStyles() {
    if (document.getElementById('sashidashi-print-styles')) return;
    const st = document.createElement('style');
    st.id = 'sashidashi-print-styles';
    st.textContent = PRINT_CSS;
    document.head.appendChild(st);
  }

  // 帳票用CSS — 原本様式の寸法感を再現 (#sashidashi-print-root 配下にスコープ)
  const R = '#' + PRINT_ROOT_ID + ' ';
  const PRINT_CSS = [
    '#' + PRINT_ROOT_ID + ' { position: fixed; inset: 0; z-index: 4000; overflow: auto; background: #f0f0f0; ' +
      'font-family: "MS Mincho","Yu Mincho",serif; color: #000; -webkit-text-size-adjust: none; }',
    R + '*, ' + R + '*::before, ' + R + '*::after { box-sizing: border-box; margin: 0; padding: 0; }',
    R + '.toolbar { position: sticky; top: 0; z-index: 1; padding: 10px; background: #1F3864; display: flex; align-items: center; gap: 12px; }',
    R + '.toolbar button { font-size: 15px; padding: 8px 18px; cursor: pointer; border: none; border-radius: 6px; }',
    R + '.toolbar .hint { color: #cdd6ea; font-size: 12px; font-family: sans-serif; }',
    R + '.sheet { width: 210mm; min-height: 296mm; margin: 8px auto; background: #fff; padding: 14mm 12mm; page-break-after: always; }',
    R + '.sheet:last-child { page-break-after: auto; }',
    R + '.title { text-align: center; font-size: 22px; letter-spacing: 6px; margin-bottom: 6mm; }',
    R + '.head { display: flex; align-items: flex-start; gap: 6mm; margin-bottom: 3mm; }',
    R + '.stamp { width: 34mm; height: 22mm; border: 1.2px solid #000; position: relative; }',
    R + '.stamp-label { position: absolute; top: -3.5mm; left: 2mm; background: #fff; padding: 0 1mm; font-size: 10px; }',
    R + '.qr img { width: 22mm; height: 22mm; image-rendering: pixelated; }',
    R + '.sender { font-size: 14px; line-height: 1.9; }',
    R + '.sender-row .lbl { display: inline-block; width: 30mm; letter-spacing: 2px; }',
    R + '.inkan { display: inline-block; width: 5.5mm; height: 5.5mm; line-height: 5.5mm; text-align: center; border: 1px solid #000; border-radius: 50%; font-size: 9px; vertical-align: middle; }',
    R + '.approval { font-size: 13px; letter-spacing: 1px; margin-top: 1mm; }',
    R + '.decl { font-size: 11px; line-height: 1.5; margin-bottom: 1.5mm; }',
    R + 'table { width: 100%; border-collapse: collapse; table-layout: fixed; }',
    R + 'th, ' + R + 'td { border: 1px solid #000; font-size: 11px; padding: 1mm; vertical-align: top; }',
    R + 'tr.th th { text-align: center; font-weight: normal; padding: 1.5mm 0.5mm; vertical-align: middle; }',
    R + 'td.c-zone { white-space: nowrap; font-size: 10px; text-align: center; vertical-align: middle; }',
    R + '.c-kind { width: 21%; } ' + R + '.c-zone { width: 7%; } ' + R + '.c-tok { width: 15%; } ' + R + '.c-w { width: 12%; }',
    R + '.c-n { width: 10%; } ' + R + '.c-price { width: 11%; } ' + R + '.c-total { width: 16%; } ' + R + '.c-note { width: 8%; }',
    R + 'td.c-kind .kind, ' + R + 'td.c-tok .kind { line-height: 2.1; font-size: 10px; }',
    R + 'td.c-w, ' + R + 'td.c-n, ' + R + 'td.c-price, ' + R + 'td.c-total { text-align: right; position: relative; }',
    R + 'td.c-w { text-align: left; }',
    R + 'td.c-w { white-space: nowrap; } ' + R + 'td.c-w b { font-size: 13px; }',
    R + 'td.c-n b, ' + R + 'td.c-price b, ' + R + 'td.c-total b { font-size: 15px; }',
    R + 'td.c-n, ' + R + 'td.c-price { vertical-align: middle; text-align: center; }',
    R + 'td.c-total { vertical-align: middle; padding-right: 8mm; }',
    R + 'td.c-total .en { position: absolute; right: 1mm; bottom: 1mm; font-size: 10px; }',
    R + 'td.c-note { text-align: center; line-height: 1.9; }',
    R + 'tr:not(.th):not(.gokei):not(.short) td { height: 19mm; }',
    R + 'tr.short td { height: 9mm; }',
    R + '.maru { display: inline-block; border: 1.3px solid #000; border-radius: 50%; padding: 0 1.2mm; }',
    R + 'tr.gokei td { height: 13mm; }',
    R + '.gokei-lbl { text-align: center; font-size: 18px; letter-spacing: 12px; vertical-align: middle; }',
    R + '.foot { font-size: 10px; margin-top: 1mm; }',
    '@page { size: A4 portrait; margin: 0; }',
    '@media print {',
    // 帳票以外 (アプリ本体・トースト等 body直下の兄弟) をすべて隠す。
    // style.css の #screen-print { display:block !important } より親を消すので確実に勝つ
    '  body.sashidashi-printing > *:not(#' + PRINT_ROOT_ID + ') { display: none !important; }',
    '  body.sashidashi-printing { background: #fff !important; margin: 0 !important; padding: 0 !important; }',
    // fixed のままだと印刷で全ページに重なるブラウザがあるため static に戻す
    '  #' + PRINT_ROOT_ID + ' { position: static; overflow: visible; background: #fff; }',
    '  ' + R + '.noprint { display: none !important; }',
    '  ' + R + '.sheet { margin: 0; }',
    '}'
  ].join('\n');

  // ============================================================
  // モーダル用CSS (アプリ画面側)
  // ============================================================

  function injectStyles() {
    if (document.getElementById('sashidashi-styles')) return;
    const st = document.createElement('style');
    st.id = 'sashidashi-styles';
    st.textContent = [
      '.sashidashi-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 16px; }',
      '.sashidashi-panel { background: #fff; border-radius: 12px; max-width: 560px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; padding: 16px; }',
      '.sashidashi-title { font-size: 17px; font-weight: 700; margin-bottom: 4px; }',
      '.sashidashi-sub { font-size: 12px; color: #666; margin-bottom: 10px; }',
      '.sashidashi-date-row { display: flex; align-items: center; gap: 8px; margin: 6px 0 8px; font-size: 13px; flex-wrap: wrap; }',
      '.sashidashi-date-row input[type=date] { font-size: 14px; padding: 6px; border: 1px solid #ccc; border-radius: 6px; width: auto !important; }',
      '.sashidashi-list { overflow-y: auto; flex: 1; border: 1px solid #e0e0e0; border-radius: 8px; padding: 4px; min-height: 60px; }',
      '.sashidashi-row { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid #f0f0f0; font-size: 13px; flex-wrap: wrap; }',
      '.sashidashi-row.ng { opacity: 0.55; }',
      '.sashidashi-oid { font-weight: 600; font-family: monospace; }',
      '.sashidashi-meta { color: #555; }',
      '.sashidashi-doukon { background: #1F3864; color: #fff; border-radius: 8px; padding: 1px 7px; font-size: 11px; }',
      '.sashidashi-printed { background: #757575; color: #fff; border-radius: 8px; padding: 1px 7px; font-size: 11px; }',
      '.sashidashi-warn { color: #c62828; font-size: 11px; width: 100%; padding-left: 26px; }',
      '.sashidashi-empty { padding: 24px 12px; text-align: center; color: #666; font-size: 13px; }',
      '.sashidashi-manual-title { font-size: 12px; font-weight: 600; color: #444; margin: 12px 0 6px; }',
      '.sashidashi-manual-row { display: flex; gap: 4px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }',
      '.sashidashi-manual-row select, .sashidashi-manual-row input { font-size: 12px; padding: 6px 4px; border: 1px solid #ccc; border-radius: 6px; }',
      '.sashidashi-manual-row .m-kind { flex: 2 1 130px; min-width: 0; }',
      '.sashidashi-manual-row .m-zone { flex: 1 1 64px; width: 64px; min-width: 0; }',
      '.sashidashi-manual-row .m-w { width: 64px; }',
      '.sashidashi-manual-row .m-n { width: 48px; }',
      '.sashidashi-manual-row .m-p { width: 68px; }',
      '.sashidashi-manual-row .m-del { border: none; background: #fbe9e7; color: #c62828; border-radius: 6px; padding: 6px 8px; cursor: pointer; }',
      '.sashidashi-manual-add { border: 1px dashed #1F3864; background: #fff; color: #1F3864; border-radius: 8px; padding: 7px 14px; font-size: 12px; cursor: pointer; }',
      '.sashidashi-summary { font-size: 14px; font-weight: 600; text-align: right; padding: 10px 2px 2px; min-height: 22px; }',
      '.sashidashi-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 6px; }',
      '.sashidashi-actions button { padding: 10px 18px; border-radius: 8px; border: none; font-size: 14px; cursor: pointer; }',
      '.sashidashi-actions .primary { background: #1F3864; color: #fff; }',
      '.sashidashi-actions .primary:disabled { background: #9aa5bd; }',
      '.sashidashi-actions .secondary { background: #e8e8e8; }'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ============================================================
  // 初期化 (ボタンbind — app.js へのパッチ不要)
  // ============================================================

  function init() {
    const btn = document.getElementById('btn-sashidashi');
    if (btn) btn.onclick = openModal;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Sashidashi = { open: openModal, collectCandidates, groupItems, _print: openPrintWindow };
})();
