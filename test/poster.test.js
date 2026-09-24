'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Poster } = require('../src/main/poster');
const { extractVideoId } = require('../src/main/youtube');

function makePoster(settings, canSend = true) {
  const sent = [];
  const p = new Poster({ send: async (t) => { sent.push(t); }, canSend: () => canSend, getSettings: () => settings });
  return { p, sent };
}

test('告知は返信より優先され、最新の1件だけ送られる', async () => {
  const { p, sent } = makePoster({ minIntervalSec: 1, replies: 'batch' });
  p.lastSentAt = Date.now(); // 間隔待ちの状態にしておく
  p.enqueue('reply', '@a 受付');
  p.enqueue('announce', '第1試合');
  p.enqueue('announce', '第2試合');
  p.lastSentAt = 0;
  await p.tick();
  p.stop();
  assert.deepEqual(sent, ['第2試合']);
  assert.equal(p.replies.length, 1);
});

test('返信は200文字以内でまとめられる', async () => {
  const { p, sent } = makePoster({ minIntervalSec: 1, replies: 'batch' });
  p.lastSentAt = Date.now();
  for (let i = 0; i < 20; i++) p.enqueue('reply', `@user${i} さん受付しました（待機 ${i + 1} 番目）`);
  p.lastSentAt = 0;
  await p.tick();
  p.stop();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 200);
  assert.match(sent[0], / \/ /);
});

test('返信しない設定・未接続時は送らない', async () => {
  const a = makePoster({ minIntervalSec: 1, replies: 'none' });
  a.p.enqueue('reply', 'x');
  await a.p.tick();
  a.p.stop();
  assert.equal(a.sent.length, 0);

  const b = makePoster({ minIntervalSec: 1, replies: 'each' }, false);
  b.p.enqueue('announce', 'y');
  await b.p.tick();
  b.p.stop();
  assert.equal(b.sent.length, 0);
  assert.equal(b.p.log[0].status, 'skipped');
});

test('動画 URL から ID を取り出せる', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://example.com'), null);
});
