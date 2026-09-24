'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '');

// 対戦形式の選択肢（設定キー → 値 → 説明）
const CHOICES = {
  format: {
    el: '#formats',
    items: {
      versus: { name: '対戦', desc: '1対1・2対2 で視聴者と（または視聴者同士で）対戦。', flow: 'A vs B' },
      coop: { name: '協力プレイ', desc: 'あなたのパーティーに視聴者が入って一緒にボス・ミッションに挑む。', flow: 'あなた＋A＋B → ボス撃破 → あなた＋C＋D' },
    },
  },
  'coop.preset': { el: '#presets', items: {} }, // 起動後にゲーム一覧から作る
  'coop.partySize': {
    el: '#partySizes',
    items: {
      2: { name: '2人', desc: 'あなた＋ゲスト1人。', flow: '' },
      3: { name: '3人', desc: 'あなた＋ゲスト2人。', flow: '' },
      4: { name: '4人', desc: 'あなた＋ゲスト3人。', flow: '' },
    },
  },
  'coop.stayPlays': {
    el: '#stayPlays',
    items: {
      1: { name: '1プレイで交代', desc: 'クリアでも全滅でも、1プレイ終わったら列の最後尾へ。', flow: '' },
      2: { name: '2プレイ', desc: '2プレイ続けて参加してから交代。', flow: '' },
      3: { name: '3プレイ', desc: '3プレイ続けて参加してから交代。', flow: '' },
      0: { name: '死亡するまで', desc: '死亡（または辞退）するまで参加し続ける。', flow: '' },
    },
  },
  'coop.refill': {
    el: '#refills',
    items: {
      nextPlay: { name: '次のプレイから補充', desc: 'ボス戦中など途中参加できない場面向け。「今すぐ補充」ボタンでも入れられる。', flow: '' },
      immediate: { name: 'すぐ補充', desc: '列の先頭の人をすぐにパーティーへ呼ぶ。', flow: '' },
    },
  },
  teamSize: {
    el: '#teamSizes',
    items: {
      1: { name: '1対1', desc: '1人ずつ対戦。', flow: 'A vs B' },
      2: { name: '2対2', desc: '列の順に2人ずつチームを組む（1・2番 vs 3・4番）。', flow: 'A・B vs C・D' },
    },
  },
  mode: {
    el: '#modes',
    items: {
      winner: { name: '勝ち抜き', desc: '勝った側が残り、負けた側は列の最後尾へ。連勝上限に達したら勝った側も交代。', flow: 'A vs B → 勝者 vs C → 勝者 vs D …' },
      rotation: { name: 'ローテーション', desc: '試合が終わったら全員最後尾へ。出番が均等。', flow: 'A vs B → C vs D → A vs B …' },
    },
  },
  hostPlay: {
    el: '#hostPlays',
    items: {
      off: { name: '参加しない', desc: '視聴者同士で対戦。', flow: '' },
      always: { name: '毎試合出る', desc: 'あなたは毎試合出場。ローテーションなら「あなた vs 列の先頭」（2対2 なら あなた＋先頭 vs 次の2人）。', flow: '配信者 vs A → 配信者 vs B …' },
      queue: { name: '列に並ぶ', desc: '視聴者と同じく列に並び、順番が来たら出場。', flow: '' },
      champion: { name: '勝ち抜きの王者役', desc: '列の先頭から出場し、勝ち続ける限り連勝上限なしで残る。負けたら列の最後尾へ。', flow: '配信者 vs A → 配信者 vs B → （負け）B vs C …' },
    },
  },
};
const MODES = CHOICES.mode.items;
const NUM_KEYS = new Set(['teamSize', 'coop.partySize', 'coop.stayPlays']);
const STATUS = { playing: '対戦中', waiting: '待機', held: '保留', left: '辞退', done: '終了', removed: '除外', active: '—' };
const TAGS = { join: '参加', leave: '辞退', position: '順番', changeId: 'ID' };
const CODE_MSG = {
  join: '追加しました', needId: 'ゲーム内IDを入力してください', dupId: 'そのIDは他の参加者が登録済みです',
  badId: 'ゲーム内IDの形式が正しくありません', full: '待機列が満員です', already: '既に参加中です',
  noName: '名前を入力してください', idChanged: 'IDを変更しました', notJoined: '参加者が見つかりません',
};
const TPL_LABELS = {
  next: '次の対戦（告知）',
  party: '協力パーティー（告知）', join: '参加受付', needId: 'IDなしで参加', already: '参加済み', closed: '受付終了中',
  full: '満員', badId: 'ID 形式エラー', dupId: 'ID 重複', position: '順番確認', notJoined: '未参加',
  leave: '辞退', leaveAfter: '対戦中の辞退', idChanged: 'ID 変更',
};
const LOG_STATUS = { sent: '送信', failed: '失敗', skipped: '未送信', replaced: '置換' };

