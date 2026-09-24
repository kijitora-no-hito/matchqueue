'use strict';
// 使い方ガイド（docs/guide.md）用のスクリーンショットを撮る。`npm run guide-shots` で実行。
// わんコメ連携の状態を再現し、視聴者のコメントはわんコメのプラグイン経由で流す（テスト表示を出さないため）。

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function guideShots({ app, win, actions, clearChat }) {
  const out = process.env.MATCHQUEUE_SMOKE;
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => {
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  };
  const view = async (v) => {
    await win.webContents.executeJavaScript(`document.querySelector('nav button[data-v="${v}"]').click()`);
    await sleep(300);
  };
  const scrollTop = () => win.webContents.executeJavaScript('document.querySelector("main").scrollTop = 0');

  try {
    await actions.updateSettings({ server: { port: 17898 } });
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));

    // わんコメの代わりにプラグインを直接呼ぶ
    const plugin = require(path.join(actions.ocInstall(), 'plugin.js'));
    plugin.init();
    let seq = 0;
    const say = async (...lines) => {
      plugin.subscribe('comments', {
        comments: lines.map(([name, text]) => ({
          service: 'youtube',
          data: { id: `g${++seq}`, userId: `UC_${Buffer.from(name).toString('hex')}`, name, comment: text, timestamp: String(Date.now()) },
        })),
      });
      await sleep(400);
    };
    const reset = async (settings) => {
      actions.newSession();
      clearChat();
      await actions.updateSettings(settings);
      await sleep(200);
    };

    // ---------- 1対1 勝ち抜き（視聴者同士） ----------
    await reset({ format: 'versus', teamSize: 1, mode: 'winner', hostPlay: 'off', maxStreak: 3, autoPost: true });
    await say(['たけのこ隊長', '!参加 Takenoko#1234'], ['sora_gg', '!参加 SORA-77'], ['みけねこ', 'こんばんは！']);
    await say(['みけねこ', '!参加'], ['Kenji', '!参加 KNJ_99']);
    actions.result(1);
    await say(['みけねこ', '!参加 mike_neko'], ['ぽんず', '!順番']);
    await view('format'); await scrollTop(); await shot('versus-format');
    await view('dash'); await shot('versus-dash');
    await view('overlay'); await sleep(800);
    await say(['ユウ', '!参加 yuu_0']);
    await sleep(600); await shot('versus-overlay');

    // ---------- 1対1 配信者チャレンジ（ローテーション＋毎試合出る） ----------
    await reset({ format: 'versus', teamSize: 1, mode: 'rotation', hostPlay: 'always' });
    await say(['たけのこ隊長', '!参加 Takenoko#1234'], ['sora_gg', '!参加 SORA-77'], ['みけねこ', '!参加 mike_neko'], ['Kenji', '!参加 KNJ_99']);
    actions.result(1);
    await view('dash'); await shot('challenge-dash');

    // ---------- 2対2 ----------
    await reset({ format: 'versus', teamSize: 2, mode: 'winner', hostPlay: 'off' });
    await say(['たけのこ隊長', '!参加 Takenoko#1234'], ['sora_gg', '!参加 SORA-77'], ['みけねこ', '!参加 mike_neko'],
      ['Kenji', '!参加 KNJ_99'], ['ぽんず', '!参加 ponzu'], ['ユウ', '!参加 yuu_0']);
    await view('dash'); await shot('duo-dash');

    // ---------- 協力：エルデンリング / ダークソウル ----------
    await reset({ format: 'coop', coop: { preset: 'souls', partySize: 3, stayPlays: 1, refill: 'nextPlay' } });
    await say(['褪せ人A', '!参加 ロジェール好き'], ['sora_gg', '!参加 SORA'], ['みけねこ', '!参加 ねこ騎士'], ['Kenji', '!参加 KNJ']);
    actions.setTarget('忌み鬼マルギット');
    actions.coopEnd('wipe'); // 1プレイ目は全滅 → 2プレイ目へ
    await sleep(300);
    await view('format'); await scrollTop(); await shot('coop-format');
    await view('dash');
    await say(['ぽんず', '!参加 ぽんず侍']);
    // 現在のゲストの1人目を死亡にする
    const firstGuest = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#partyBox .death'); return b ? JSON.parse(b.dataset.args)[0] : null; })()`);
    if (firstGuest) actions.coopDeath(firstGuest);
    await sleep(300); await shot('souls-dash');
    await view('overlay'); await sleep(800);
    await say(['ユウ', '!参加']);
    await sleep(600); await shot('souls-overlay');

    // ---------- 協力：地球防衛軍（4人・2プレイずつ） ----------
    await reset({ format: 'coop', coop: { preset: 'edf', partySize: 4, stayPlays: 2, refill: 'nextPlay' } });
    await say(['たけのこ隊長', '!参加 Takenoko'], ['sora_gg', '!参加 SORA'], ['みけねこ', '!参加 mike'], ['Kenji', '!参加 KNJ'],
      ['ぽんず', '!参加 ponzu'], ['ユウ', '!参加 yuu']);
    actions.setTarget('M01 大侵略');
    actions.coopEnd('clear');
    actions.setTarget('M02 地底の脅威');
    await view('dash'); await shot('edf-dash');
    await view('history'); await scrollTop(); await shot('history');

    plugin.destroy();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true }, null, 2));
  } catch (e) {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
  }
  app.quit();
};
