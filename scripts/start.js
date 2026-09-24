'use strict';
// 開発起動用。ELECTRON_RUN_AS_NODE が残っている環境（VS Code 拡張経由など）でも GUI で起動できるようにする。
//   npm start          通常起動
//   npm run smoke      動作確認（一時データで自動操作し .smoke/ にスクリーンショットを保存して終了）
//   npm run guide-shots 使い方ガイド用のスクリーンショットを docs/images/guide/ に撮り直す
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron'); // Node から require すると実行ファイルのパスが返る

const root = path.join(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const mode = args.includes('--smoke') ? 'smoke' : args.includes('--guide') ? 'guide' : null;
if (mode) {
  // 一時データ（本番のデータや本物のわんコメに触れないように）
  const work = path.join(root, mode === 'smoke' ? '.smoke' : '.guide');
  fs.rmSync(work, { recursive: true, force: true });
  env.MATCHQUEUE_USERDATA = path.join(work, 'userdata');
  env.MATCHQUEUE_APPDATA = path.join(work, 'appdata');
  fs.mkdirSync(path.join(env.MATCHQUEUE_APPDATA, 'onecomme'), { recursive: true });
  if (mode === 'smoke') {
    env.MATCHQUEUE_SMOKE = work;
  } else {
    env.MATCHQUEUE_SMOKE = path.join(root, 'docs', 'images', 'guide');
    env.MATCHQUEUE_SMOKE_SCRIPT = 'guide-shots.js';
  }
}

spawn(electron, ['.', ...args.filter((a) => a !== '--smoke' && a !== '--guide')], { stdio: 'inherit', env, cwd: root })
  .on('exit', (code) => {
    if (env.MATCHQUEUE_SMOKE) {
      try { console.log(fs.readFileSync(path.join(env.MATCHQUEUE_SMOKE, 'result.json'), 'utf8')); } catch { console.log('result.json がありません'); }
    }
    process.exit(code ?? 0);
  });
