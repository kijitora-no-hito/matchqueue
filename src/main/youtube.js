'use strict';
// YouTube Data API v3 連携（外部ライブラリなし / fetch 直叩き）
// - OAuth 2.0（デスクトップアプリ + ループバック + PKCE）
// - ライブチャット取得（liveChatMessages.list をポーリング。pollingIntervalMillis を尊重）
// - ライブチャット投稿（liveChatMessages.insert）
// イベント: 'status'（状態変化）, 'message'（チャット1件）

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

// クォータ消費の目安（推定値。正確な値は Google Cloud Console で確認）
const COST = { list: 1, chatList: 5, chatInsert: 50 };

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube のクォータは太平洋時間の 0 時にリセットされる
function quotaDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

class YouTube extends EventEmitter {
  // store: Store, secret: {encrypt(str)->str, decrypt(str)->str}, openExternal(url), getRedirectUri() -> string|null
  constructor({ store, secret, openExternal, getRedirectUri }) {
    super();
    this.store = store;
    this.secret = secret;
    this.openExternal = openExternal;
    this.getRedirectUri = getRedirectUri;
    this.cfg = Object.assign(
      { clientId: '', clientSecretEnc: '', tokensEnc: '', channel: null, quota: { day: '', used: 0 }, minPollSec: 5 },
      store.load('youtube.json', {}),
    );
    this.tokens = this._decryptJson(this.cfg.tokensEnc);
    this.pendingAuth = null;
    this.chat = { state: 'idle', liveChatId: null, title: '', error: null, lastPollAt: null, pollMs: null };
    this.chatGen = 0;
    this.pageToken = null;
  }

  // ---------- 設定・状態 ----------
  _save() { this.store.saveNow('youtube.json', this.cfg); }
  _emit() { this.emit('status', this.status()); }

  _decryptJson(enc) {
    if (!enc) return null;
    try { return JSON.parse(this.secret.decrypt(enc)); } catch { return null; }
  }

  status() {
    return {
      configured: !!(this.cfg.clientId && this.cfg.clientSecretEnc),
      clientId: this.cfg.clientId,
      authorized: !!(this.tokens && this.tokens.refresh_token),
      channel: this.cfg.channel,
      waitingAuth: !!this.pendingAuth,
      chat: { ...this.chat },
      quota: this.cfg.quota.day === quotaDay() ? this.cfg.quota.used : 0,
      minPollSec: this.cfg.minPollSec,
    };
  }

  setClient(clientId, clientSecret) {
    this.cfg.clientId = String(clientId || '').trim();
    if (clientSecret) this.cfg.clientSecretEnc = this.secret.encrypt(String(clientSecret).trim());
    this._save();
    this._emit();
  }

  setMinPollSec(sec) {
    this.cfg.minPollSec = Math.max(2, Math.min(60, Number(sec) || 5));
    this._save();
    this._emit();
  }

  _addQuota(n) {
    const day = quotaDay();
    if (this.cfg.quota.day !== day) this.cfg.quota = { day, used: 0 };
    this.cfg.quota.used += n;
    this._save();
  }

  // ---------- OAuth ----------
  beginAuth() {
    if (!this.cfg.clientId || !this.cfg.clientSecretEnc) throw new Error('先にクライアント ID とシークレットを保存してください');
    const redirectUri = this.getRedirectUri();
    if (!redirectUri) throw new Error('ローカルサーバが起動していません（ポート設定を確認してください）');
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    this.pendingAuth = { state, verifier, redirectUri };
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    this.openExternal(`${AUTH_URL}?${q}`);
    this._emit();
  }

