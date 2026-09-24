'use strict';
// 対戦進行エンジン。Electron に依存しない純粋なロジック（test/engine.test.js でテスト）。
// 状態が変わると 'change'、YouTube へ投稿したい文面があると 'post' を emit する。
//
// 試合は2チーム制：current.teams = [[key...], [key...]]（1対1 なら各1人、2対2 なら各2人）
// 配信者（HOST）の参加方法は settings.hostPlay で切り替える。

const { EventEmitter } = require('node:events');

const HOST = 'host';

const MODES = {
  winner: '勝ち抜き',
  rotation: 'ローテーション',
};

const HOST_PLAY = {
  off: '参加しない',
  always: '毎試合出る',
  queue: '列に並ぶ',
  champion: '勝ち抜きの王者役',
};

// 協力プレイのゲーム別の言い回し・既定人数
const COOP_PRESETS = {
  souls: { name: 'エルデンリング / ダークソウル', clear: 'ボス撃破', wipe: '全滅（ホスト死亡）', death: '死亡', target: 'ボス', partySize: 3 },
  edf: { name: '地球防衛軍', clear: 'ミッションクリア', wipe: 'ミッション失敗', death: '死亡', target: 'ミッション', partySize: 4 },
};

const DEFAULT_SETTINGS = {
  format: 'versus', // versus: 対戦 | coop: 協力
  coop: {
    preset: 'souls',
    partySize: 3, // 配信者を含む人数
    stayPlays: 1, // ゲスト1人あたりの連続参加プレイ数（0 = 死亡するまで）
    refill: 'nextPlay', // ゲスト死亡で空いた枠: nextPlay 次のプレイから補充 | immediate すぐ補充
  },
  mode: 'winner',
  teamSize: 1,
  hostPlay: 'off',
  maxStreak: 3,
  rejoin: true,
  accepting: true,
  autoPost: true,
  maxQueue: 30,
  memberPriority: false,
  hostName: '配信者',
  gameIdMaxLength: 32,
  gameIdPattern: '',
  commands: {
    join: ['!参加', '!join'],
    leave: ['!辞退', '!leave'],
    position: ['!順番', '!q'],
    changeId: ['!ID', '!id'],
  },
  post: {
    minIntervalSec: 10,
    replies: 'batch', // batch | each | none
  },
  overlay: { match: true, queue: true, join: true, maskId: false },
  server: { port: 17800 },
  tpl: {
    next: '【第{no}試合】{p1} vs {p2} 準備お願いします！ 次は {next} さん',
    party: '【第{no}プレイ】{target}参加：{members} さん 準備お願いします！ 次は {next} さん',
    join: '@{name} さん受付しました（ID: {id} / 待機 {pos} 番目）',
    needId: '@{name} さん ゲーム内IDを付けて「{cmd} ID」と書き込んでください',
    already: '@{name} さんは参加済みです（{pos}）',
    closed: '@{name} さん 現在は受付を締め切っています',
    full: '@{name} さん 待機列が満員です。少し待ってからもう一度どうぞ',
    badId: '@{name} さん ゲーム内IDの形式が正しくありません',
    dupId: '@{name} さん そのIDは他の参加者が登録済みです',
    position: '@{name} さんは {pos} です',
    notJoined: '@{name} さんは未参加です。「{cmd} ID」で参加できます',
    leave: '@{name} さん 辞退を受け付けました',
    leaveAfter: '@{name} さん この試合の後に抜けます',
    idChanged: '@{name} さん IDを {id} に変更しました',
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function mergeDeep(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v) && isObj(base[k])) mergeDeep(base[k], v);
    else if (v !== undefined) base[k] = clone(v);
  }
  return base;
}

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

// 全角の「！」「　」を半角に揃える
function normalize(text) {
  return String(text || '').replace(/！/g, '!').replace(/　/g, ' ').trim();
}

function nowIso() { return new Date().toISOString(); }