let S = null;
let dragKey = null;
let editingKey = null;
let broadcasts = [];

// ---------- 共通 ----------
let toastTimer;
function toast(m) {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function act(name, ...args) {
  const r = await window.api.act(name, ...args);
  if (r.error) toast(r.error);
  return r;
}

const P = (k) => S.data.players[k];
const getPath = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function setPath(path, value) {
  const keys = path.split('.');
  const root = {};
  let o = root;
  keys.slice(0, -1).forEach((k) => { o = o[k] = {}; });
  o[keys[keys.length - 1]] = value;
  return root;
}
function isPlaying(k) { const c = S.data.current; return !!c && c.teams.some((t) => t.includes(k)); }
const teamName = (t) => t.map((k) => P(k).name).join('・');
const isCoop = () => S.settings.format === 'coop';
const labels = () => S.coopPresets[S.settings.coop.preset] || Object.values(S.coopPresets)[0];
function statText(p) {
  return isCoop() ? `クリア${p.clears || 0}・死亡${p.deaths || 0}` : `${p.w}勝${p.l}敗`;
}
const teamId = (t) => t.slice().sort().join('+');
function statusOf(k) {
  if (isPlaying(k)) return 'playing';
  if (S.data.queue.includes(k)) return 'waiting';
  return P(k).state;
}
function fillIfIdle(el, v) { if (document.activeElement !== el && el.value !== String(v ?? '')) el.value = v ?? ''; }

// ---------- 描画 ----------
function render() {
  if (!S) return;
  renderHeader();
  if (!dragKey) renderQueue();
  renderMatch();
  renderNext();
  renderBot();
  renderChat();
  if (!editingKey) renderPlayers();
  renderHistory();
  renderModes();
  renderSettings();
  renderYt();
  renderOneComme();
  renderOverlay();
}

function renderOneComme() {
  const o = S.onecomme;
  let st;
  if (o.connected) st = `<span class="ok">● 受信中</span>（最終 ${hhmm(o.lastSeenAt)}・受信 ${o.count} 件${o.pluginVersion ? `・プラグイン v${esc(o.pluginVersion)}` : ''}）`;
  else if (o.installed) st = 'プラグインは入っています。わんコメ側で有効にし、わんコメを起動してください';
  else if (o.oneCommeFound) st = 'プラグイン未インストール';
  else if (o.legacyOnly) st = '<span class="err">古いわんコメ（4.x 以前）です。プラグイン機能はわんコメ 5.2 以降で使えるため、最新版に更新してください</span>';
  else st = 'わんコメが見つかりません（インストールして一度起動してください）';
  $('#ocStatus').innerHTML = st;
  $('#ocInstallBtn').textContent = o.installed ? 'プラグインを入れ直す' : 'わんコメにプラグインを入れる';
}

function renderHeader() {
  const y = S.youtube;
  const pill = $('#ytPill');
  const chatOn = y.chat.state === 'connected';
  const ocOn = S.onecomme.connected;
  pill.className = 'yt-pill' + (chatOn || ocOn ? ' on' : y.authorized ? ' warn' : '');
  pill.querySelector('span').textContent = chatOn ? (ocOn ? 'チャット取得中（YouTube＋わんコメ）' : 'チャット取得中') : ocOn ? 'わんコメ連携中'
    : y.chat.state === 'connecting' ? 'チャット接続中…' : y.authorized ? 'チャット未接続' : 'チャット未接続';
  $('#streamTitle').textContent = y.chat.title || '';
  const players = Object.values(S.data.players).filter((p) => p.key !== 'host' && p.state !== 'removed');
  $('#hCount').textContent = players.length;
  $('#hQueue').textContent = S.data.queue.length;
  $('#hMatches').textContent = S.data.history.length;
  $('#hMatchesLabel').textContent = isCoop() ? 'プレイ' : '試合';
  $('#acceptSw').classList.toggle('on', S.settings.accepting);
  $('#qCount').textContent = S.data.queue.length + '人';
  const c = S.settings.commands;
  $('#cmdHint').innerHTML = `参加：<code>${esc(c.join[0])} ゲーム内ID</code><br>辞退：<code>${esc(c.leave[0])}</code>　順番：<code>${esc(c.position[0])}</code>　ID修正：<code>${esc(c.changeId[0])} 新ID</code>`
    + (S.settings.accepting ? '' : '<br><span class="err">現在は受付を締め切っています</span>');
}

function renderQueue() {
  const q = S.data.queue;
  $('#queue').innerHTML = q.length ? q.map((k, i) => {
    const p = P(k);
    return `<li draggable="true" data-key="${esc(k)}"><span class="n">${i + 1}</span>
      <div class="who"><div>${esc(p.name)} ${p.member ? '<span class="tag mem">メンバー</span>' : ''}${k === 'host' ? '<span class="tag bot">あなた</span>' : ''}</div>
      <div class="small mute">${k === 'host' ? '' : esc(p.gameId) + '・'}${statText(p)}</div></div>
      <button class="x" title="保留にする" data-act="hold" data-args="${esc(JSON.stringify([k]))}">✕</button></li>`;
  }).join('') : '<li class="empty">待機中の参加者はいません</li>';
}

function sideHtml(team, cls) {
  const d = S.data;
  const st = S.settings.mode === 'winner' && d.champ === teamId(team) && d.streak > 0 ? `<span class="streak">${d.streak}連勝中</span>` : '';
  const mems = team.map((k) => {
    const p = P(k);
    return `<div class="mem"><div class="nm">${esc(p.name)}</div>
      ${p.gameId ? `<div class="ign" title="ゲーム内ID（ダブルクリックで選択）">${esc(p.gameId)}</div>` : ''}
      <div class="rec">この配信 ${p.w}勝 ${p.l}敗</div>
      ${p.leaveAfter ? '<div class="leaving">この試合の後に抜けます</div>' : ''}
      ${k === 'host' ? '' : `<div class="memact"><button class="btn" data-act="absent" data-args="${esc(JSON.stringify([k]))}" title="保留にして列の先頭の人と交代">不在 → 交代</button></div>`}</div>`;
  }).join('');
  return `<div class="side ${cls}${team.length > 1 ? ' duo' : ''}">${st}${mems}</div>`;
}

function slotsNeeded() { return S.settings.teamSize * 2 - (S.settings.hostPlay === 'always' ? 1 : 0); }

function renderParty() {
  const party = S.data.party;
  const lb = labels();
  const size = S.settings.coop.partySize;
  const stay = S.settings.coop.stayPlays;
  $('#coopHead').innerHTML = `<span class="tag bot">NOW</span><span class="no">第 ${party ? party.no : '-'} プレイ</span><span class="tag mode">協力・${esc(lb.name)}・${size}人</span>`;
  $('#targetLabel').textContent = lb.target;
  fillIfIdle($('#targetInput'), party ? party.target : '');
  $('#targetInput').disabled = !party;
  if (!party) { $('#partyBox').innerHTML = ''; $('#coopBtns').innerHTML = ''; return; }

  const card = (k) => {
    const p = P(k);
    if (k === 'host') return `<div class="pcard host"><div class="nm">${esc(p.name)}</div><div class="rec">ホスト・${statText(p)}</div></div>`;
    const plays = stay > 1 ? `・${(party.stays[k] || 0) + 1}/${stay}プレイ目` : '';
    return `<div class="pcard"><div class="nm">${esc(p.name)}</div>
      <div class="ign" title="ゲーム内ID（ダブルクリックで選択）">${esc(p.gameId)}</div>
      <div class="rec">${statText(p)}${plays}</div>
      ${p.leaveAfter ? '<div class="leaving">このプレイの後に抜けます</div>' : ''}
      <div class="acts"><button class="btn death" data-act="coopDeath" data-args="${esc(JSON.stringify([k]))}">${esc(lb.death)}</button>
      <button class="btn" data-act="absent" data-args="${esc(JSON.stringify([k]))}" title="保留にして列の先頭の人と交代">不在 → 交代</button></div></div>`;
  };
  const open = size - 1 - party.guests.length;
  const empties = Array.from({ length: Math.max(0, open) }, (_, i) => {
    const reserved = i < party.reserved;
    return `<div class="pcard empty">空き<div class="small">${reserved ? '次のプレイから補充' : '参加者待ち'}</div>
      ${reserved && S.data.queue.length ? '<button class="btn sm" data-act="coopRefill" style="margin-top:8px">今すぐ補充</button>' : ''}</div>`;
  });
  $('#partyBox').style.gridTemplateColumns = `repeat(${size}, minmax(0, 1fr))`;
  $('#partyBox').innerHTML = ['host', ...party.guests].map(card).join('') + empties.join('');
  $('#deadLine').textContent = party.dead.length ? `このプレイで${lb.death}：${party.dead.map((k) => P(k).name).join('、')}` : '';
  $('#coopBtns').innerHTML = `<button class="win clear" data-act="coopEnd" data-args='["clear"]'>✔ ${esc(lb.clear)}<kbd>1</kbd></button>
    <button class="win wipe" data-act="coopEnd" data-args='["wipe"]'>✖ ${esc(lb.wipe)}<kbd>2</kbd></button>`;
  $('#coopUndo').disabled = !S.canUndo;
}

function renderMatch() {
  const coop = isCoop();
  $('#qVersus').hidden = coop;
  $('#qCoop').hidden = !coop;
  $('#match').hidden = coop;
  $('#coopView').hidden = !coop;
  const sel = $('#presetSelect');
  if (sel.options.length !== Object.keys(S.coopPresets).length) {
    sel.innerHTML = Object.entries(S.coopPresets).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  }
  if (coop) { renderParty(); return; }
  const c = S.data.current;
  const hp = S.settings.hostPlay;
  $('#hostJoinBtn').hidden = !((hp === 'queue' || hp === 'champion') && !isPlaying('host') && !S.data.queue.includes('host'));
  if (!c) {
    const needed = slotsNeeded();
    const can = S.data.queue.length >= needed;
    $('#match').innerHTML = `<div class="emptymatch">${can ? '対戦を組めます。' : `対戦できる参加者が足りません（あと ${needed - S.data.queue.length} 人）。<br>チャットの参加表明を待っています…`}
      ${can ? '<br><button class="btn primary" data-act="startNext">次の対戦を組む</button>' : ''}
      ${S.canUndo ? '<br><button class="btn" data-act="undo">↶ 直前の操作を取り消し</button>' : ''}</div>`;
    return;
  }
  const [a, b] = c.teams;
  const n = a.length;
  $('#match').innerHTML = `<div class="mhead"><span class="tag bot">NOW</span><span class="no">第 ${c.no} 試合</span><span class="tag mode">${n}対${n}・${MODES[S.settings.mode].name}</span></div>
    <div class="vs">${sideHtml(a, 'p1')}<div class="vsmark">VS</div>${sideHtml(b, 'p2')}</div>
    <div class="winbtns"><button class="win p1" data-act="result" data-args="[1]">◀ ${esc(teamName(a))} の勝ち<kbd>1</kbd></button><div></div>
    <button class="win p2" data-act="result" data-args="[2]">${esc(teamName(b))} の勝ち ▶<kbd>2</kbd></button></div>
    <div class="subacts">
      <button class="btn" data-act="undo" ${S.canUndo ? '' : 'disabled'}>↶ 直前の結果を取り消し</button>
      <button class="btn" data-act="cancelMatch">対戦を取りやめ（全員を列の先頭へ）</button>
    </div>`;
}

function renderNext() {
  const pv = S.preview;
  $('#nextTitle').textContent = isCoop() ? 'この先のパーティー' : 'この先の対戦';
  if (!pv) { $('#next').innerHTML = '<div class="mute small">—</div>'; return; }
  const pair = (x) => ('text' in x ? (x.text ? esc(x.text) : '<span>—</span>') : x.a && x.b ? `${esc(x.a)}<span>vs</span>${esc(x.b)}` : x.b || x.a ? `${esc(x.a || x.b)}<span>vs</span>募集中` : '<span>—</span>');
  $('#next').innerHTML = pv.items.map((x) => `<div class="nextcard"><div class="lbl">${x.label}</div><div class="pair">${pair(x)}</div></div>`).join('')
    + (pv.note ? `<div class="note">${esc(pv.note)}</div>` : '');
}

const CAND_KIND = { announce: '告知', reply: '返信' };

// 通知音（音声ファイルを使わず Web Audio で「ピンポン」と鳴らす）
let audioCtx = null;
function chime() {
  window.chimeCount = (window.chimeCount || 0) + 1; // 動作確認用（scripts/smoke.js）
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const vol = Math.max(0, Math.min(1, Number(S.settings.sound.volume) || 0.5)) * 0.4;
    [[880, 0], [1320, 0.13]].forEach(([freq, delay]) => {
      const t = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch { /* 音が出せない環境では何もしない */ }
}

// 新しい投稿候補が増えたら鳴らす（起動直後の既存分では鳴らさない）
let lastCandId = null;
function checkNewCandidates() {
  const maxId = S.candidates.reduce((m, c) => Math.max(m, c.id), 0);
  if (lastCandId !== null && maxId > lastCandId && !S.canPost && S.settings.sound.candidate) chime();
  lastCandId = Math.max(lastCandId || 0, maxId);
}

function renderBot() {
  checkNewCandidates();
  const canPost = S.canPost;
  $$('[data-autopost]').forEach((cb) => { cb.checked = S.settings.autoPost; });
  $('#candTitle').textContent = `投稿候補${S.candidates.length ? `（${S.candidates.length}）` : ''}`;
  $('#apiPost').hidden = !canPost;
  $('#copyPost').hidden = canPost;
  if (!canPost) {
    $('#candList').innerHTML = S.candidates.length
      ? S.candidates.slice().reverse().map((c) => `<li class="${c.copied ? 'copied' : ''}">
          <span class="tag ${c.kind === 'announce' ? 'bot' : 'join'}">${CAND_KIND[c.kind] || c.kind}</span>
          <span class="ct">${esc(c.text)}</span>
          <button class="btn sm${c.copied ? '' : ' primary'}" data-act="copyCandidate" data-args="[${c.id}]">${c.copied ? 'もう一度コピー' : 'コピー'}</button>
          <button class="x" title="候補から消す" data-act="removeCandidate" data-args="[${c.id}]">✕</button></li>`).join('')
      : '<li class="empty">投稿候補はありません。対戦が決まったり受付の返信が出ると、ここに並びます。</li>';
    return;
  }
  $('#botPrev').textContent = S.announceText || '対戦が決まると、ここに告知文が表示されます。';
  $('#botInfo').textContent = (S.settings.autoPost ? '対戦が決まると自動で投稿します' : '手動投稿モード') + (S.botPending ? `・送信待ち ${S.botPending} 件` : '');
  $('#botLog').innerHTML = S.botLog.slice(0, 6).map((l) => `<li title="${esc(l.note || l.text)}"><span>${hhmm(l.at)}</span><span class="s-${l.status}">${LOG_STATUS[l.status] || l.status}</span><span>${esc(l.text)}</span></li>`).join('');
}

let chatLastId = -1;
// 自分で上にスクロールしていない限り、最新のチャットに追従する
let chatStick = true;
$('#chatBox').addEventListener('scroll', () => {
  const box = $('#chatBox');
  chatStick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
});
new ResizeObserver(() => { if (chatStick) $('#chatBox').scrollTop = $('#chatBox').scrollHeight; }).observe($('#chatBox'));
function renderChat() {
  const box = $('#chatBox');
  const stick = chatStick;
  const y = S.youtube.chat;
  $('#chatInfo').textContent = S.onecomme.connected && y.state !== 'connected' ? 'わんコメから受信中'
    : { idle: '未接続', connecting: '接続中…', connected: 'コマンド検出中', ended: '配信終了', error: 'エラー' }[y.state] || y.state;
  const lastId = S.chat.length ? S.chat[S.chat.length - 1].id : 0;
  if (lastId === chatLastId) return;
  chatLastId = lastId;
  $('#chat').innerHTML = S.chat.length ? S.chat.map((m) => {
    const tg = m.kind === 'bot' ? '<span class="tag bot">BOT</span>' : m.tag ? `<span class="tag ${m.tag}">${TAGS[m.tag] || m.tag}</span>` : '';
    return `<div class="msg ${m.kind}"><span class="u">${esc(m.name)}</span>${esc(m.text)}${tg}${m.test ? '<span class="tag test">テスト</span>' : ''}</div>`;
  }).join('') : '<div class="chatempty">チャットに接続すると、ここにコメントが流れます。下の欄からコマンドのテストもできます。</div>';
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderPlayers() {
  const rows = Object.values(S.data.players).filter((p) => p.key !== 'host').sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)).map((p) => {
    const st = statusOf(p.key);
    const label = st === 'waiting' ? `待機 ${S.data.queue.indexOf(p.key) + 1}` : STATUS[st] || st;
    const a = (name, text) => `<button class="btn sm" data-act="${name}" data-args="${esc(JSON.stringify([p.key]))}">${text}</button>`;
    let ops = '';
    if (st === 'waiting') ops = a('moveTop', '先頭へ') + ' ' + a('hold', '保留') + ' ' + a('remove', '除外');
    else if (st !== 'playing') ops = a('resume', '列に戻す');
    return `<tr><td>${esc(p.name)} ${p.member ? '<span class="tag mem">メンバー</span>' : ''}${p.key.startsWith('manual:') ? ' <span class="tag">手動</span>' : ''}</td>
      <td class="id" data-edit="${esc(p.key)}" title="クリックで修正">${esc(p.gameId)}</td>
      <td><span class="st ${st}">${label}</span></td><td>${p.w}勝 ${p.l}敗</td><td>${p.clears || 0} / ${p.wipes || 0} / ${p.deaths || 0}</td><td class="mute">${hhmm(p.joinedAt)}</td><td>${ops}</td></tr>`;
  }).join('');
  $('#ptable').innerHTML = `<thead><tr><th>表示名</th><th>ゲーム内ID</th><th>状態</th><th>対戦</th><th title="クリア / 全滅 / 死亡">協力（クリア/全滅/死亡）</th><th>参加</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">まだ参加者はいません</td></tr>'}</tbody>`;
}

function renderHistory() {
  const d = S.data;
  $('#sessionInfo').textContent = `この配信回：${new Date(d.startedAt).toLocaleString('ja-JP')} 開始・全 ${d.history.length} 件`;
  const withIds = (names, ids) => names.map((nm, j) => `${esc(nm)}${ids[j] ? ` <span class="mute small">${esc(ids[j])}</span>` : ''}`).join('・');
  const method = (h) => `<span class="tag">${h.method === 'manual' ? '手動' : esc(h.method)}</span>`;
  const row = (h) => {
    if (h.type === 'coop') {
      const lb = S.coopPresets[h.preset] || labels();
      const dead = h.deaths.length ? `<div class="small err">${esc(lb.death)}：${esc(h.deaths.join('、'))}</div>` : '';
      return `<tr><td>${h.no}</td><td>${withIds(h.names, h.ids)}${h.target ? ` <span class="tag">${esc(h.target)}</span>` : ''}${dead}</td>
        <td class="${h.result === 'clear' ? 'wcol' : 'err'}">${esc(h.result === 'clear' ? lb.clear : lb.wipe)}</td><td class="mute">協力・${h.names.length}人</td><td class="mute">${hhmm(h.endedAt)}</td><td>${method(h)}</td></tr>`;
    }
    const n = h.names[0].length;
    return `<tr><td>${h.no}</td><td>${withIds(h.names[0], h.ids[0])} <span class="mute">vs</span> ${withIds(h.names[1], h.ids[1])}</td>
      <td class="wcol">${esc(h.names[h.winSide].join('・'))}</td><td class="mute">${n}対${n}・${MODES[h.mode] ? MODES[h.mode].name : esc(h.mode)}</td><td class="mute">${hhmm(h.endedAt)}</td><td>${method(h)}</td></tr>`;
  };
  $('#htable').innerHTML = `<thead><tr><th>#</th><th>対戦・パーティー</th><th>結果</th><th>形式</th><th>終了</th><th>判定</th></tr></thead><tbody>`
    + (d.history.map(row).join('') || '<tr><td colspan="6" class="mute">まだ記録はありません</td></tr>') + '</tbody>';
}

function renderModes() {
  CHOICES['coop.preset'].items = Object.fromEntries(Object.entries(S.coopPresets).map(([k, v]) => [k, {
    name: v.name, desc: `既定 ${v.partySize}人`, flow: `${v.clear} / ${v.wipe} / ${v.death}`,
  }]));
  $('#versusOpts').hidden = isCoop();
  $('#coopOpts').hidden = !isCoop();
  for (const [key, c] of Object.entries(CHOICES)) {
    const cur = String(getPath(S.settings, key));
    $(c.el).innerHTML = Object.entries(c.items).map(([v, m]) => `<button class="modecard ${v === cur ? 'sel' : ''}" data-choose="${key}" data-value="${v}">
      <b>${m.name}</b><p>${m.desc}</p>${m.flow ? `<div class="flow">${m.flow}</div>` : ''}</button>`).join('');
  }
}

function renderSettings() {
  $$('[data-set]').forEach((el) => {
    const v = getPath(S.settings, el.dataset.set);
    if (el.type === 'checkbox') el.checked = !!v;
    else fillIfIdle(el, Array.isArray(v) ? v.join(', ') : String(v));
  });
  fillIfIdle($('#ytMinPoll'), String(S.youtube.minPollSec));
}

function renderYt() {
  const y = S.youtube;
  fillIfIdle($('#ytClientId'), y.clientId);
  $('#ytAccount').textContent = y.authorized ? `● ${y.channel ? y.channel.title : 'ログイン済み'}` : y.waitingAuth ? 'ブラウザで Google にログインしてください…' : y.configured ? '未ログイン' : 'クライアント ID が未設定です';
  $('#ytLoginBtn').disabled = !y.configured;
  $('#ytLoginBtn').textContent = y.authorized ? '再ログイン' : 'Google でログイン';
  $('#ytLogoutBtn').hidden = !y.authorized;
  $$('#ytStreamBox button, #ytStreamBox input, #ytStreamBox select').forEach((el) => { el.disabled = !y.authorized; });
  const c = y.chat;
  const st = { idle: '未接続', connecting: '接続中…', connected: `取得中${c.pollMs ? `（約 ${Math.round(c.pollMs / 1000)} 秒ごと）` : ''}`, ended: '配信が終了しました', error: 'エラー' }[c.state] || c.state;
  $('#ytChatStatus').innerHTML = `${esc(st)}${c.title ? ` ／ ${esc(c.title)}` : ''}${c.error ? `<br><span class="err small">${esc(c.error)}</span>` : ''}`;
  $('#quotaBar').style.width = Math.min(100, (y.quota / 10000) * 100) + '%';
  $('#quotaText').textContent = `${y.quota.toLocaleString()} / 10,000`;
}

let frameSrc = null;
function renderOverlay() {
  const url = S.server.url ? `${S.server.url}/overlay` : '';
  $('#ovUrl').value = url || '（サーバ停止中）';
  $('#serverErr').textContent = S.server.error || '';
  if (url && frameSrc !== url) { frameSrc = url; $('#ovFrame').src = url; }
  $$('[data-ov]').forEach((cb) => { cb.checked = !!S.settings.overlay[cb.dataset.ov]; });
}

function buildTplGrid() {
  $('#tplGrid').innerHTML = Object.entries(TPL_LABELS).map(([k, label]) => `<label>${label}</label><input data-set="tpl.${k}">`).join('');
}

// ---------- 操作 ----------
const after = {
  result: (r) => { if (r.value && r.value.streakOut) toast(`${r.value.streakOut.name} さん ${r.value.streakOut.streak}連勝で交代！`); },
  undo: (r) => { if (r.value === false) toast('取り消せる操作がありません'); else if (!r.error) toast('取り消しました'); },
  postAnnounce: (r) => { if (r.value && !r.value.ok) toast(r.value.message); else if (r.value) toast('告知を送信キューに入れました'); },
  copyCandidate: (r) => { if (r.value) toast('コピーしました。YouTube のチャットに貼り付けてください'); },
  exportCsv: (r) => { if (r.value) toast(`保存しました：${r.value}`); },
  newSession: () => { $('#newSessionConfirm').hidden = true; toast('新しい配信回を始めました'); },
  ocInstall: (r) => { if (!r.error) toast('プラグインを入れました。わんコメの「プラグイン」画面でスイッチをオンにしてください'); },
  ytLogin: (r) => { if (!r.error) toast('ブラウザで Google にログインしてください'); },
  startNext: (r) => { if (r.value === false) toast('参加者が足りません'); },
};

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('nav button[data-v]');
  if (nav) {
    $$('nav button[data-v]').forEach((x) => x.classList.toggle('active', x === nav));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + nav.dataset.v));
    if (nav.dataset.v === 'overlay') fitFrame();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn && !btn.disabled) {
    const args = btn.dataset.args ? JSON.parse(btn.dataset.args) : [];
    const r = await act(btn.dataset.act, ...args);
    if (after[btn.dataset.act]) after[btn.dataset.act](r);
    return;
  }
  const choose = e.target.closest('[data-choose]');
  if (choose) {
    const key = choose.dataset.choose;
    const value = NUM_KEYS.has(key) ? Number(choose.dataset.value) : choose.dataset.value;
    await act('updateSettings', setPath(key, value));
    toast(`「${CHOICES[key].items[choose.dataset.value].name}」にしました（次の試合から）`);
    return;
  }
  const idCell = e.target.closest('td[data-edit]');
  if (idCell && !editingKey) startIdEdit(idCell);
});

