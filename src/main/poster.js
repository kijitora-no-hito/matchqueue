'use strict';
// YouTube チャットへの投稿キュー。
// - 告知(announce)は最新の1件だけ保持し、返信より優先
// - 投稿同士は最低 minIntervalSec 空ける（スパム扱い・クォータ対策）
// - 返信(reply)は設定により まとめる / 1件ずつ / 送らない

const { EventEmitter } = require('node:events');

const MAX_LEN = 200; // YouTube チャットの文字数上限

class Poster extends EventEmitter {
  // send: async (text) => void, canSend: () => boolean, getSettings: () => ({minIntervalSec, replies})
  constructor({ send, canSend, getSettings }) {
    super();
    this.send = send;
    this.canSend = canSend;
    this.getSettings = getSettings;
    this.announce = null;
    this.replies = [];
    this.lastSentAt = 0;
    this.busy = false;
    this.log = [];
    this.timer = setInterval(() => this.tick(), 1000);
  }

  enqueue(kind, text) {
    if (!text) return;
    if (!this.canSend()) {
      this._log(kind, text, 'skipped', 'YouTube 未接続のため送信しません');
      return;
    }
    if (kind === 'announce') {
      if (this.announce) this._log('announce', this.announce, 'replaced', '新しい告知に置き換え');
      this.announce = text;
    } else {
      if (this.getSettings().replies === 'none') { this._log(kind, text, 'skipped', '返信しない設定'); return; }
      this.replies.push(text);
    }
    this.tick();
  }

  _next() {
    if (this.announce) { const t = this.announce; this.announce = null; return { kind: 'announce', text: t }; }
    if (!this.replies.length) return null;
    if (this.getSettings().replies === 'each') return { kind: 'reply', text: this.replies.shift() };
    let text = this.replies.shift();
    while (this.replies.length && (text + ' / ' + this.replies[0]).length <= MAX_LEN) text += ' / ' + this.replies.shift();
    return { kind: 'reply', text };
  }

  async tick() {
    if (this.busy) return;
    const interval = Math.max(1, this.getSettings().minIntervalSec) * 1000;
    if (Date.now() - this.lastSentAt < interval) return;
    const item = this._next();
    if (!item) return;
    this.busy = true;
    const text = item.text.length > MAX_LEN ? item.text.slice(0, MAX_LEN - 1) + '…' : item.text;
    try {
      await this.send(text);
      this._log(item.kind, text, 'sent');
    } catch (e) {
      this._log(item.kind, text, 'failed', e.message);
    } finally {
      this.lastSentAt = Date.now();
      this.busy = false;
    }
  }

  clear() { this.announce = null; this.replies = []; }

  pending() { return (this.announce ? 1 : 0) + this.replies.length; }

  _log(kind, text, status, note = '') {
    this.log.unshift({ at: new Date().toISOString(), kind, text, status, note });
    if (this.log.length > 100) this.log.pop();
    this.emit('change');
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { Poster };