function freshData(hostName) {
  return {
    sessionId: new Date().toISOString().replace(/[-:]/g, '').slice(0, 15),
    startedAt: nowIso(),
    seq: 0,
    players: {
      [HOST]: { key: HOST, name: hostName, gameId: '', member: false, w: 0, l: 0, joinedAt: nowIso(), state: 'active', leaveAfter: false },
    },
    queue: [],
    current: null, // 対戦中の試合
    party: null, // 協力プレイ中のパーティー
    champ: null, // 連勝中チームの teamId
    streak: 0,
    matchNo: 0,
    history: [],
  };
}

// 旧形式（1対1 専用の p1/p2、mode:'host'）からの移行
function migrate(settings, data) {
  if (settings.mode === 'host') { settings.mode = 'rotation'; settings.hostPlay = 'always'; }
  const c = data.current;
  if (c && !c.teams) data.current = { teams: [[c.p1], [c.p2]], no: c.no, startedAt: c.startedAt };
  for (const h of data.history) {
    if (h.teams) continue;
    h.teams = [[h.p1], [h.p2]];
    h.names = [[h.p1Name], [h.p2Name]];
    h.ids = [[h.p1Id], [h.p2Id]];
    h.winSide = h.win === h.p1 ? 0 : 1;
    if (h.mode === 'host') h.mode = 'rotation';
  }
  if (data.party === undefined) data.party = null;
}

class Engine extends EventEmitter {
  constructor(saved = {}) {
    super();
    this.settings = mergeDeep(clone(DEFAULT_SETTINGS), saved.settings);
    this.data = saved.data || freshData(this.settings.hostName);
    if (!this.data.players[HOST]) this.data.players[HOST] = freshData(this.settings.hostName).players[HOST];
    migrate(this.settings, this.data);
    this.undoStack = [];
    if (this._isCoop() && !this.data.party) this._newParty();
  }

  // ---------- 参照 ----------
  P(k) { return this.data.players[k]; }
  teamId(team) { return team.slice().sort().join('+'); }
  teamName(team) { return team.map((k) => this.P(k).name).join('・'); }
  _isCoop() { return this.settings.format === 'coop'; }
  _hostPinned() { return this.settings.hostPlay === 'always'; }
  _hostQueued() { return !this._isCoop() && (this.settings.hostPlay === 'queue' || this.settings.hostPlay === 'champion'); }
  coopLabels() { return COOP_PRESETS[this.settings.coop.preset] || COOP_PRESETS.souls; }

  isPlaying(k) {
    const { current: c, party } = this.data;
    if (c && c.teams.some((t) => t.includes(k))) return true;
    return !!party && (k === HOST || party.guests.includes(k));
  }

  statusOf(k) {
    const p = this.P(k);
    if (this.isPlaying(k)) return 'playing';
    if (this.data.queue.includes(k)) return 'waiting';
    return p.state; // active(列外) | held | left | done | removed
  }

  positionText(k) {
    if (this.isPlaying(k)) return this.data.party ? 'パーティー参加中' : '対戦中';
    const i = this.data.queue.indexOf(k);
    return i >= 0 ? `待機 ${i + 1} 番目` : '待機列外';
  }

  // 次の試合を組むのに列から必要な人数
  slotsNeeded() { return this.settings.teamSize * 2 - (this._hostPinned() ? 1 : 0); }

