/* ============================================================
   免罪符診断 — 純粋なロジック（DOM に触らない）

   app.js と tools/verify.js の両方から使う。
   ここを 1 か所直せば、画面とテストの両方に効く。

   読み込み順： data.js → logic.js → app.js
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- 決定的な乱数 ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function shuffle(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 選択肢の表示順 ----------
     order[qi] = [論理 index の並び]
     order[qi][表示位置] = 論理 index
     問題ごとに独立してシャッフルする（位置バイアス対策）。
     seed が同じなら同じ並びになるので、戻るボタンで崩れない。
     ------------------------------------------------------------ */

  function buildOrder(questions, seed) {
    return questions.map(function (q) {
      var rnd = mulberry32(hashStr(seed + ':' + q.id));
      var idx = [];
      for (var i = 0; i < q.choices.length; i++) idx.push(i);
      return shuffle(idx, rnd);
    });
  }

  /* ---------- 判定 ----------
     answers: 論理 index の配列（9 個、0–3）

     axis は「問題」に付いている（選択肢ではない）。ここを choice.axis と
     書くと全軸が undefined に潰れて、全回答が 000 になる。
     tools/verify.js が全 26 万通りを列挙して、この間違いを検出する。

     各軸 3 問。各問は pole が 2:2 で割れているので、
     ランダム回答でも各軸はきっかり 50/50 になる（＝8 型が均等）。
     ------------------------------------------------------------ */

  function diagnose(questions, types, answers) {
    if (!answers || answers.length !== questions.length) return null;

    var sum = {};
    var cnt = {};

    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      var c = q.choices[answers[qi]];
      if (!c || (c.pole !== 0 && c.pole !== 1)) return null;

      var ax = q.axis;
      if (sum[ax] === undefined) { sum[ax] = 0; cnt[ax] = 0; }
      sum[ax] += c.pole;
      cnt[ax] += 1;
    }

    var key = '';
    ['social', 'action', 'energy'].forEach(function (ax) {
      if (sum[ax] === undefined) { key = null; return; }
      var bit = sum[ax] >= Math.ceil(cnt[ax] / 2) ? 1 : 0;
      key += bit;
    });

    return key === null ? null : (types[key] || null);
  }

  /* ---------- 手抜き判定 ----------
     「表示位置」が全問同じ ＝ 一番上の選択肢を連打した等。
     論理 index ではなく表示位置で見るのがポイント。
     （シャッフルしているので、位置連打＝手抜きが正しく取れる）
     ------------------------------------------------------------ */

  function isEgg(positions, n) {
    if (!positions || positions.length !== n) return false;
    for (var i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[0]) return false;
    }
    return true;
  }

  /* ---------- 検証用：データ定義の整合性 ---------- */

  function validateData(questions, types) {
    var problems = [];

    var AXES = ['social', 'action', 'energy'];
    var byAxis = { social: 0, action: 0, energy: 0 };

    questions.forEach(function (q, qi) {
      var at = 'Q' + (qi + 1);
      if (AXES.indexOf(q.axis) === -1) problems.push(at + ': axis が不正 (' + q.axis + ')');
      else byAxis[q.axis] += 1;

      if (!q.text || !q.text.trim()) problems.push(at + ': text が空');
      if (!q.choices || q.choices.length !== 4) problems.push(at + ': 選択肢が 4 つでない');

      var p0 = 0, p1 = 0;
      (q.choices || []).forEach(function (c, ci) {
        if (!c.text || !c.text.trim()) problems.push(at + ' 選択肢' + ci + ': text が空');
        if (c.pole === 0) p0++;
        else if (c.pole === 1) p1++;
        else problems.push(at + ' 選択肢' + ci + ': pole が 0/1 でない');
      });
      if (p0 !== 2 || p1 !== 2) {
        problems.push(at + ': pole が 2:2 に割れていない（0側' + p0 + ' / 1側' + p1 + '）');
      }
    });

    AXES.forEach(function (ax) {
      if (byAxis[ax] !== 3) problems.push('axis ' + ax + ' の問題数が 3 でない（' + byAxis[ax] + '）');
    });

    var keys = [];
    for (var i = 0; i < 8; i++) {
      keys.push(('000' + i.toString(2)).slice(-3));
    }
    keys.forEach(function (k) {
      var t = types[k];
      if (!t) { problems.push('型 ' + k + ' が未定義'); return; }
      if (!t.name) problems.push('型 ' + k + ': name が空');
      if (!t.lines || !t.lines.length) problems.push('型 ' + k + ': lines が空');
      if (!t.menzai) problems.push('型 ' + k + ': menzai が空');
      if (!t.hook) problems.push('型 ' + k + ': hook が空');
      if (!t.color) problems.push('型 ' + k + ': color が空');
    });

    return problems;
  }

  global.MZ = {
    mulberry32: mulberry32,
    hashStr: hashStr,
    shuffle: shuffle,
    buildOrder: buildOrder,
    diagnose: diagnose,
    isEgg: isEgg,
    validateData: validateData
  };
})(typeof window !== 'undefined' ? window : globalThis);
