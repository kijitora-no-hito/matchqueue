'use strict';
// ローカル HTTP サーバ（127.0.0.1 のみ）。
//  /overlay        OBS ブラウザソース用の画面
//  /events         オーバーレイへの状態配信（Server-Sent Events）
//  /oauth/callback Google OAuth のリダイレクト先

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const OVERLAY_DIR = path.join(__dirname, '..', 'overlay');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class LocalServer {
  constructor({ getPublicState, onOAuthCallback }) {
    this.getPublicState = getPublicState;
    this.onOAuthCallback = onOAuthCallback;
    this.clients = new Set();
    this.port = null;
    this.error = null;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.keepAlive = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 20000);
  }

  listen(port) {
    return new Promise((resolve) => {
      const onError = (e) => {
        this.error = e.code === 'EADDRINUSE' ? `ポート ${port} は他のアプリが使用中です` : e.message;
        this.port = null;
        resolve(false);
      };
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        this.port = port;
        this.error = null;
        resolve(true);
      });
    });
  }

  async restart(port) {
    if (port === this.port) return true;
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise((r) => (this.server.listening ? this.server.close(() => r()) : r()));
    return this.listen(port);
  }

  baseUrl() { return this.port ? `http://127.0.0.1:${this.port}` : null; }

  broadcast() {
    if (!this.clients.size) return;
    const msg = `data: ${JSON.stringify(this.getPublicState())}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(this.getPublicState())}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }

    if (p === '/oauth/callback') {
      let ok = false, message;
      try {
        await this.onOAuthCallback(url.searchParams);
        ok = true;
        message = 'YouTube との接続が完了しました。このタブを閉じて MatchQueue に戻ってください。';
      } catch (e) {
        message = `接続に失敗しました: ${e.message}`;
      }
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>MatchQueue</title><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee"><h2>${ok ? '✔' : '✖'} MatchQueue</h2><p>${message.replace(/</g, '&lt;')}</p></body>`);
      return;
    }

    const file = p === '/overlay' || p === '/overlay/' ? 'overlay.html' : p.replace(/^\/(overlay\/)?/, '');
    if (/^[\w.-]+$/.test(file) && TYPES[path.extname(file)]) {
      fs.readFile(path.join(OVERLAY_DIR, file), (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  close() {
    clearInterval(this.keepAlive);
    for (const c of this.clients) c.end();
    this.server.close();
  }
}

module.exports = { LocalServer };
