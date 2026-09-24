'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, HOST } = require('../src/main/engine');

function chat(e, id, text, extra = {}) {
  return e.handleChat({ channelId: id, name: extra.name || id, text, member: !!extra.member });
}
function joinAll(e, ids) { for (const x of ids) chat(e, x, `!参加 ${x}ID`); }
function names(e, keys) { return keys.map((k) => e.P(k).name); }
// 現在の対戦を ['a', 'b'] や ['a・b', 'c・d'] の形で返す
function cur(e) { const c = e.data.current; return c ? c.teams.map((t) => e.teamName(t)) : null; }
function queue(e) { return names(e, e.data.queue); }
function collectPosts(e) { const posts = []; e.on('post', (p) => posts.push(p)); return posts; }

// ---------- 参加受付 ----------
test('ID なしの !参加 は拒否され、書き方が返信される', () => {
  const e = new Engine();
  const posts = collectPosts(e);
  chat(e, 'a', '!参加');
  assert.equal(e.data.queue.length, 0);
  assert.match(posts[0].text, /ゲーム内ID/);
});

test('全角の！や全角スペースでも参加できる', () => {
  const e = new Engine();
  chat(e, 'a', '！参加　AAA');
  assert.equal(e.P('yt:a').gameId, 'AAA');
});

test('重複 ID は拒否、!ID で変更できる', () => {
  const e = new Engine();
  chat(e, 'a', '!参加 SAME');
  chat(e, 'b', '!参加 same');
  assert.equal(e.P('yt:b'), undefined);
  chat(e, 'a', '!ID NEW');
  assert.equal(e.P('yt:a').gameId, 'NEW');
});

test('再参加は登録済み ID を使える', () => {
  const e = new Engine();
  chat(e, 'a', '!参加 A1');
  chat(e, 'a', '!辞退');
  assert.equal(e.data.queue.length, 0);
  chat(e, 'a', '!参加');
  assert.deepEqual(e.data.queue, ['yt:a']);
});

