'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Engine, COOP_PRESETS } = require('./engine');
const { Store } = require('./store');
const { Poster } = require('./poster');
const { LocalServer } = require('./server');
const { YouTube } = require('./youtube');

// 開発用：データ保存先の切り替え（動作確認で本番データを汚さないため）
if (process.env.MATCHQUEUE_USERDATA) app.setPath('userData', process.env.MATCHQUEUE_USERDATA);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let store, engine, poster, server, yt;
const chatLog = []; // 画面表示用の直近チャット（保存しない）

// ---------- 画面への送信 ----------
let pushTimer = null;
function snapshot() {
  return {
    settings: engine.settings,
    data: engine.data,
    preview: engine.preview(),
    coopPresets: COOP_PRESETS,
    announceText: engine.announceText(),
    canUndo: engine.undoStack.length > 0,
    chat: chatLog,
    botLog: poster.log,
    botPending: poster.pending(),
    youtube: yt.status(),
    server: { url: server.baseUrl(), error: server.error },
  };
}
function pushToUi() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
  }, 30);
}

let chatSeq = 0;
function addChat(entry) {
  chatLog.push({ id: ++chatSeq, at: new Date().toISOString(), ...entry });
  if (chatLog.length > 300) chatLog.shift();
  pushToUi();
}

function secretBox() {
  const enc = safeStorage.isEncryptionAvailable();
  return {
    encrypt: (s) => (enc ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + Buffer.from(s).toString('base64')),
    decrypt: (s) => {
      if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString();
      throw new Error('bad secret');
    },
  };
}

// ---------- 初期化 ----------
async function init() {
  store = new Store(app.getPath('userData'));
  engine = new Engine(store.load('state.json', {}));

  server = new LocalServer({
    getPublicState: () => engine.publicState(),
    onOAuthCallback: (params) => yt.handleCallback(params),
  });
  await server.listen(engine.settings.server.port);

  yt = new YouTube({
    store,
    secret: secretBox(),
    openExternal: (url) => shell.openExternal(url),
    getRedirectUri: () => (server.baseUrl() ? `${server.baseUrl()}/oauth/callback` : null),
  });

  poster = new Poster({
    send: (text) => yt.post(text),
    canSend: () => yt.canPost(),
    getSettings: () => engine.settings.post,
  });

  engine.on('change', () => {
    store.save('state.json', () => engine.toJSON());
    server.broadcast();
    pushToUi();
  });
  engine.on('post', ({ kind, text }) => {
    // 未接続時は実際には送られないので、画面上だけで返答内容を見せる
    if (!yt.canPost()) addChat({ name: 'MatchQueue（未送信）', text, kind: 'bot' });
    poster.enqueue(kind, text);
  });
  poster.on('change', pushToUi);
  yt.on('status', pushToUi);
  yt.on('message', (m) => {
    if (m.self && /^[@【]/.test(m.text)) { addChat({ name: m.name, text: m.text, kind: 'bot' }); return; }
    const cmd = engine.parseCommand(m.text);
    addChat({ name: m.name, text: m.text, kind: cmd ? 'cmd' : 'normal', tag: cmd && cmd.type, member: m.member });
    engine.handleChat(m);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1014',
    title: 'MatchQueue',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------- 画面からの操作 ----------
const actions = {
  // 進行
  result: (side) => engine.result(side),
  undo: () => engine.undo(),
  absent: (key) => engine.absent(key),
  hostJoin: () => engine.hostJoin(),
  // 協力プレイ
  coopEnd: (result) => engine.coopEnd(result),
  coopDeath: (key) => engine.coopDeath(key),
  coopRefill: () => engine.coopRefill(),
  setTarget: (text) => engine.setTarget(text),
  cancelMatch: () => engine.cancelMatch(),
  startNext: () => engine.startNext(),
  postAnnounce: () => {
    if (!yt.canPost()) return { ok: false, message: 'YouTube のライブチャットに接続していません' };
    poster.enqueue('announce', engine.announceText());
    return { ok: true };
  },
  // 参加者
  addManual: (name, gameId) => engine.addManual(name, gameId),
  hold: (k) => engine.hold(k),
  resume: (k) => engine.resume(k),
  remove: (k) => engine.remove(k),
  moveTop: (k) => engine.moveTop(k),
  reorder: (keys) => engine.reorder(keys),
  setGameId: (k, id) => engine.setGameId(k, id),
  // テスト用：YouTube を使わずにチャットコマンドを試す
  testChat: (name, text) => {
    const cmd = engine.parseCommand(text);
    addChat({ name, text, kind: cmd ? 'cmd' : 'normal', tag: cmd && cmd.type, test: true });
    return engine.handleChat({ channelId: `test-${name}`, name, text, member: false });
  },
  // 設定
  updateSettings: async (patch) => {
    const s = engine.updateSettings(patch);
    if (patch && patch.server && patch.server.port) await server.restart(Number(patch.server.port));
    pushToUi();
    return s;
  },
  newSession: () => {
    store.flush('state.json', engine.toJSON());
    const old = engine.newSession();
    const f = store.archiveSession(old);
    poster.clear();
    return { archived: f };
  },
  exportCsv: async () => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `matchqueue-${engine.data.sessionId}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, engine.historyCsv(), 'utf8');
    return r.filePath;
  },
  openSessionsFolder: () => shell.openPath(store.sessionsDir()),
  openOverlay: () => server.baseUrl() && shell.openExternal(`${server.baseUrl()}/overlay`),
  copy: (text) => clipboard.writeText(String(text)),
  openExternal: (url) => /^https:\/\//.test(url) && shell.openExternal(url),
  // YouTube
  ytSetClient: (id, secret) => yt.setClient(id, secret),
  ytLogin: () => yt.beginAuth(),
  ytLogout: () => yt.logout(),
  ytListBroadcasts: () => yt.listBroadcasts(),
  ytResolveVideo: (input) => yt.resolveVideo(input),
  ytConnect: (info) => yt.connectChat(info),
  ytDisconnect: () => { yt.disconnectChat(); poster.clear(); },
  ytSetMinPoll: (sec) => yt.setMinPollSec(sec),
};

ipcMain.handle('get-state', () => snapshot());
ipcMain.handle('action', async (_e, name, args) => {
  const fn = actions[name];
  if (!fn) return { error: `unknown action: ${name}` };
  try {
    const value = await fn(...(Array.isArray(args) ? args : []));
    pushToUi();
    return { value: value === undefined ? null : value };
  } catch (e) {
    return { error: e.message };
  }
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  await init();
  createWindow();
  // 開発用：自動操作してスクリーンショットを撮る（scripts/smoke.js）
  if (process.env.MATCHQUEUE_SMOKE) {
    require(path.join(__dirname, '..', '..', 'scripts', 'smoke.js'))({ app, win, actions, engine, server });
  }
});

app.on('window-all-closed', () => {
  try { store.flush('state.json', engine.toJSON()); } catch (e) { console.error(e); }
  yt.disconnectChat();
  poster.stop();
  server.close();
  app.quit();
});