function startIdEdit(td) {
  editingKey = td.dataset.edit;
  const input = document.createElement('input');
  input.value = P(editingKey).gameId || '';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    if (!editingKey) return;
    const key = editingKey;
    editingKey = null;
    if (save && input.value.trim() !== (P(key).gameId || '')) {
      const r = await act('setGameId', key, input.value);
      if (r.value) toast(CODE_MSG[r.value.code] || r.value.code);
    }
    render();
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

$('#acceptSw').addEventListener('click', async () => {
  const on = !S.settings.accepting;
  await act('updateSettings', { accepting: on });
  toast(on ? '参加受付を開始しました' : '参加受付を締め切りました');
});
$$('[data-autopost]').forEach((cb) => cb.addEventListener('change', (e) => act('updateSettings', { autoPost: e.target.checked })));

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act('addManual', $('#manualName').value, $('#manualId').value);
  if (r.value) {
    toast(CODE_MSG[r.value.code] || r.value.code);
    if (r.value.ok) { $('#manualName').value = ''; $('#manualId').value = ''; }
  }
});

$('#testForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#testName').value.trim() || 'テスト';
  const text = $('#testText').value.trim();
  if (!text) return;
  await act('testChat', name, text);
  $('#testText').value = '';
});

$('#targetInput').addEventListener('change', (e) => act('setTarget', e.target.value));
$('#targetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('#soundTest').addEventListener('click', () => chime());

$('#newSessionBtn').addEventListener('click', () => { $('#newSessionConfirm').hidden = false; });
$('#newSessionCancel').addEventListener('click', () => { $('#newSessionConfirm').hidden = true; });
$('#copyOv').addEventListener('click', async () => { await act('copy', $('#ovUrl').value); toast('コピーしました'); });

// 設定項目：変更したら即保存
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.set) {
    let v = el.value;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.type === 'num') { v = Number(v); if (!Number.isFinite(v)) return; }
    else if (el.dataset.type === 'bool') v = v === 'true';
    else if (el.dataset.type === 'list') { v = v.split(/[,、]/).map((s) => s.trim()).filter(Boolean); if (!v.length) return render(); }
    await act('updateSettings', setPath(el.dataset.set, v));
    toast('保存しました');
  } else if (el.dataset.ov) {
    await act('updateSettings', { overlay: { [el.dataset.ov]: el.checked } });
  }
});