  async handleCallback(params) {
    const pending = this.pendingAuth;
    if (params.get('error')) { this.pendingAuth = null; this._emit(); throw new Error(params.get('error')); }
    if (!pending || params.get('state') !== pending.state) throw new Error('認証リクエストが見つかりません。アプリからもう一度ログインしてください');
    this.pendingAuth = null;
    const tok = await this._tokenRequest({
      code: params.get('code'),
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    this._setTokens(tok);
    try {
      const r = await this._api('GET', 'channels', { query: { part: 'snippet', mine: 'true' }, cost: COST.list });
      const ch = r.items && r.items[0];
      this.cfg.channel = ch ? { id: ch.id, title: ch.snippet.title } : null;
    } catch (e) {
      this.cfg.channel = null;
    }
    this._save();
    this._emit();
  }

  logout() {
    this.disconnectChat();
    this.tokens = null;
    this.cfg.tokensEnc = '';
    this.cfg.channel = null;
    this._save();
    this._emit();
  }

  async _tokenRequest(params) {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.secret.decrypt(this.cfg.clientSecretEnc),
      ...params,
    });
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error_description || json.error || `token error ${res.status}`);
      err.reason = json.error;
      throw err;
    }
    return json;
  }

  _setTokens(tok) {
    this.tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || (this.tokens && this.tokens.refresh_token),
      expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    };
    this.cfg.tokensEnc = this.secret.encrypt(JSON.stringify(this.tokens));
    this._save();
  }

  async _accessToken(force = false) {
    if (!this.tokens || !this.tokens.refresh_token) throw new Error('YouTube にログインしていません');
    if (!force && this.tokens.expires_at - 60000 > Date.now()) return this.tokens.access_token;
    try {
      const tok = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token });
      this._setTokens(tok);
      return this.tokens.access_token;
    } catch (e) {
      if (e.reason === 'invalid_grant') {
        this.tokens = null;
        this.cfg.tokensEnc = '';
        this._save();
        this._emit();
        throw new Error('ログインの有効期限が切れました。設定画面から再ログインしてください');
      }
      throw e;
    }
  }

  async _api(method, path, { query = {}, body, cost = 1 } = {}, retried = false) {
    const token = await this._accessToken(retried);
    const url = `${API}/${path}?${new URLSearchParams(query)}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    this._addQuota(cost);
    if (res.status === 401 && !retried) return this._api(method, path, { query, body, cost: 0 }, true);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json.error && json.error.errors && json.error.errors[0] && json.error.errors[0].reason;
      const err = new Error((json.error && json.error.message) || `YouTube API error ${res.status}`);
      err.reason = reason;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // ---------- 配信の選択 ----------
  async listBroadcasts() {
    const out = [];
    for (const broadcastStatus of ['active', 'upcoming']) {
      const r = await this._api('GET', 'liveBroadcasts', {
        query: { part: 'snippet,status', broadcastStatus, broadcastType: 'all', maxResults: '10' },
        cost: COST.list,
      });
      for (const b of r.items || []) {
        out.push({
          id: b.id,
          title: b.snippet.title,
          status: b.status.lifeCycleStatus,
          liveChatId: b.snippet.liveChatId,
          scheduledStart: b.snippet.scheduledStartTime,
        });
      }
    }
    this._emit();
    return out;
  }

  async resolveVideo(input) {
    const id = extractVideoId(input);
    if (!id) throw new Error('動画の URL または ID を認識できません');
    const r = await this._api('GET', 'videos', { query: { part: 'snippet,liveStreamingDetails', id }, cost: COST.list });
    const v = r.items && r.items[0];
    if (!v) throw new Error('動画が見つかりません');
    const liveChatId = v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
    if (!liveChatId) throw new Error('この動画にはライブチャットがありません（配信中・配信予定ではない可能性）');
    return { id, title: v.snippet.title, liveChatId };
  }

  // ---------- チャット ----------
  connectChat({ liveChatId, title }) {
    if (!liveChatId) throw new Error('liveChatId がありません');
    this.disconnectChat();
    const gen = ++this.chatGen;
    this.pageToken = null;
    this.chat = { state: 'connecting', liveChatId, title: title || '', error: null, lastPollAt: null, pollMs: null };
    this._emit();
    this._pollLoop(gen);
  }

  disconnectChat() {
    this.chatGen++;
    if (this._wake) this._wake();
    if (this.chat.state !== 'idle') {
      this.chat = { state: 'idle', liveChatId: null, title: '', error: null, lastPollAt: null, pollMs: null };
      this._emit();
    }
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this._wake = done;
    });
  }

  async _pollLoop(gen) {
    let first = true;
    while (gen === this.chatGen) {
      let wait;
      try {
        const query = { liveChatId: this.chat.liveChatId, part: 'snippet,authorDetails', maxResults: '2000' };
        if (this.pageToken) query.pageToken = this.pageToken;
        const r = await this._api('GET', 'liveChat/messages', { query, cost: COST.chatList });
        if (gen !== this.chatGen) return;
        this.pageToken = r.nextPageToken;
        // 接続直後の1ページ目は過去ログなのでコマンドとして扱わない
        if (!first) for (const item of r.items || []) this._onItem(item);
        first = false;
        wait = Math.max(r.pollingIntervalMillis || 5000, this.cfg.minPollSec * 1000);
        Object.assign(this.chat, { state: r.offlineAt ? 'ended' : 'connected', error: null, lastPollAt: new Date().toISOString(), pollMs: wait });
        this._emit();
        if (r.offlineAt) return;
      } catch (e) {
        if (gen !== this.chatGen) return;
        const fatal = ['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'forbidden', 'quotaExceeded', 'insufficientPermissions'];
        if (fatal.includes(e.reason) || !this.tokens) {
          Object.assign(this.chat, { state: e.reason === 'liveChatEnded' ? 'ended' : 'error', error: e.message });
          this._emit();
          return;
        }
        wait = e.reason === 'rateLimitExceeded' ? 30000 : 10000;
        Object.assign(this.chat, { error: `${e.message}（${wait / 1000}秒後に再試行）` });
        this._emit();
      }
      await this._wait(wait);
    }
  }

  _onItem(item) {
    const sn = item.snippet || {};
    let text = null;
    if (sn.type === 'textMessageEvent') text = (sn.textMessageDetails && sn.textMessageDetails.messageText) || sn.displayMessage;
    else if (sn.type === 'superChatEvent') text = sn.superChatDetails && sn.superChatDetails.userComment;
    if (!text) return;
    const a = item.authorDetails || {};
    this.emit('message', {
      id: item.id,
      channelId: a.channelId,
      name: a.displayName,
      text,
      member: !!a.isChatSponsor,
      isOwner: !!a.isChatOwner,
      isModerator: !!a.isChatModerator,
      self: !!(this.cfg.channel && a.channelId === this.cfg.channel.id),
      publishedAt: sn.publishedAt,
    });
  }

  canPost() { return !!(this.tokens && this.chat.liveChatId && (this.chat.state === 'connected' || this.chat.state === 'connecting')); }

  async post(text) {
    if (!this.chat.liveChatId) throw new Error('ライブチャットに接続していません');
    await this._api('POST', 'liveChat/messages', {
      query: { part: 'snippet' },
      body: { snippet: { liveChatId: this.chat.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } },
      cost: COST.chatInsert,
    });
    this._emit();
  }
}

module.exports = { YouTube, extractVideoId };
