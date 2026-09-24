// MatchQueue 連携プラグイン（わんコメ用）
// わんコメが受け取った新しいコメントを MatchQueue（同じ PC で起動中）へ転送します。
// このファイルは MatchQueue の「わんコメにプラグインを入れる」で自動的に配置されます。
// https://github.com/kijitora-no-hito/matchqueue

const PORT = __PORT__;
const TOKEN = '__TOKEN__';
const VERSION = '1.0.0';

// コメント本文は絵文字などが HTML で入っているので文字列に戻す
function toText(html) {
  return String(html == null ? '' : html)
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function send(path, body) {
  try {
    await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MatchQueue-Token': TOKEN },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // MatchQueue が起動していない時は何もしない
  }
}

let timer = null;

module.exports = {
  name: 'MatchQueue 連携',
  uid: 'io.github.kijitora-no-hito.matchqueue',
  version: VERSION,
  author: 'kijitora-no-hito',
  url: 'https://github.com/kijitora-no-hito/matchqueue',
  permissions: ['comments'],
  defaultState: {},

  init() {
    const hello = () => send('/onecomme/hello', { version: VERSION });
    hello();
    timer = setInterval(hello, 30000);
  },

  subscribe(type, data) {
    if (type !== 'comments' || !data || !Array.isArray(data.comments)) return;
    const comments = data.comments
      .filter((c) => c && c.data && c.service !== 'system')
      .map((c) => ({
        id: String(c.data.id || c.id || ''),
        service: String(c.service || ''),
        userId: String(c.data.userId || ''),
        name: String(c.data.name || c.data.displayName || ''),
        text: toText(c.data.comment),
        isOwner: !!c.data.isOwner,
        isMember: !!c.data.isMember,
        timestamp: c.data.timestamp,
      }))
      .filter((c) => c.userId && c.text);
    if (comments.length) send('/onecomme/comments', { comments });
  },

  destroy() {
    clearInterval(timer);
    timer = null;
  },
};