test('メンバー優先: メンバーは非メンバーより前に入る', () => {
  const e = new Engine({ settings: { memberPriority: true } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  chat(e, 'm', '!参加 mID', { member: true });
  assert.equal(queue(e)[0], 'm');
});

test('受付締切中は参加できない（手動追加は可）', () => {
  const e = new Engine({ settings: { accepting: false } });
  chat(e, 'a', '!参加 aID');
  assert.equal(e.data.queue.length, 0);
  const r = e.addManual('手動さん', 'manualID');
  assert.equal(r.ok, true);
  assert.equal(e.settings.accepting, false);
});

test('コマンドでない発言は無視', () => {
  const e = new Engine();
  assert.equal(chat(e, 'a', '参加したい！'), null);
  assert.equal(chat(e, 'a', '!参加者多いね'), null);
});

// ---------- 1対1 ----------
test('2人揃うと対戦が組まれ、告知が出る', () => {
  const e = new Engine();
  const posts = collectPosts(e);
  joinAll(e, ['a', 'b']);
  assert.deepEqual(cur(e), ['a', 'b']);
  assert.ok(posts.some((p) => p.kind === 'announce' && p.text.includes('a vs b')));
});

test('勝ち抜き: 勝者が残り、連勝上限で交代', () => {
  const e = new Engine({ settings: { maxStreak: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  assert.deepEqual(cur(e), ['a', 'b']);
  e.result(1);
  assert.deepEqual(cur(e), ['a', 'c']);
  assert.deepEqual(queue(e), ['d', 'b']);
  const r = e.result(1); // a 2連勝 → 交代
  assert.equal(r.streakOut.name, 'a');
  assert.deepEqual(cur(e), ['d', 'b']);
  assert.deepEqual(queue(e), ['c', 'a']);
});

test('ローテーション: 2人とも最後尾へ', () => {
  const e = new Engine({ settings: { mode: 'rotation' } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  e.result(2);
  assert.deepEqual(cur(e), ['c', 'd']);
  assert.deepEqual(queue(e), ['a', 'b']);
});

test('取り消しで直前の状態に戻る', () => {
  const e = new Engine();
  joinAll(e, ['a', 'b', 'c']);
  e.result(2);
  assert.deepEqual(cur(e), ['b', 'c']);
  e.undo();
  assert.deepEqual(cur(e), ['a', 'b']);
  assert.equal(e.P('yt:b').w, 0);
  assert.equal(e.data.history.length, 0);
});

test('対戦中の辞退は試合後に抜ける', () => {
  const e = new Engine();
  joinAll(e, ['a', 'b', 'c']);
  chat(e, 'b', '!辞退');
  e.result(1);
  assert.equal(e.P('yt:b').state, 'left');
  assert.ok(!e.data.queue.includes('yt:b'));
});

test('不在の人は保留になり次の人と交代', () => {
  const e = new Engine();
  joinAll(e, ['a', 'b', 'c']);
  e.absent('yt:b');
  assert.deepEqual(cur(e), ['a', 'c']);
  assert.equal(e.P('yt:b').state, 'held');
  e.resume('yt:b');
  assert.deepEqual(queue(e), ['b']);
});

// ---------- 配信者の参加 ----------
test('毎試合出る + ローテーション = 配信者 vs 列の先頭（旧・配信者チャレンジ）', () => {
  const e = new Engine({ settings: { mode: 'rotation', hostPlay: 'always' } });
  chat(e, 'a', '!参加 aID');
  assert.deepEqual(cur(e), ['配信者', 'a']);
  chat(e, 'b', '!参加 bID');
  e.result(2); // 配信者が負けても出続ける
  assert.deepEqual(cur(e), ['配信者', 'b']);
  assert.ok(!e.data.queue.includes(HOST));
});

test('旧形式の mode:host は ローテーション + 毎試合出る に移行される', () => {
  const e = new Engine({ settings: { mode: 'host' } });
  assert.equal(e.settings.mode, 'rotation');
  assert.equal(e.settings.hostPlay, 'always');
});

test('列に並ぶ: 配信者も普通の参加者として列に入り、負けたら最後尾', () => {
  const e = new Engine();
  joinAll(e, ['a']);
  e.updateSettings({ hostPlay: 'queue' });
  assert.deepEqual(cur(e), ['a', '配信者']);
  chat(e, 'b', '!参加 bID');
  e.result(1); // 配信者の負け
  assert.deepEqual(cur(e), ['a', 'b']);
  assert.deepEqual(queue(e), ['配信者']);
  e.updateSettings({ hostPlay: 'off' });
  assert.deepEqual(queue(e), []);
});

test('ローテーション + 列に並ぶ: 配信者も含めて全員が均等に回る', () => {
  const e = new Engine({ settings: { mode: 'rotation', hostPlay: 'queue' } });
  joinAll(e, ['a', 'b', 'c']); // 配信者は設定時点では列が空なので、a の参加後に列へ
  assert.deepEqual(cur(e), ['配信者', 'a']);
  assert.deepEqual(queue(e), ['b', 'c']);
  e.result(1);
  assert.deepEqual(cur(e), ['b', 'c']);
  assert.deepEqual(queue(e), ['配信者', 'a']);
  e.result(2);
  assert.deepEqual(cur(e), ['配信者', 'a']); // 一巡して配信者の番が戻る
});

test('勝ち抜きの王者役: 配信者は先頭から入り、連勝上限なしで勝ち続けられる', () => {
  const e = new Engine({ settings: { maxStreak: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd']); // a vs b が始まっている
  e.cancelMatch();
  e.updateSettings({ hostPlay: 'champion' });
  assert.deepEqual(cur(e), ['配信者', 'a']);
  e.result(1); e.result(1); e.result(1); // 3連勝しても交代しない
  assert.equal(e.data.current.teams[0][0], HOST);
  assert.equal(e.data.streak, 3);
  e.result(2); // 配信者の負け → 挑戦者が王者、配信者は最後尾
  assert.equal(queue(e).at(-1), '配信者');
  assert.equal(e.data.streak, 1);
});

// ---------- 2対2 ----------
test('2対2: 列の順に 1・2番 vs 3・4番 で組む', () => {
  const e = new Engine({ settings: { teamSize: 2 } });
  joinAll(e, ['a', 'b', 'c']);
  assert.equal(e.data.current, null);
  joinAll(e, ['d', 'e', 'f']);
  assert.deepEqual(cur(e), ['a・b', 'c・d']);
});

test('2対2 勝ち抜き: 勝利チームが残り、負けチームは最後尾', () => {
  const e = new Engine({ settings: { teamSize: 2, maxStreak: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd', 'e', 'f']);
  e.result(1);
  assert.deepEqual(cur(e), ['a・b', 'e・f']);
  assert.deepEqual(queue(e), ['c', 'd']);
  const r = e.result(1); // 2連勝で交代
  assert.equal(r.streakOut.name, 'a・b');
  assert.deepEqual(cur(e), ['c・d', 'e・f']);
  assert.deepEqual(queue(e), ['a', 'b']);
});

test('2対2 ローテーション: 4人とも最後尾', () => {
  const e = new Engine({ settings: { teamSize: 2, mode: 'rotation' } });
  joinAll(e, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  e.result(2);
  assert.deepEqual(cur(e), ['e・f', 'g・h']);
  assert.deepEqual(queue(e), ['a', 'b', 'c', 'd']);
});

test('2対2 + 毎試合出る: 配信者 + 先頭 vs 次の2人', () => {
  const e = new Engine({ settings: { teamSize: 2, mode: 'rotation', hostPlay: 'always' } });
  joinAll(e, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(cur(e), ['配信者・a', 'b・c']);
  e.result(1);
  assert.deepEqual(cur(e), ['配信者・d', 'e・f']);
});

test('2対2 勝ち抜き + 毎試合出る: 配信者チームが負けたら配信者は新しい相方と挑戦', () => {
  const e = new Engine({ settings: { teamSize: 2, hostPlay: 'always' } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  assert.deepEqual(cur(e), ['配信者・a', 'b・c']);
  e.result(2);
  assert.deepEqual(cur(e), ['b・c', '配信者・d']);
  assert.deepEqual(queue(e), ['a']);
});

test('2対2 不在: 列の先頭の人がそのチームに入る', () => {
  const e = new Engine({ settings: { teamSize: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd', 'e']);
  e.absent('yt:c');
  assert.deepEqual(cur(e), ['a・b', 'e・d']);
});

test('人数が足りなくなったら残留チームは列の先頭で待つ（連勝は維持）', () => {
  const e = new Engine({ settings: { teamSize: 2, rejoin: false } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  e.result(1);
  assert.equal(e.data.current, null);
  assert.deepEqual(queue(e), ['a', 'b']);
  joinAll(e, ['e', 'f']);
  assert.deepEqual(cur(e), ['a・b', 'e・f']);
  e.result(1);
  assert.equal(e.data.streak, 2);
});

test('1対1 → 2対2 へ切り替えると次の試合から4人で組まれる', () => {
  const e = new Engine();
  joinAll(e, ['a', 'b', 'c', 'd']);
  e.updateSettings({ teamSize: 2 });
  e.result(1); // a が勝ち残り、a + 次の人 vs 残り2人
  assert.deepEqual(cur(e), ['a・c', 'd・b']);
});

// ---------- 協力プレイ ----------
function coop(extra = {}) { return new Engine({ settings: { format: 'coop', ...extra } }); }
const guests = (e) => names(e, e.data.party.guests);

test('協力: 参加者は配信者のパーティーに入る（3人PT = ゲスト2人）', () => {
  const e = coop();
  const posts = collectPosts(e);
  joinAll(e, ['a', 'b', 'c']);
  assert.deepEqual(guests(e), ['a', 'b']);
  assert.deepEqual(queue(e), ['c']);
  assert.ok(e.isPlaying(HOST));
  assert.ok(posts.some((p) => p.kind === 'announce' && p.text.includes('第1プレイ')));
});

test('協力: ボス撃破で全員交代、次のパーティーが組まれる', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c', 'd']);
  e.setTarget('マルギット');
  e.coopEnd('clear');
  assert.deepEqual(guests(e), ['c', 'd']);
  assert.deepEqual(queue(e), ['a', 'b']);
  assert.equal(e.P('yt:a').clears, 1);
  assert.equal(e.P(HOST).clears, 1);
  assert.equal(e.data.history[0].target, 'マルギット');
  assert.equal(e.data.party.target, 'マルギット'); // ボス名は次のプレイに引き継ぐ
});

test('協力: 全滅（配信者死亡）でも全員交代', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c']);
  e.coopEnd('wipe');
  assert.deepEqual(guests(e), ['c', 'a']);
  assert.equal(e.P('yt:a').wipes, 1);
});

test('協力: ゲストが死亡したらそのゲストだけ抜ける（既定は次のプレイまで枠を空ける）', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c']);
  e.coopDeath('yt:a');
  assert.deepEqual(guests(e), ['b']);
  assert.deepEqual(queue(e), ['c', 'a']);
  assert.equal(e.P('yt:a').deaths, 1);
  e.coopEnd('clear');
  assert.equal(e.P('yt:a').clears || 0, 0); // 死亡した人はクリアに数えない
  assert.deepEqual(guests(e), ['c', 'a']);
  assert.deepEqual(e.data.history[0].deaths, ['a']);
});

test('協力: 死亡枠をすぐ補充する設定 / 手動で今すぐ補充', () => {
  const e = coop({ coop: { refill: 'immediate' } });
  joinAll(e, ['a', 'b', 'c']);
  e.coopDeath('yt:a');
  assert.deepEqual(guests(e), ['b', 'c']);

  const f = coop();
  joinAll(f, ['a', 'b', 'c']);
  f.coopDeath('yt:a');
  assert.deepEqual(guests(f), ['b']);
  f.coopRefill();
  assert.deepEqual(guests(f), ['b', 'c']);
});

test('協力: 1人あたりのプレイ数を2にすると2プレイ続けて参加', () => {
  const e = coop({ coop: { preset: 'edf', partySize: 4, stayPlays: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(e.settings.coop.partySize, 4);
  assert.deepEqual(guests(e), ['a', 'b', 'c']);
  e.coopEnd('clear');
  assert.deepEqual(guests(e), ['a', 'b', 'c']);
  e.coopEnd('clear');
  assert.deepEqual(guests(e), ['d', 'e', 'a']);
});

test('協力: ゲームを地球防衛軍にすると4人PTになる', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c']);
  e.updateSettings({ coop: { preset: 'edf' } });
  assert.equal(e.settings.coop.partySize, 4);
  assert.deepEqual(guests(e), ['a', 'b', 'c']);
  e.updateSettings({ coop: { partySize: 2 } });
  assert.deepEqual(guests(e), ['a']);
  assert.deepEqual(queue(e), ['b', 'c']);
});

test('協力: 不在のゲストは保留、すぐ次の人が入る', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c']);
  e.absent('yt:b');
  assert.deepEqual(guests(e), ['a', 'c']);
  assert.equal(e.P('yt:b').state, 'held');
});

test('協力: 取り消しでプレイ結果を戻せる', () => {
  const e = coop();
  joinAll(e, ['a', 'b', 'c']);
  e.coopEnd('clear');
  e.undo();
  assert.deepEqual(guests(e), ['a', 'b']);
  assert.equal(e.data.history.length, 0);
});

test('対戦 ⇔ 協力 の切り替えで参加者は列に戻る', () => {
  const e = new Engine();
  joinAll(e, ['a', 'b', 'c']);
  e.updateSettings({ format: 'coop' });
  assert.equal(e.data.current, null);
  assert.deepEqual(guests(e), ['a', 'b']);
  e.updateSettings({ format: 'versus' });
  assert.equal(e.data.party, null);
  assert.deepEqual(cur(e), ['a', 'b']);
  assert.deepEqual(queue(e), ['c']);
});

test('CSV にヘッダと試合が出る', () => {
  const e = new Engine({ settings: { teamSize: 2 } });
  joinAll(e, ['a', 'b', 'c', 'd']);
  e.result(2);
  const csv = e.historyCsv();
  assert.match(csv, /チームA/);
  assert.match(csv, /"2対2"/);
  assert.match(csv, /"c・d"/);
});
