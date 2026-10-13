/* ============================================================
   免罪符診断 — 画面と判定

   設計上の要点
   ------------------------------------------------------------
   1. 主結果は「回答」だけで決まる。DB も API も要らない。
      → 1人目のユーザーでも完全な体験になる（コールドスタート無し）
   2. 共有 URL は回答そのものをハッシュに埋める（#/r/012345678）。
      → サーバが落ちても、DB を消しても、共有リンクは永久に生きる
        （PDMI はキー方式だったので、方式変更で過去のリンクが全部死んだ）
   3. 統計は「あれば嬉しい」レイヤー。API が無ければ静かに消える。
      → file:// で開いても診断は最後まで遊べる
   ============================================================ */

(function () {
  'use strict';

  var Q = window.QUESTIONS;
  var TYPES = window.TYPES;
  var EGG = window.EGG;
  var STATS = window.STATS;
  var CONFIG = window.CONFIG;
  var DISCLAIMER = window.DISCLAIMER;
  var MZ = window.MZ;

  var N = Q.length;          // 9
  var STORE = 'menzai-fu:v1';

  /* ============================================================
     ユーティリティ
     （判定・シャッフルは logic.js 側にある。テストと同じ実装を使うため）
     ============================================================ */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================================================
     状態
     ============================================================ */

  var state = {
    seed: null,
    order: null,          // order[qi][表示位置] = 論理 index
    answers: [],          // 論理 index
    positions: [],        // 表示位置
    cursor: 0,
    justSubmitted: false, // この結果表示で POST を打つか（GET と二重にしない）
    stats: null           // { totalSubmissions, count, optionCounts }
  };

  function resetQuiz() {
    state.seed = Math.random().toString(36).slice(2, 10);
    state.order = MZ.buildOrder(Q, state.seed);
    state.answers = [];
    state.positions = [];
    state.cursor = 0;
    state.justSubmitted = false;
    state.stats = null;
  }

  /* ============================================================
     API（無くても動く）
     ============================================================ */

  function answersToString(a) { return a.join(''); }

  /* バックエンドが「置かれていない」ことの合図。
     GitHub Pages のような静的ホスティングでは /api/* がこう返る：

         GET  /api/stats   → 404  text/html
         POST /api/submit  → 405  （content-type すら無い）

     ステータスコードだけを見ていると POST 側の 405 を取りこぼす
     （実際に公開して踏んだ）。なので「JSON かどうか」で判定する。
     Worker は必ず application/json を返すので、これで確実に分かれる。

     404/405 = そもそも無い → 画面には何も出さない
     JSON なのに失敗 = あるのに壊れている（D1 の無料枠切れなど）
                       → 1 行だけ知らせる（黙ると不具合に見えるため） */
  var apiAbsent = false;

  function handleApiResponse(r) {
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('application/json') === -1) {
      apiAbsent = true;
      return null;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function apiSubmit(answers) {
    if (!CONFIG.apiBase) return Promise.resolve(null);
    return fetch(CONFIG.apiBase + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answersToString(answers) })
    }).then(handleApiResponse).catch(function () { return null; });
  }

  function apiStats(answers) {
    if (!CONFIG.apiBase) return Promise.resolve(null);
    return fetch(CONFIG.apiBase + '/stats?answers=' + answersToString(answers))
      .then(handleApiResponse).catch(function () { return null; });
  }

  /* ============================================================
     ルーティング（ハッシュ）
       #/              スタート
       #/q             診断
       #/r/<9桁>       結果（共有用）
       #/e/<9桁>       手抜きページ（共有用）
     ============================================================ */

  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var m;

    if (h === '' || h === 'start') return renderStart();

    if (h === 'q') {
      if (!state.order) resetQuiz();
      return renderQuiz();
    }

    if ((m = h.match(/^r\/([0-3]{9})$/))) return renderResult(m[1].split('').map(Number));
    if ((m = h.match(/^e\/([0-3]{9})$/))) return renderEgg(m[1].split('').map(Number));

    return renderNotFound();
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ============================================================
     画面 1｜スタート
     ============================================================ */

  function renderStart() {
    document.body.dataset.screen = 'start';
    document.body.style.setProperty('--accent', '#FF4D8D');

    el('app').innerHTML =
      '<div class="screen screen--start">' +
        '<p class="kicker">' + N + '問・30秒</p>' +
        '<h1 class="hero-title">' + esc(CONFIG.title) + '</h1>' +
        '<p class="hero-sub">' + esc(CONFIG.subtitle) + '</p>' +
        '<div class="hero-card">' +
          '<p>答えに正解はありません。</p>' +
          '<p>ただ、あなたが普段ついてる<strong>言い訳</strong>は、全部見えます。</p>' +
        '</div>' +
        '<button class="btn btn--big" id="startBtn">診断をはじめる</button>' +
        '<p class="fineprint">' + esc(DISCLAIMER) + '</p>' +
      '</div>';

    el('startBtn').addEventListener('click', function () {
      resetQuiz();
      go('#/q');
    });
  }

  /* ============================================================
     画面 2｜診断
     ============================================================ */

  function renderQuiz() {
    document.body.dataset.screen = 'quiz';

    var qi = state.cursor;
    var q = Q[qi];
    var order = state.order[qi];
    var picked = state.positions[qi];

    var dots = '';
    for (var i = 0; i < N; i++) {
      var cls = 'dot';
      if (i < state.cursor) cls += ' dot--done';
      if (i === state.cursor) cls += ' dot--now';
      dots += '<span class="' + cls + '"></span>';
    }

    var opts = order.map(function (logicalIdx, pos) {
      var c = q.choices[logicalIdx];
      var on = picked === pos ? ' choice--on' : '';
      return '<button class="choice' + on + '" data-pos="' + pos + '">' +
               '<span class="choice__mark">' + 'ABCD'[pos] + '</span>' +
               '<span class="choice__text">' + esc(c.text) + '</span>' +
             '</button>';
    }).join('');

    el('app').innerHTML =
      '<div class="screen screen--quiz">' +
        '<div class="qhead">' +
          '<span class="qcount">Q' + (qi + 1) + '<span class="qcount__sep">/</span>' + N + '</span>' +
          '<div class="dots">' + dots + '</div>' +
        '</div>' +
        '<h2 class="qtext">' + esc(q.text) + '</h2>' +
        '<div class="choices">' + opts + '</div>' +
        '<div class="qfoot">' +
          (qi > 0 ? '<button class="btn btn--ghost" id="backBtn">戻る</button>' : '<span></span>') +
        '</div>' +
      '</div>';

    Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (b) {
      b.addEventListener('click', function () {
        var pos = Number(b.dataset.pos);
        state.positions[qi] = pos;
        state.answers[qi] = state.order[qi][pos];

        if (qi < N - 1) {
          state.cursor = qi + 1;
          setTimeout(renderQuiz, 120);
        } else {
          finish();
        }
      });
    });

    var back = el('backBtn');
    if (back) back.addEventListener('click', function () {
      state.cursor = Math.max(0, qi - 1);
      renderQuiz();
    });
  }

  function finish() {
    var str = answersToString(state.answers);

    // 手抜き（9 問すべて同じ「表示位置」）は集計に送らない。
    // 回答ではなく連打なので、統計に入れると数字が濁るだけ。
    if (MZ.isEgg(state.positions, N)) {
      go('#/e/' + str);
      return;
    }

    // 送信はここでは打たない。結果画面が「POST 1 回」だけを担当する。
    // ここで打つと route() 経由の GET と二重になり、
    // 先に返った GET が「まだ誰もいない」を表示してしまう。
    state.justSubmitted = true;
    go('#/r/' + str);
  }

  /* ============================================================
     画面 3｜結果
     ============================================================ */

  function renderResult(answers) {
    document.body.dataset.screen = 'result';

    var type = MZ.diagnose(Q, TYPES, answers);
    if (!type) return renderNotFound();

    document.body.style.setProperty('--accent', type.color);

    el('app').innerHTML =
      '<div class="screen screen--result">' +
        '<p class="kicker">あなたの免罪符は</p>' +
        '<h1 class="verdict" style="--c:' + type.color + '">' + esc(type.name) + '</h1>' +
        '<div class="verdict__rule"></div>' +
        '<div class="body-copy">' +
          type.lines.map(function (l) {
            // 太字にするのは「最後の行」ではなく hook（＝共有文に載る 1 行）。
            // 本文の並びは 補一刀 → 収尾断気 の 2 段になっている型があり、
            // 最後の行と一番刺さる行は一致しない。
            return '<p class="' + (l === type.hook ? 'punch' : '') + '">' + esc(l) + '</p>';
          }).join('') +
        '</div>' +
        '<div class="menzai">' +
          '<p class="menzai__label">免罪符</p>' +
          '<p class="menzai__text">「' + esc(type.menzai) + '」</p>' +
        '</div>' +
        '<div id="statsSlot" class="stats"></div>' +
        '<button class="btn btn--big" id="shareBtn">結果をコピーする</button>' +
        '<button class="btn btn--ghost" id="againBtn">もう一度やる</button>' +
        '<p class="fineprint">' + esc(DISCLAIMER) + '</p>' +
      '</div>';

    el('shareBtn').addEventListener('click', function () { share(type, answers); });
    el('againBtn').addEventListener('click', function () { resetQuiz(); go('#/q'); });

    loadStats(answers);
  }

  /* 集計の取り方は 3 通り。同時に 2 つ走らせない。
       ① sessionStorage に自分の結果がある → それを使う（0 リクエスト）
       ② 今まさに回答した → POST 1 回。戻り値でそのまま描く
       ③ 共有リンクから来た → GET 1 回（書き込みしない）
     ------------------------------------------------------------ */
  function loadStats(answers) {
    var str = answersToString(answers);

    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(STORE + ':' + str) || 'null'); } catch (e) {}

    if (cached) {
      state.stats = cached;
      paintStats(answers);
      return;
    }

    if (state.justSubmitted) {
      state.justSubmitted = false;
      apiSubmit(answers).then(function (s) {
        if (!s) return showStatsUnavailable();
        state.stats = s;
        try { sessionStorage.setItem(STORE + ':' + str, JSON.stringify(s)); } catch (e) {}
        paintStats(answers);
      });
      return;
    }

    apiStats(answers).then(function (s) {
      if (!s) return showStatsUnavailable();
      state.stats = s;
      paintStats(answers);
    });
  }

  /* 集計が出せなかったときの 1 行。
     出さない場合が 3 つある:
       ① バックエンドが置かれていない（404）… 静的ホスティングではこれが正常
       ② apiBase が空 … API を使わない設定
       ③ file:// … ローカルで開いているだけ。失敗が当然なので黙る */
  function showStatsUnavailable() {
    if (apiAbsent) return;
    if (!CONFIG.apiBase) return;
    if (location.protocol === 'file:') return;
    var slot = el('statsSlot');
    if (!slot) return;
    slot.innerHTML =
      '<p class="stat__note stat__note--muted">' + esc(STATS.unavailable) + '</p>';
  }

  function paintStats(answers) {
    var slot = el('statsSlot');
    if (!slot || !state.stats) return;

    var s = state.stats;
    var total = s.totalSubmissions || 0;
    var others = Math.max(0, (s.count || 0) - 1);

    var html = '';

    // ① 同じ回答をした人
    if (others === 0) {
      html += '<div class="stat stat--hero">' +
                '<p class="stat__main">' + esc(STATS.uniqueLabel) + '</p>' +
                '<p class="stat__note">' + esc(STATS.uniqueNote) + '</p>' +
              '</div>';
    } else {
      html += '<div class="stat">' +
                '<p class="stat__main">' + esc(STATS.dupLabel(others)) + '</p>' +
              '</div>';
    }

    // ② 累計
    if (total > 0) {
      html += '<div class="stat">' +
                '<p class="stat__num">' + esc(STATS.totalLabel(total)) + '</p>' +
                '<p class="stat__note">' + esc(STATS.totalNote) + '</p>' +
              '</div>';
    }

    // ③ 一番少数派な回答
    if (s.optionCounts && total > 0) {
      var worst = null;
      for (var q = 0; q < N; q++) {
        var row = s.optionCounts[q] || [];
        var n = row[answers[q]] || 0;
        var p = n / total;
        if (!worst || p < worst.p) worst = { q: q + 1, p: p };
      }
      if (worst) {
        var pct = (worst.p * 100);
        var shown = pct < 1 ? pct.toFixed(1) : Math.round(pct);
        html += '<div class="stat stat--minor">' +
                  '<p class="stat__note">' + esc(STATS.minorityLabel) + '</p>' +
                  '<p class="stat__main">' + esc(STATS.minorityNote(worst.q, shown)) + '</p>' +
                '</div>';
      }
    }

    slot.innerHTML = html;
  }

  /* ============================================================
     画面 4｜手抜きページ
     ============================================================ */

  function renderEgg(answers) {
    document.body.dataset.screen = 'egg';
    document.body.style.setProperty('--accent', EGG.color);

    var e = EGG.editable;

    // ここに統計は出さない。9 問連打した人の「同じ回答をした人」は
    // 数字として意味を持たないし、ページの主旨（手抜きを晒す）とも合わない。
    el('app').innerHTML =
      '<div class="screen screen--egg">' +
        '<p class="kicker">全問おなじ回答</p>' +
        '<h1 class="verdict verdict--egg" id="eggTitle">' + esc(e.title) + '</h1>' +
        '<div class="verdict__rule"></div>' +
        '<div class="body-copy">' +
          '<p id="eggBody">' + esc(e.body) + '</p>' +
          '<p id="eggMessage">' + esc(e.message) + '</p>' +
          EGG.lines.slice(2).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
        '</div>' +
        '<details class="editor">' +
          '<summary>罵り文句を自分で書き換えてみる</summary>' +
          '<div class="editor__box">' +
            '<label>見出し<input id="edTitle" type="text" maxlength="20"></label>' +
            '<label>本文<input id="edBody" type="text" maxlength="60"></label>' +
            '<label>メッセージ<input id="edMessage" type="text" maxlength="60"></label>' +
          '</div>' +
        '</details>' +
        '<button class="btn btn--big" id="shareBtn">結果をコピーする</button>' +
        '<button class="btn btn--ghost" id="againBtn">もう一度やる</button>' +
        '<p class="fineprint">' + esc(DISCLAIMER) + '</p>' +
      '</div>';

    var t = el('edTitle'), b = el('edBody'), m = el('edMessage');
    t.value = e.title; b.value = e.body; m.value = e.message;

    function sync() {
      el('eggTitle').textContent = t.value;
      el('eggBody').textContent = b.value;
      el('eggMessage').textContent = m.value;
    }
    [t, b, m].forEach(function (i) { i.addEventListener('input', sync); });

    el('shareBtn').addEventListener('click', function () {
      copyText(eggShareText(answers));
    });
    el('againBtn').addEventListener('click', function () { resetQuiz(); go('#/q'); });
  }

  /* ============================================================
     画面 5｜404
     ============================================================ */

  function renderNotFound() {
    document.body.dataset.screen = '404';
    el('app').innerHTML =
      '<div class="screen screen--404">' +
        '<h1 class="verdict verdict--egg">404</h1>' +
        '<div class="body-copy">' +
          '<p>このページは存在しない。</p>' +
          '<p>あなたの言い訳と同じくらい、見つからなかった。</p>' +
        '</div>' +
        '<button class="btn btn--big" id="homeBtn">トップに戻る</button>' +
      '</div>';
    el('homeBtn').addEventListener('click', function () { go('#/'); });
  }

  /* ============================================================
     共有
     ============================================================ */

  /* path は "#" を含まない（例: "/r/012345678"）。
     location.href から "#" より前を取るので、file:// でも https:// でも同じ 1 行で済む。 */
  function pageUrl(path) {
    return location.href.split('#')[0] + '#' + path;
  }

  /* X に貼る文面。文案集の型どおり：
       称号 → 免罪符 → 一番刺さる 1 行 → 数字 → # → URL

     「数字」は集計が取れたときだけ入る（無ければ 4 行で成立する）。
     数字を入れるのは、抽象的な形容より具体のほうが引用されやすいから。
     X の重み付き文字数（日本語 1 字 = 2）で 280 に収まる範囲に保つこと。 */
  function shareText(type, path) {
    var out = [
      '免罪符診断：〈' + type.name + '〉',
      '免罪符：「' + type.menzai + '」',
      type.hook
    ];

    var s = state.stats;
    if (s) {
      var others = Math.max(0, (s.count || 0) - 1);
      out.push(others === 0 ? STATS.uniqueLabel : STATS.dupLabel(others));
    }

    out.push('#免罪符診断');
    out.push(pageUrl(path));

    return out.join('\n');
  }

  // 彩蛋は「型」ではないので免罪符の行が無い。3 行で出す。
  function eggShareText(answers) {
    return [
      '免罪符診断：〈' + EGG.title + '〉',
      EGG.hook,
      '#免罪符診断',
      pageUrl('/e/' + answersToString(answers))
    ].join('\n');
  }

  function share(type, answers) {
    copyText(shareText(type, '/r/' + answersToString(answers)));
  }

  function copyText(text) {
    var done = function (ok) {
      var b = el('shareBtn');
      if (!b) return;
      var old = b.textContent;
      b.textContent = ok ? 'コピーしました。Xに貼ってね' : 'コピーできませんでした';
      setTimeout(function () { b.textContent = old; }, 1800);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(text, done); });
    } else {
      fallback(text, done);
    }
  }

  function fallback(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) { done(false); }
  }

  /* ============================================================
     起動
     ============================================================ */

  window.addEventListener('hashchange', route);
  route();
})();
