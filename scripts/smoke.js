'use strict';
// 開発用の動作確認スクリプト。
//   $env:MATCHQUEUE_SMOKE = "出力フォルダ"; $env:MATCHQUEUE_USERDATA = "一時フォルダ"; npx electron .
// テスト用チャットで参加者を入れ、数試合進めて各画面のスクリーンショットを保存して終了する。

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke({ app, win, actions, engine }) {
  const out = process.env.MATCHQUEUE_SMOKE;
  fs.mkdirSync(out, { recursive: true });
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) errors.push(e.message ?? e.params?.message);
  });
  const shot = async (name) => {
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  };
  const view = (v) => win.webContents.executeJavaScript(`document.querySelector('nav button[data-v="${v}"]').click()`);

  try {
    await actions.updateSettings({ server: { port: 17899 } }); // 本番起動中のアプリとポートがぶつからないように
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(500);
    await shot('01-empty');

    const joins = [
      ['たけのこ隊長', '!参加 Takenoko#1234'], ['sora_gg', '！参加　SORA-77'], ['みけねこ', '!参加'],
      ['みけねこ', '!参加 mike_neko'], ['Kenji', '!join KNJ_99'], ['ぽんず', '!参加 SORA-77'],
      ['ぽんず', '!参加 ponzu'], ['ユウ', '!参加 yuu_0'], ['Kenji', '!順番'], ['通りすがり', 'こんばんは！'],
    ];
    for (const [n, t] of joins) actions.testChat(n, t);
    actions.result(1);
    actions.result(1);
    actions.testChat('sora_gg', '!ID SORA-88');
    await shot('02-dash');

    await view('players'); await shot('03-players');
    await view('format'); await shot('04-format');
    await view('history'); await shot('05-history');
    await view('overlay'); await sleep(1200); await shot('06-overlay');
    await view('settings'); await shot('07-settings');

    // 2対2 + 配信者が毎試合出る
    await actions.updateSettings({ teamSize: 2, hostPlay: 'always' });
    for (const [n, t] of [['つばさ', '!参加 TSUBASA'], ['ハル', '!参加 haru_h'], ['かえで', '!参加 kaede']]) actions.testChat(n, t);
    actions.result(2);
    await view('dash'); await shot('08-dash-2v2');
    await view('overlay'); await sleep(800); await shot('09-overlay-2v2');
    await view('format'); await shot('10-format');
    await view('history'); await shot('11-history');

    // 協力プレイ（ソウル系 3人PT）
    await actions.updateSettings({ format: 'coop', coop: { preset: 'souls' } });
    actions.setTarget('忌み鬼マルギット');
    actions.coopEnd('wipe');
    const guest = engine.data.party.guests[0];
    actions.coopDeath(guest);
    await view('dash'); await shot('12-dash-coop');
    await view('overlay'); await sleep(800); await shot('13-overlay-coop');
    // 地球防衛軍 4人PT
    await actions.updateSettings({ coop: { preset: 'edf' } });
    actions.coopRefill();
    actions.setTarget('M1 大侵略');
    actions.coopEnd('clear');
    await view('dash'); await shot('14-dash-edf');
    await view('format'); await shot('15-format-coop');
    await view('history'); await shot('16-history-coop');

    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, errors }, null, 2));
  } catch (e) {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: String(e && e.stack || e), errors }, null, 2));
  }
  app.quit();
};
