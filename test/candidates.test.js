'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Candidates } = require('../src/main/candidates');

test('告知は最新の1件だけ残り、返信は貯まる', () => {
  const c = new Candidates();
  c.add('announce', '【第1試合】a vs b');
  c.add('reply', '@x さん受付しました');
  c.add('announce', '【第2試合】a vs c');
  assert.deepEqual(c.items.map((i) => i.text), ['@x さん受付しました', '【第2試合】a vs c']);
});

test('チャットに貼られた文面は候補から消える（空白・全角半角の違いは無視）', () => {
  const c = new Candidates();
  c.add('reply', '@わんコメ太郎 さん受付しました（ID: ABC / 待機 1 番目）');
  c.add('announce', '【第3プレイ】参加：a・b さん 準備お願いします！');
  assert.equal(c.matchPosted('@わんコメ太郎 さん受付しました（ID: ABC / 待機 1 番目）'), true);
  assert.equal(c.items.length, 1);
  // 全角英数字・スペースの揺れ
  assert.equal(c.matchPosted('【第３プレイ】参加：a・b さん　準備お願いします！'), true);
  assert.equal(c.items.length, 0);
  assert.equal(c.matchPosted('関係ないコメント'), false);
});

test('コピー済みの印・個別削除・全削除', () => {
  const c = new Candidates();
  const a = c.add('reply', 'one');
  c.add('reply', 'two');
  assert.equal(c.markCopied(a.id).copied, true);
  c.remove(a.id);
  assert.deepEqual(c.items.map((i) => i.text), ['two']);
  c.clear();
  assert.equal(c.items.length, 0);
});

test('200 文字を超える文面は切り詰める', () => {
  const c = new Candidates();
  const item = c.add('reply', 'あ'.repeat(250));
  assert.equal(item.text.length, 200);
});