  preview() {
    const d = this.data, s = this.settings, n = s.teamSize;
    if (this._isCoop()) {
      const g = s.coop.partySize - 1;
      const names = d.queue.map((k) => this.P(k).name);
      const grp = (arr) => (arr.length ? arr.join('・') : null);
      return {
        items: [
          { label: '次に入る人', text: grp(names.slice(0, g)) },
          { label: 'その次', text: grp(names.slice(g, 2 * g)) },
        ],
        note: null,
      };
    }
    if (!d.current) return null;
    const names = d.queue.map((k) => this.P(k).name);
    const grp = (arr) => (arr.length === n ? arr.join('・') : null);
    if (s.mode === 'winner') {
      const label = n === 1 ? '勝者' : '勝利チーム';
      const champTeam = d.champ && d.current.teams.find((t) => this.teamId(t) === d.champ);
      const exempt = s.hostPlay === 'champion' && champTeam && champTeam.includes(HOST);
      const note = champTeam && !exempt && d.streak + 1 >= s.maxStreak
        ? `${this.teamName(champTeam)} が勝つと${s.maxStreak}連勝で交代` : null;
      return {
        items: [
          { label: '次の対戦', a: label, b: grp(names.slice(0, n)) },
          { label: 'その次', a: label, b: grp(names.slice(n, 2 * n)) },
        ],
        note,
      };
    }
    // ローテーション：列の順に組んだ場合をシミュレーション
    let i = 0;
    const hostName = this.P(HOST).name;
    const next = () => {
      const a = this._hostPinned() ? [hostName] : [];
      while (a.length < n && i < names.length) a.push(names[i++]);
      const b = [];
      while (b.length < n && i < names.length) b.push(names[i++]);
      return a.length === n && b.length === n ? { a: a.join('・'), b: b.join('・') } : { a: null, b: null };
    };
    return { items: [{ label: '次の対戦', ...next() }, { label: 'その次', ...next() }], note: null };
  }

  announceText() {
    const party = this.data.party;
    if (party) {
      if (!party.guests.length) return '';
      return fill(this.settings.tpl.party, {
        no: party.no,
        target: party.target ? `${party.target} ／ ` : '',
        members: party.guests.map((k) => this.P(k).name).join('・'),
        next: this.data.queue[0] ? this.P(this.data.queue[0]).name : '（募集中）',
      });
    }
    const c = this.data.current;
    if (!c) return '';
    const n = this.settings.teamSize;
    const q = this.data.queue.slice(0, n).map((k) => this.P(k).name);
    return fill(this.settings.tpl.next, {
      no: c.no,
      p1: this.teamName(c.teams[0]),
      p2: this.teamName(c.teams[1]),
      next: q.length ? q.join('・') : '（募集中）',
    });
  }

  // ---------- 内部 ----------
  _changed() { this.emit('change'); }

