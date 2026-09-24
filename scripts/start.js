'use strict';
// 開発起動用。ELECTRON_RUN_AS_NODE が残っている環境（VS Code 拡張経由など）でも GUI で起動できるようにする。
//   npm start          通常起動
//   npm run smoke      動作確認（一時データで自動操作し .smoke/ にスクリーンショットを保存して終了）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron'); // Node から require すると実行ファイルのパスが返る

const root = path.join(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
if (args.includes('--smoke')) {
  const out = path.join(root, '.smoke');
  fs.rmSync(out, { recursive: true, force: true });
  env.MATCHQUEUE_SMOKE = out;
  env.MATCHQUEUE_USERDATA = path.join(out, 'userdata');
}

spawn(electron, ['.', ...args.filter((a) => a !== '--smoke')], { stdio: 'inherit', env, cwd: root })
  .on('exit', (code) => {
    if (env.MATCHQUEUE_SMOKE) {
      try { console.log(fs.readFileSync(path.join(env.MATCHQUEUE_SMOKE, 'result.json'), 'utf8')); } catch { console.log('result.json がありません'); }
    }
    process.exit(code ?? 0);
  });
