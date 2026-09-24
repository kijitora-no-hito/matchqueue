'use strict';
// userData 配下への JSON 保存。書き込みは一時ファイル → rename で壊れにくくする。

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.timers = new Map();
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  }

  file(name) { return path.join(this.dir, name); }

  load(name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  saveNow(name, obj) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  }

  // 連続した変更をまとめて保存
  save(name, getObj, delay = 300) {
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => {
      this.timers.delete(name);
      try { this.saveNow(name, getObj()); } catch (e) { console.error('save failed', name, e); }
    }, delay));
  }

  flush(name, obj) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    this.saveNow(name, obj);
  }

  archiveSession(data) {
    if (!data || !data.history || data.history.length === 0) return null;
    const f = path.join(this.dir, 'sessions', `${data.sessionId}.json`);
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
    return f;
  }

  sessionsDir() { return path.join(this.dir, 'sessions'); }
}

module.exports = { Store };