// YouTube
$('#ytSaveClient').addEventListener('click', async () => {
  const r = await act('ytSetClient', $('#ytClientId').value, $('#ytClientSecret').value);
  if (!r.error) { $('#ytClientSecret').value = ''; toast('保存しました'); }
});
$('#ytMinPoll').addEventListener('change', (e) => act('ytSetMinPoll', Number(e.target.value)));
function fillBroadcasts() {
  const sel = $('#ytBroadcasts');
  const label = { live: '配信中', testing: 'テスト中', ready: '準備完了', created: '予定', complete: '終了' };
  sel.innerHTML = broadcasts.length
    ? broadcasts.map((b, i) => `<option value="${i}">[${label[b.status] || b.status || '動画'}] ${esc(b.title)}</option>`).join('')
    : '<option value="">配信が見つかりませんでした</option>';
}
$('#ytFind').addEventListener('click', async () => {
  const r = await act('ytListBroadcasts');
  if (r.value) { broadcasts = r.value.filter((b) => b.liveChatId); fillBroadcasts(); toast(`${broadcasts.length} 件見つかりました`); }
});
$('#ytResolve').addEventListener('click', async () => {
  const r = await act('ytResolveVideo', $('#ytVideo').value);
  if (r.value) {
    broadcasts.unshift({ ...r.value, status: 'url' });
    fillBroadcasts();
    $('#ytBroadcasts').value = '0';
    toast('読み込みました。「チャットに接続」を押してください');
  }
});
$('#ytConnect').addEventListener('click', async () => {
  const b = broadcasts[Number($('#ytBroadcasts').value)];
  if (!b) return toast('先に配信を選んでください');
  const r = await act('ytConnect', { liveChatId: b.liveChatId, title: b.title });
  if (!r.error) toast('チャットに接続しています…');
});