  _snapshot() {
    const d = this.data;
    this.undoStack.push(JSON.stringify({ players: d.players, queue: d.queue, current: d.current, party: d.party, champ: d.champ, streak: d.streak, matchNo: d.matchNo, history: d.history }));
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  _take() { return this.data.queue.shift(); }

  _fill(prefill) {
    const t = prefill.slice();
    while (t.length < this.settings.teamSize && this.data.queue.length) t.push(this._take());
    return t;
  }

  _enqueueNew(k) {
    const q = this.data.queue;
    if (this.settings.memberPriority && this.P(k).member) {
      let i = 0;
      while (i < q.length && this.P(q[i]).member) i++;
      q.splice(i, 0, k);
    } else q.push(k);
  }

  // 試合を終えたプレイヤーを列に戻す
  _requeue(k) {
    if (!k) return;
    if (k === HOST) {
      if (this._hostQueued() && !this.data.queue.includes(HOST)) this.data.queue.push(HOST);
      return;
    }
    const p = this.P(k);
    if (p.leaveAfter) { p.leaveAfter = false; p.state = 'left'; return; }
    if (p.state !== 'active') return;
    if (!this.settings.rejoin) { p.state = 'done'; return; }
    if (!this.data.queue.includes(k)) this.data.queue.push(k);
  }

  // 列の先頭に戻す（試合が組めなかった・取りやめた時）
  _returnFront(keys) {
    for (const k of keys) {
      const p = this.P(k);
      if (k !== HOST && p.leaveAfter) { p.leaveAfter = false; p.state = 'left'; }
    }
    const back = keys.filter((k) => (k === HOST ? this._hostQueued() : this.P(k).state === 'active') && !this.data.queue.includes(k));
    this.data.queue.unshift(...back);
  }

  // stay: 勝ち残るチーム（なければ空）。組めたら true
  _buildMatch(stay) {
    const s = this.settings, d = this.data, n = s.teamSize;
    let teamA = stay.slice();
    if (teamA.length > n) { // 人数設定が減った場合は解散
      this._returnFront(teamA);
      teamA = [];
      d.champ = null; d.streak = 0;
    }
    const needHost = this._hostPinned() && !teamA.includes(HOST);
    const fromQueue = (n - teamA.length) + n - (needHost ? 1 : 0);
    if (d.queue.length < fromQueue) {
      this._returnFront(teamA);
      d.current = null;
      return false;
    }
    let teamB;
    if (teamA.length === 0) {
      teamA = this._fill(needHost ? [HOST] : []);
      teamB = this._fill([]);
    } else {
      teamA = this._fill(teamA);
      teamB = this._fill(needHost ? [HOST] : []);
    }
    d.matchNo++;
    d.current = { teams: [teamA, teamB], no: d.matchNo, startedAt: nowIso() };
    if (s.autoPost) this.emit('post', { kind: 'announce', text: this.announceText() });
    return true;
  }

  _tryStart() {
    if (this._isCoop()) { this._ensureParty(); this._fillParty(); return; }
    if (this.data.current) return;
    this._buildMatch([]);
  }

  // ---------- 協力プレイ（内部） ----------
  _newParty(guests = [], stays = {}, target = '') {
    const d = this.data;
    d.matchNo++;
    d.party = { no: d.matchNo, guests, stays, dead: [], reserved: 0, target, startedAt: nowIso() };
  }

  _ensureParty() {
    if (!this.data.party) this._newParty();
  }

  // 空き枠を列から補充する。reserved（死亡で空いた、次のプレイまで空けておく枠）は除く
  _fillParty({ announce = true } = {}) {
    const d = this.data, party = d.party;
    if (!party) return [];
    const added = [];
    while (party.guests.length + party.reserved < this.settings.coop.partySize - 1 && d.queue.length) {
      const k = this._take();
      party.guests.push(k);
      party.stays[k] = 0;
      added.push(k);
    }
    if (added.length && announce && this.settings.autoPost) this.emit('post', { kind: 'announce', text: this.announceText() });
    return added;
  }

  // パーティーを解散して全員を列の先頭へ（形式の切り替え時）
  _dissolveParty() {
    const party = this.data.party;
    if (!party) return;
    this.data.party = null;
    this._returnFront(party.guests);
  }

  // hostPlay の変更を列に反映
  _applyHostPlay() {
    const d = this.data;
    const q = d.queue.filter((k) => k !== HOST);
    if (this._isCoop()) { d.queue = q; return; } // 協力プレイでは配信者は常にパーティーにいる
    if (this._hostQueued() && !this.isPlaying(HOST)) {
      if (this.settings.hostPlay === 'champion') q.unshift(HOST);
      else q.push(HOST);
    }
    d.queue = q;
  }

  _validateId(k, id) {
    const s = this.settings;
    if (!id || id.length > s.gameIdMaxLength) return 'badId';
    if (s.gameIdPattern) {
      try { if (!new RegExp(s.gameIdPattern).test(id)) return 'badId'; } catch { /* 不正な正規表現は無視 */ }
    }
    const lower = id.toLowerCase();
    const dup = Object.values(this.data.players).some((p) => p.key !== k && p.state !== 'removed' && (p.gameId || '').toLowerCase() === lower);
    return dup ? 'dupId' : null;
  }

  // ---------- 参加者操作（戻り値 {ok, code, vars}） ----------
  join({ key, channelId = '', name, member = false }, rawId) {
    const s = this.settings, d = this.data;
    const cmd = s.commands.join[0];
    let p = this.P(key);
    if (!s.accepting) return { ok: false, code: 'closed', vars: {} };
    if (p && (d.queue.includes(key) || this.isPlaying(key))) return { ok: false, code: 'already', vars: { pos: this.positionText(key) } };
    const gameId = normalize(rawId) || (p && p.gameId) || '';
    if (!gameId) return { ok: false, code: 'needId', vars: { cmd } };
    const err = this._validateId(key, gameId);
    if (err) return { ok: false, code: err, vars: { id: gameId } };
    if (d.queue.length >= s.maxQueue) return { ok: false, code: 'full', vars: {} };
    if (!p) {
      p = d.players[key] = { key, channelId, name, gameId, member, w: 0, l: 0, joinedAt: nowIso(), state: 'active', leaveAfter: false };
    } else {
      Object.assign(p, { name, gameId, member: member || p.member, state: 'active', leaveAfter: false });
    }
    this._enqueueNew(key);
    const pos = d.queue.indexOf(key) + 1;
    this._tryStart();
    this._changed();
    return { ok: true, code: 'join', vars: { id: gameId, pos } };
  }

  addManual(name, gameId) {
    name = normalize(name);
    if (!name) return { ok: false, code: 'noName', vars: {} };
    const existing = Object.values(this.data.players).find((p) => p.key.startsWith('manual:') && p.name === name);
    const key = existing ? existing.key : `manual:${++this.data.seq}`;
    const wasAccepting = this.settings.accepting;
    this.settings.accepting = true; // 手動追加は受付締切中でも可
    try { return this.join({ key, name }, gameId); } finally { this.settings.accepting = wasAccepting; }
  }

  leave(k) {
    const p = this.P(k);
    if (!p || k === HOST) return { ok: false, code: 'notJoined', vars: { cmd: this.settings.commands.join[0] } };
    if (this.isPlaying(k)) { p.leaveAfter = true; this._changed(); return { ok: true, code: 'leaveAfter', vars: {} }; }
    this.data.queue = this.data.queue.filter((x) => x !== k);
    p.state = 'left';
    this._changed();
    return { ok: true, code: 'leave', vars: {} };
  }

  changeId(k, rawId) {
    const p = this.P(k);
    if (!p || k === HOST) return { ok: false, code: 'notJoined', vars: { cmd: this.settings.commands.join[0] } };
    const id = normalize(rawId);
    const err = this._validateId(k, id);
    if (err) return { ok: false, code: err, vars: { id } };
    p.gameId = id;
    this._changed();
    return { ok: true, code: 'idChanged', vars: { id } };
  }

  position(k) {
    if (!this.P(k) || k === HOST) return { ok: false, code: 'notJoined', vars: { cmd: this.settings.commands.join[0] } };
    return { ok: true, code: 'position', vars: { pos: this.positionText(k) } };
  }

  // ---------- チャット ----------
  parseCommand(text) {
    const t = normalize(text);
    const lower = t.toLowerCase();
    for (const [type, aliases] of Object.entries(this.settings.commands)) {
      for (const a of aliases) {
        const al = normalize(a).toLowerCase();
        if (!al) continue;
        if (lower.startsWith(al) && (lower.length === al.length || lower[al.length] === ' ')) {
          return { type, arg: t.slice(al.length).trim() };
        }
      }
    }
    return null;
  }

  // msg: { channelId, name, text, member }
  handleChat(msg) {
    const cmd = this.parseCommand(msg.text);
    if (!cmd) return null;
    const key = `yt:${msg.channelId}`;
    let r;
    switch (cmd.type) {
      case 'join': r = this.join({ key, channelId: msg.channelId, name: msg.name, member: !!msg.member }, cmd.arg); break;
      case 'leave': r = this.leave(key); break;
      case 'position': r = this.position(key); break;
      case 'changeId': r = this.changeId(key, cmd.arg); break;
      default: return null;
    }
    if (this.P(key) && msg.name) this.P(key).name = msg.name;
    this.emit('post', { kind: 'reply', text: fill(this.settings.tpl[r.code], { name: msg.name, ...r.vars }) });
    return cmd.type;
  }

  // ---------- 対戦進行 ----------
  // side: 1 = 左チームの勝ち, 2 = 右チームの勝ち
  result(side) {
    const d = this.data, s = this.settings;
    if (!d.current || (side !== 1 && side !== 2)) return false;
    this._snapshot();
    const { teams, no, startedAt } = d.current;
    const idx = side - 1;
    const win = teams[idx];
    const lose = teams[1 - idx];
    win.forEach((k) => this.P(k).w++);
    lose.forEach((k) => this.P(k).l++);
    d.history.unshift({
      no, mode: s.mode, startedAt, endedAt: nowIso(), method: 'manual',
      teams: clone(teams),
      names: teams.map((t) => t.map((k) => this.P(k).name)),
      ids: teams.map((t) => t.map((k) => this.P(k).gameId || '')),
      winSide: idx,
    });
    const wid = this.teamId(win);
    if (wid === d.champ) d.streak++;
    else { d.champ = wid; d.streak = 1; }

    let stay = [];
    let streakOut = null;
    d.current = null;
    if (s.mode === 'winner') {
      lose.forEach((k) => this._requeue(k));
      const exempt = s.hostPlay === 'champion' && win.includes(HOST);
      const capHit = !exempt && d.streak >= s.maxStreak;
      const leaving = win.some((k) => this.P(k).leaveAfter);
      if (capHit || leaving) {
        if (capHit) streakOut = { name: this.teamName(win), streak: d.streak };
        win.forEach((k) => this._requeue(k));
        d.champ = null; d.streak = 0;
      } else stay = win.slice();
    } else {
      teams.flat().forEach((k) => this._requeue(k));
      d.champ = null; d.streak = 0;
    }
    this._buildMatch(stay);
    this._changed();
    return { streakOut };
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    Object.assign(this.data, JSON.parse(snap));
    this._changed();
    return true;
  }

  // ---------- 協力プレイ ----------
  // プレイ終了。result: 'clear'（ボス撃破・クリア）| 'wipe'（配信者死亡で全滅・失敗）
  coopEnd(result) {
    const d = this.data, s = this.settings, party = d.party;
    if (!party || (result !== 'clear' && result !== 'wipe')) return false;
    this._snapshot();
    const members = [HOST, ...party.guests];
    for (const k of members) {
      const p = this.P(k);
      if (result === 'clear') p.clears = (p.clears || 0) + 1;
      else p.wipes = (p.wipes || 0) + 1;
    }
    d.history.unshift({
      type: 'coop', no: party.no, mode: 'coop', preset: s.coop.preset, startedAt: party.startedAt, endedAt: nowIso(), method: 'manual',
      result, target: party.target,
      members,
      names: members.map((k) => this.P(k).name),
      ids: members.map((k) => this.P(k).gameId || ''),
      deaths: party.dead.map((k) => this.P(k).name),
    });
    // 規定プレイ数に達したゲスト・離脱予定のゲストは列の最後尾へ
    const staying = [];
    const stays = {};
    const leaving = [];
    for (const k of party.guests) {
      const n = (party.stays[k] || 0) + 1;
      if ((s.coop.stayPlays > 0 && n >= s.coop.stayPlays) || this.P(k).leaveAfter) leaving.push(k);
      else { staying.push(k); stays[k] = n; }
    }
    d.party = null;
    leaving.forEach((k) => this._requeue(k));
    this._newParty(staying, stays, party.target);
    const added = this._fillParty({ announce: false });
    if (s.autoPost && (added.length || staying.length)) this.emit('post', { kind: 'announce', text: this.announceText() });
    this._changed();
    return { result, left: leaving.length };
  }

  // ゲストが死亡 → そのゲストはこのプレイから抜けて列の最後尾へ
  coopDeath(k) {
    const party = this.data.party;
    if (!party || !party.guests.includes(k)) return false;
    this._snapshot();
    const p = this.P(k);
    p.deaths = (p.deaths || 0) + 1;
    party.guests = party.guests.filter((x) => x !== k);
    delete party.stays[k];
    party.dead.push(k);
    if (this.settings.coop.refill === 'nextPlay') party.reserved++;
    this._requeue(k);
    this._fillParty();
    this._changed();
    return true;
  }

  // 空いている枠を今すぐ補充（次のプレイまで空けていた枠も含む）
  coopRefill() {
    const party = this.data.party;
    if (!party) return false;
    party.reserved = 0;
    const added = this._fillParty();
    this._changed();
    return added.length > 0;
  }

  setTarget(text) {
    const party = this.data.party;
    if (!party) return false;
    party.target = normalize(text).slice(0, 60);
    this._changed();
    return true;
  }

  // 対戦中・パーティー中のプレイヤーが不在 → 保留にして列の先頭の人と交代
  absent(k) {
    const d = this.data;
    if (d.party && d.party.guests.includes(k)) {
      this._snapshot();
      this.P(k).state = 'held';
      d.party.guests = d.party.guests.filter((x) => x !== k);
      delete d.party.stays[k];
      this._fillParty();
      this._changed();
      return true;
    }
    if (!d.current || !this.isPlaying(k) || k === HOST) return false;
    this._snapshot();
    this.P(k).state = 'held';
    const team = d.current.teams.find((t) => t.includes(k));
    if (d.champ === this.teamId(team)) { d.champ = null; d.streak = 0; }
    const rep = this._take();
    if (rep) {
      team[team.indexOf(k)] = rep;
      if (this.settings.autoPost) this.emit('post', { kind: 'announce', text: this.announceText() });
    } else {
      const others = d.current.teams.flat().filter((x) => x !== k);
      d.current = null;
      d.matchNo--;
      this._returnFront(others);
    }
    this._changed();
    return true;
  }

  // 現在の対戦を取りやめて全員を列の先頭に戻す
  cancelMatch() {
    const d = this.data;
    if (!d.current) return false;
    this._snapshot();
    const all = d.current.teams.flat();
    d.current = null;
    d.matchNo--;
    this._returnFront(all);
    this._changed();
    return true;
  }

  startNext() {
    this._tryStart();
    this._changed();
    return !!this.data.current;
  }

  // 配信者を列に入れる（hostPlay が queue / champion の時）
  hostJoin() {
    if (!this._hostQueued() || this.isPlaying(HOST) || this.data.queue.includes(HOST)) return false;
    if (this.settings.hostPlay === 'champion') this.data.queue.unshift(HOST);
    else this.data.queue.push(HOST);
    this._tryStart();
    this._changed();
    return true;
  }

  hold(k) {
    const p = this.P(k);
    if (!p || this.isPlaying(k)) return false;
    this.data.queue = this.data.queue.filter((x) => x !== k);
    if (k !== HOST) p.state = 'held';
    this._changed();
    return true;
  }

  resume(k) {
    const p = this.P(k);
    if (!p || k === HOST || this.isPlaying(k)) return false;
    p.state = 'active';
    p.leaveAfter = false;
    if (!this.data.queue.includes(k)) this.data.queue.push(k);
    this._tryStart();
    this._changed();
    return true;
  }

  remove(k) {
    const p = this.P(k);
    if (!p || k === HOST || this.isPlaying(k)) return false;
    this.data.queue = this.data.queue.filter((x) => x !== k);
    p.state = 'removed';
    this._changed();
    return true;
  }

  moveTop(k) {
    if (!this.data.queue.includes(k)) return false;
    this.data.queue = [k, ...this.data.queue.filter((x) => x !== k)];
    this._changed();
    return true;
  }

  reorder(keys) {
    const q = this.data.queue;
    if (!Array.isArray(keys) || keys.length !== q.length || !keys.every((k) => q.includes(k))) return false;
    this.data.queue = keys.slice();
    this._changed();
    return true;
  }

  setGameId(k, id) {
    return this.changeId(k, id);
  }

  updateSettings(patch) {
    const prevHostPlay = this.settings.hostPlay;
    const prevFormat = this.settings.format;
    const prevPreset = this.settings.coop.preset;
    mergeDeep(this.settings, patch);
    const s = this.settings;
    const d = this.data;
    if (!MODES[s.mode]) s.mode = 'winner';
    if (!HOST_PLAY[s.hostPlay]) s.hostPlay = 'off';
    if (s.format !== 'coop') s.format = 'versus';
    if (!COOP_PRESETS[s.coop.preset]) s.coop.preset = 'souls';
    // ゲームを切り替えたら人数もそのゲームの既定値に（人数を同時に指定した場合を除く）
    if (prevPreset !== s.coop.preset && !(patch.coop && patch.coop.partySize)) s.coop.partySize = COOP_PRESETS[s.coop.preset].partySize;
    s.coop.partySize = Math.min(4, Math.max(2, Number(s.coop.partySize) || 3));
    s.teamSize = s.teamSize === 2 ? 2 : 1;
    if (s.maxStreak < 1) s.maxStreak = 1;
    this.P(HOST).name = s.hostName;

    if (prevFormat !== s.format) {
      if (s.format === 'coop') {
        if (d.current) { const all = d.current.teams.flat(); d.current = null; d.matchNo--; this._returnFront(all); }
        d.champ = null; d.streak = 0;
      } else {
        this._dissolveParty();
      }
      this._applyHostPlay();
    } else if (prevHostPlay !== s.hostPlay) {
      this._applyHostPlay();
    }
    // 人数を減らした場合は溢れたゲストを列の先頭へ
    if (d.party) {
      const cap = s.coop.partySize - 1;
      if (d.party.guests.length > cap) this._returnFront(d.party.guests.splice(cap));
      d.party.reserved = Math.min(d.party.reserved, Math.max(0, cap - d.party.guests.length));
    }
    this._tryStart();
    this._changed();
    return s;
  }

  // 新しい配信回を始める。古いデータを返す（アーカイブ用）
  newSession() {
    const old = this.data;
    this.data = freshData(this.settings.hostName);
    this.undoStack = [];
    this._applyHostPlay();
    this._tryStart();
    this._changed();
    return old;
  }

  // ---------- 出力 ----------
  toJSON() { return { settings: this.settings, data: this.data }; }

  // OBS オーバーレイ用（チャンネル ID 等を含めない）
  publicState() {
    const d = this.data, s = this.settings;
    const mask = (id) => (!id ? '' : s.overlay.maskId ? id.slice(0, 3) + '***' : id);
    const pl = (k) => ({ name: this.P(k).name, gameId: k === HOST ? '' : mask(this.P(k).gameId) });
    const champTeam = d.current && d.champ && s.mode === 'winner' ? d.current.teams.find((t) => this.teamId(t) === d.champ) : null;
    const party = d.party;
    return {
      format: s.format,
      coop: party ? {
        no: party.no,
        target: party.target,
        labels: this.coopLabels(),
        members: [HOST, ...party.guests].map(pl),
        open: Math.max(0, s.coop.partySize - 1 - party.guests.length),
        dead: party.dead.map((k) => this.P(k).name),
      } : null,
      mode: s.mode,
      modeName: MODES[s.mode],
      teamSize: s.teamSize,
      accepting: s.accepting,
      joinCmd: s.commands.join[0],
      overlay: s.overlay,
      current: d.current ? { no: d.current.no, teams: d.current.teams.map((t) => t.map(pl)) } : null,
      champ: champTeam ? { name: this.teamName(champTeam), streak: d.streak } : null,
      queue: d.queue.slice(0, 10).map((k) => ({ name: this.P(k).name })),
      queueCount: d.queue.length,
    };
  }

  historyCsv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['番号', '形式', '人数', '開始', '終了', 'チームA / パーティー', 'ID', 'チームB', 'チームB ID', '結果', 'ボス・ミッション', '死亡', '判定']];
    for (const h of this.data.history.slice().reverse()) {
      const method = h.method === 'manual' ? '手動' : h.method;
      if (h.type === 'coop') {
        const lb = COOP_PRESETS[h.preset] || COOP_PRESETS.souls;
        rows.push([h.no, '協力', `${h.names.length}人`, h.startedAt, h.endedAt, h.names.join('・'), h.ids.join('・'), '', '',
          h.result === 'clear' ? lb.clear : lb.wipe, h.target, h.deaths.join('・'), method]);
        continue;
      }
      const n = h.names[0].length;
      rows.push([h.no, MODES[h.mode] || h.mode, `${n}対${n}`, h.startedAt, h.endedAt,
        h.names[0].join('・'), h.ids[0].join('・'), h.names[1].join('・'), h.ids[1].join('・'),
        `${h.names[h.winSide].join('・')} の勝ち`, '', '', method]);
    }
    return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }
}

module.exports = { Engine, HOST, MODES, HOST_PLAY, COOP_PRESETS, DEFAULT_SETTINGS, fill, normalize };
