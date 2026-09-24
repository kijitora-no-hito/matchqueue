'use strict';
// チャット投稿候補。YouTube API で投稿できない時（わんコメ連携など）に、
// 配信者がコピーして手でチャットに貼るための文面を貯める。
// 貼られた文面がチャットに流れてきたら自動で候補から消す。

const { EventEmitter } = require('node:events');

const MAX_LEN = 200; // YouTube チャットの文字数上限
const MAX_ITEMS = 30;

// 貼り付け時の空白や全角/半角の揺れを吸収して比べる
function norm(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

class Candidates extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.seq = 0;
  }

  add(kind, text) {
    if (!text) return null;
    const t = text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text;
    // 告知は最新のものだけ意味があるので、古い告知は置き換える
    if (kind === 'announce') this.items = this.items.filter((c) => c.kind !== 'announce');
    const item = { id: ++this.seq, kind, text: t, at: new Date().toISOString(), copied: false };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.shift();
    this.emit('change');
    return item;
  }

  get(id) { return this.items.find((c) => c.id === id) || null; }

  markCopied(id) {
    const c = this.get(id);
    if (!c) return null;
    c.copied = true;
    this.emit('change');
    return c;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length !== before) this.emit('change');
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.emit('change');
  }

  // チャットに流れてきた文面と一致する候補を消す。消したら true
  matchPosted(text) {
    const n = norm(text);
    if (!n) return false;
    const hit = this.items.find((c) => norm(c.text) === n);
    if (!hit) return false;
    this.remove(hit.id);
    return true;
  }
}

module.exports = { Candidates, norm };