// ドラッグで並べ替え
const ql = $('#queue');
ql.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-key]');
  if (!li) return;
  dragKey = li.dataset.key;
  li.classList.add('drag');
  e.dataTransfer.effectAllowed = 'move';
});
ql.addEventListener('dragover', (e) => {
  e.preventDefault();
  ql.querySelectorAll('li').forEach((l) => l.classList.remove('over'));
  const li = e.target.closest('li[data-key]');
  if (li) li.classList.add('over');
});
ql.addEventListener('dragend', () => { dragKey = null; render(); });
ql.addEventListener('drop', async (e) => {
  e.preventDefault();
  const li = e.target.closest('li[data-key]');
  const from = dragKey;
  dragKey = null;
  if (!li || !from || li.dataset.key === from) return render();
  const q = S.data.queue.filter((k) => k !== from);
  q.splice(q.indexOf(li.dataset.key), 0, from);
  await act('reorder', q);
});

// キーボード
document.addEventListener('keydown', async (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (!$('#v-dash').classList.contains('active') || !S) return;
  if ((e.key === '1' || e.key === '2') && !e.repeat) {
    if (isCoop()) {
      if (S.data.party) await act('coopEnd', e.key === '1' ? 'clear' : 'wipe');
    } else if (S.data.current) {
      after.result(await act('result', Number(e.key)));
    }
  }
  if (e.key.toLowerCase() === 'z' && e.ctrlKey) after.undo(await act('undo'));
});

// オーバーレイのプレビューを枠に合わせて縮小
function fitFrame() {
  const wrap = $('.stagewrap');
  $('#ovFrame').style.transform = `scale(${wrap.clientWidth / 1920})`;
}
new ResizeObserver(fitFrame).observe($('.stagewrap'));

// ---------- 起動 ----------
buildTplGrid();
window.api.onState((s) => { S = s; render(); });
window.api.getState().then((s) => { S = s; render(); });
