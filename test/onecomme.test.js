'use strict';
// わんコメ連携：プラグイン → ローカルサーバ → OneComme → メッセージ の流れを、わんコメなしで確認する
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OneComme, parseTime } = require('../src/main/onecomme');
const { LocalServer } = require('../src/main/server');
const { Store } = require('../src/main/store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mq-oc-')); }

function setup() {
  const dir = tmpDir();
  const appData = path.join(dir, 'appdata');
  fs.mkdirSync(path.join(appData, 'onecomme'), { recursive: true }); // わんコメがインストール済みの想定
  const oc = new OneComme({ store: new Store(path.join(dir, 'userdata')), appData });
  const messages = [];
  oc.on('message', (m) => messages.push(m));
  return { dir, appData, oc, messages };
}

// わんコメがプラグインに渡すコメントの形（@onecomme.com/onesdk の型に準拠）
function ytComment(id, userId, name, comment, extra = {}) {
  return { id: 'frame-1', service: 'youtube', name: 'YouTube', data: { id, userId, name, comment, isOwner: false, isMember: false, timestamp: String(Date.now()), ...extra } };
}

test('プラグイン → サーバ → OneComme でコメントが届く（トークン必須）', async () => {
  const { appData, oc, messages } = setup();
  const server = new LocalServer({ getPublicState: () => ({}), onOAuthCallback: async () => {}, onOneComme: (k, b, t) => oc.receive(k, b, t) });
  const port = 17951;
  assert.equal(await server.listen(port), true);
  try {
    const dir = oc.install(port);
    const plugin = require(path.join(dir, 'plugin.js'));
    assert.equal(plugin.uid, 'io.github.kijitora-no-hito.matchqueue');
    assert.deepEqual(plugin.permissions, ['comments']);

    plugin.init();
    plugin.subscribe('comments', {
      comments: [
        ytComment('c1', 'UCaaa', 'たけのこ', '!参加 <img src="x" alt=":fire:">Take&amp;1'),
        ytComment('c2', 'UCbbb', 'みけ', 'こんにちは', { isMember: true }),
        { id: 'sys', service: 'system', data: { id: 's1', userId: 'x', comment: 'system' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    plugin.destroy();

    assert.equal(messages.length, 2);
    assert.equal(messages[0].key, 'yt:UCaaa');
    assert.equal(messages[0].text, '!参加 :fire:Take&1');
    assert.equal(messages[1].member, true);
    assert.equal(oc.status().connected, true);

    // トークンなし（ブラウザなど他からの送信）は拒否
    const res = await fetch(`http://127.0.0.1:${port}/onecomme/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: [{ id: 'x', userId: 'evil', text: '!参加 EVIL' }] }),
    });
    assert.equal(res.status, 403);
    assert.equal(messages.length, 2);
  } finally {
    server.close();
  }
});

test('同じコメントは二重に処理しない・古いコメントは無視', () => {
  const { oc, messages } = setup();
  const token = oc.cfg.token;
  const c = { id: 'c1', userId: 'U1', name: 'a', text: '!参加 A', timestamp: Date.now() };
  oc.receive('comments', { comments: [c, c] }, token);
  oc.receive('comments', { comments: [c] }, token);
  assert.equal(messages.length, 1);
  oc.receive('comments', { comments: [{ id: 'old', userId: 'U2', name: 'b', text: 'old', timestamp: Date.now() - 10 * 60 * 1000 }] }, token);
  assert.equal(messages.length, 1);
});

test('YouTube 以外の配信サービスは別のキーになる', () => {
  const { oc, messages } = setup();
  oc.receive('comments', { comments: [{ id: 't1', service: 'twitch', userId: '42', name: 'tw', text: '!参加 X' }] }, oc.cfg.token);
  assert.equal(messages[0].key, 'twitch:42');
});

test('わんコメがない PC ではインストールできない', () => {
  const dir = tmpDir();
  const oc = new OneComme({ store: new Store(path.join(dir, 'ud')), appData: path.join(dir, 'none') });
  assert.throws(() => oc.install(17800), /わんコメが見つかりません/);
  assert.equal(oc.status().oneCommeFound, false);
});

test('プラグインにはポートとトークンが書き込まれる', () => {
  const { oc } = setup();
  const src = oc.renderPlugin(18000);
  assert.match(src, /const PORT = 18000;/);
  assert.ok(src.includes(oc.cfg.token));
  assert.ok(!src.includes('__TOKEN__'));
});

test('timestamp の形式（ミリ秒・秒・ISO）', () => {
  assert.equal(parseTime('1758600000000'), 1758600000000);
  assert.equal(parseTime(1758600000), 1758600000000);
  assert.equal(parseTime('2026-09-24T00:00:00Z'), Date.parse('2026-09-24T00:00:00Z'));
  assert.equal(parseTime(undefined), null);
});
