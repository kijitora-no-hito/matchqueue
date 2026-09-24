'use strict';
// わんコメ連携。わんコメのプラグイン（src/onecomme/plugin.js）から転送されたコメントを受け取る。
// Google Cloud の設定なしでチャットを読める（投稿はできない）。
// イベント: 'status'（状態変化）, 'message'（チャット1件。youtube.js の 'message' と同じ形）

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TEMPLATE = path.join(__dirname, '..', 'onecomme', 'plugin.js');
const ALIVE_MS = 70000; // プラグインは30秒ごとに hello を送る
const MAX_AGE_MS = 5 * 60 * 1000; // これより古いコメントは過去ログとみなして無視

// わんコメの timestamp は ミリ秒/秒の数値・文字列、ISO 文字列のいずれか
function parseTime(ts) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

class OneComme extends EventEmitter {
  // appData: %APPDATA%（わんコメのプラグインフォルダを探す場所）
  constructor({ store, appData }) {
    super();
    this.store = store;
    this.appData = appData;
    this.cfg = Object.assign({ token: '' }, store.load('onecomme.json', {}));
    if (!this.cfg.token) {
      this.cfg.token = crypto.randomBytes(24).toString('hex');
      store.saveNow('onecomme.json', this.cfg);
    }
    this.lastHelloAt = 0;
    this.lastCommentAt = 0;
    this.count = 0;
    this.pluginVersion = null;
    this.seen = new Set();
    this.seenOrder = [];
  }

  oneCommeDir() { return path.join(this.appData, 'onecomme'); }
  pluginDir() { return path.join(this.oneCommeDir(), 'plugins', 'matchqueue'); }
  isInstalled() { return fs.existsSync(path.join(this.pluginDir(), 'plugin.js')); }

  renderPlugin(port) {
    return fs.readFileSync(TEMPLATE, 'utf8')
      .replace('__PORT__', String(Number(port)))
      .replace('__TOKEN__', this.cfg.token);
  }

  install(port) {
    if (!fs.existsSync(this.oneCommeDir())) {
      throw new Error('わんコメが見つかりません（%APPDATA%\\onecomme がありません）。わんコメを一度起動してから試してください');
    }
    fs.mkdirSync(this.pluginDir(), { recursive: true });
    fs.writeFileSync(path.join(this.pluginDir(), 'plugin.js'), this.renderPlugin(port), 'utf8');
    this.emit('status');
    return this.pluginDir();
  }

  // ポート変更時など、入っているプラグインを最新の設定で書き直す
  updateIfInstalled(port) {
    if (this.isInstalled()) this.install(port);
  }

  status() {
    const now = Date.now();
    const last = Math.max(this.lastHelloAt, this.lastCommentAt);
    return {
      installed: this.isInstalled(),
      oneCommeFound: fs.existsSync(this.oneCommeDir()),
      connected: last > 0 && now - last < ALIVE_MS,
      lastSeenAt: last ? new Date(last).toISOString() : null,
      lastCommentAt: this.lastCommentAt ? new Date(this.lastCommentAt).toISOString() : null,
      count: this.count,
      pluginVersion: this.pluginVersion,
      pluginDir: this.pluginDir(),
    };
  }

  // server.js から呼ばれる。token が正しくなければ false
  receive(kind, body, token) {
    if (!token || token !== this.cfg.token) return false;
    const wasConnected = this.status().connected;
    if (kind === 'hello') {
      this.lastHelloAt = Date.now();
      this.pluginVersion = body && body.version ? String(body.version) : null;
      if (!wasConnected) this.emit('status');
      return true;
    }
    if (kind !== 'comments' || !body || !Array.isArray(body.comments)) return true;
    this.lastCommentAt = Date.now();
    for (const c of body.comments) {
      if (!c || !c.userId || typeof c.text !== 'string') continue;
      const id = String(c.id || '');
      if (id) {
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        this.seenOrder.push(id);
        if (this.seenOrder.length > 3000) this.seen.delete(this.seenOrder.shift());
      }
      const t = parseTime(c.timestamp);
      if (t && Date.now() - t > MAX_AGE_MS) continue;
      this.count++;
      const service = String(c.service || 'youtube');
      this.emit('message', {
        id,
        key: service === 'youtube' ? `yt:${c.userId}` : `${service}:${c.userId}`,
        channelId: String(c.userId),
        name: String(c.name || c.userId),
        text: c.text,
        member: !!c.isMember,
        isOwner: !!c.isOwner,
        self: !!c.isOwner,
        source: 'onecomme',
      });
    }
    this.emit('status');
    return true;
  }
}

module.exports = { OneComme, parseTime };
