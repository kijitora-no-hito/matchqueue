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

    // わんコメ連携（仮のわんコメフォルダにプラグインを入れ、わんコメの代わりに呼び出す）
    const pluginDir = actions.ocInstall();
    const plugin = require(path.join(pluginDir, 'plugin.js'));
    plugin.init();
    const c = (id, userId, name, comment) => ({ service: 'youtube', data: { id, userId, name, comment, timestamp: String(Date.now()) } });
    await view('overlay'); await sleep(800);
    plugin.subscribe('comments', { comments: [c('oc1', 'UC_oc1', 'わんコメ太郎', '!参加'), c('oc2', 'UC_oc2', 'わんコメ花子', '!参加 hanako_01')] });
    await sleep(1200); await shot('17-overlay-notice');
    await view('settings'); await sleep(300); await shot('18-settings-onecomme');
    await view('dash'); await shot('19-dash-onecomme');
    // 新しい投稿候補で通知音が鳴る（回数で確認）
    const chimes0 = await win.webContents.executeJavaScript('window.chimeCount || 0');
    plugin.subscribe('comments', { comments: [c('oc3', 'UC_oc3', 'わんコメ次郎', '!参加 jiro_3')] });
    await sleep(800);
    const chimes1 = await win.webContents.executeJavaScript('window.chimeCount || 0');
    if (chimes1 <= chimes0) throw new Error('新しい投稿候補で通知音が鳴っていない');
    // 配信者が投稿候補をコピーしてチャットに貼った → わんコメ経由で流れてきたら候補から消える
    const pasted = await win.webContents.executeJavaScript(`document.querySelector('#candList .ct') && document.querySelector('#candList .ct').textContent`);
    const before = await win.webContents.executeJavaScript(`document.querySelectorAll('#candList li:not(.empty)').length`);
    plugin.subscribe('comments', { comments: [{ service: 'youtube', data: { id: 'oc-host', userId: 'UC_host', name: '配信者', comment: pasted, isOwner: true, timestamp: String(Date.now()) } }] });
    await sleep(800);
    const after = await win.webContents.executeJavaScript(`document.querySelectorAll('#candList li:not(.empty)').length`);
    if (after !== before - 1) throw new Error(`貼り付け後に候補が消えていない: ${before} → ${after}`);
    await shot('20-dash-pasted');
    plugin.destroy();

    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, errors }, null, 2));
  } catch (e) {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: String(e && e.stack || e), errors }, null, 2));
  }
  app.quit();
};
