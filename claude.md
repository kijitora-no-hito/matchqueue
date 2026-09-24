# 配信対戦管理ツール（仮称 MatchQueue）

YouTube でのゲーム配信中に行う「視聴者参加型ルームマッチ」の進行管理ツール。
視聴者がチャットで参加表明 → 待機列・対戦カードを自動管理 → 次の対戦を UI / OBS オーバーレイ / YouTube チャットに告知する。

## 現在のフェーズ

**MVP 実装済み（v0.1.0）。実配信での YouTube 連携は未検証。**

- 2026-09-23 検討開始。検討資料とイメージ画面（`mockups/`）を作成 → オーナー了承
- 2026-09-23 ゲーム内ID は参加時に必須と決定
- 2026-09-23 Electron で MVP を実装（手動進行・チャットコマンド・告知投稿・OBS オーバーレイ・履歴/CSV）
- 2026-09-23 1対1 が基本、2対2 のゲームもある → 試合を2チーム制に変更（`settings.teamSize` 1/2）
  - 2対2 のチームは列の順に自動で組む（1・2番 vs 3・4番）。勝ち抜き/ローテーションどちらも可
  - 配信者も参加することがある → `settings.hostPlay`：参加しない / 毎試合出る / 列に並ぶ / 勝ち抜きの王者役
    （旧「配信者チャレンジ」= ローテーション + 毎試合出る。旧データは自動移行）
  - 配信中に進行画面の上部から人数・進め方・配信者の参加を切り替えられる
- 2026-09-23 協力プレイ型ゲーム（エルデンリング・ダークソウル・地球防衛軍）に対応（`settings.format: 'coop'`）
  - 配信者＋ゲスト最大2〜3人（パーティー 3 or 4 人。ゲームのプリセットで既定人数と言葉が変わる）
  - 1プレイの終わり：ボス撃破/クリア、または配信者死亡で全滅 → ゲストは交代（`coop.stayPlays` で連続参加数を変更可）
  - ゲストの死亡：その人だけ抜けて列の最後尾へ。空き枠は既定で次のプレイまで空ける（`coop.refill`、「今すぐ補充」ボタンあり）
  - ボス名/ミッション名を任意入力でき、告知・履歴・オーバーレイに出る

- 2026-09-24 GitHub に公開：https://github.com/kijitora-no-hito/matchqueue（Public / MIT）。v0.1.0 を Releases に掲載
  - YouTube 連携（Google Cloud 必須）は任意の上級者向けとして公開。次は Google Cloud なしでチャットを読む方法を追加予定
    （候補：非公式のチャット読み取り / わんコメ連携。どちらも投稿は不可なので告知はオーバーレイで行う想定）

- 2026-09-24 わんコメ連携を実装（Google Cloud なしでチャットを読める）
  - わんコメの WebSocket API は非公開化、HTTP API にはコメント取得がないため、**わんコメのプラグイン**方式にした
  - `src/onecomme/plugin.js`（テンプレート）を `%APPDATA%\onecomme\plugins\matchqueue\plugin.js` にポートとトークンを埋めて配置
  - プラグインは `subscribe('comments', {comments})` で新着コメントを受け、`POST /onecomme/comments`（`X-MatchQueue-Token` 必須）で転送。30秒ごとに `/onecomme/hello`
  - 投稿はできないので、受付などの返信はオーバーレイにお知らせ表示（`settings.overlay.notices`、SSE の `event: notice`）
  - 2026-09-24 オーナー環境（わんコメ 9.1.2）で連携成功を確認。わんコメ 4.x には plugin 機能がない（データは `%APPDATA%\live-comment-viewer`）
  - わんコメ 9.x ではプラグインの有効化は「プラグイン」画面（「連携」画面とは別）で行う
- 2026-09-24 チャット投稿候補（`src/main/candidates.js`）：YouTube API で投稿できない時は告知・返信を候補に並べ、配信者がコピーして手で貼る。
  貼った文面がチャットに流れてきたら（空白・全角半角を無視して一致）候補から自動で消す。進行画面の右列（ライブチャットの上）に表示
  - 新しい候補が出たら通知音（Web Audio で生成、`settings.sound.candidate` / `volume`）。`npm run smoke` は `window.chimeCount` で鳴ったことを確認
- 2026-09-24 公開リポジトリから `mockups/` を削除
- 2026-09-24 v0.2.0 を Releases に掲載（わんコメ連携・チャット投稿候補・通知音）。オーナー環境で動作確認済み
- 2026-09-24 v0.2.1 を Releases に掲載（使い方ガイド、ボス名変更時の告知候補作り直し）
  - README のダウンロードボタンは GitHub が `height` を無効化する（`height:auto` を付ける）ため `width` で大きさを指定する
  - オーナーの D ドライブが空き容量ほぼ 0 になることがある。ビルドは `--config.directories.output=<C: の作業フォルダ>` で C に出力すると安全

## 公開・リリース手順

- この環境では git / gh が PATH にないことがある：`C:\Program Files\Git\cmd`、`C:\Program Files\GitHub CLI`
- リリース：`package.json` の version を上げる → `npm run dist` → `gh release create vX.Y.Z` にインストーラを添付
  （添付ファイル名はスペースなしの `MatchQueue-Setup-X.Y.Z.exe` にする）
  - **同じインストーラを `MatchQueue-Setup.exe`（バージョンなし）でも必ず添付する**。README のダウンロードボタンは
    `releases/latest/download/MatchQueue-Setup.exe` を指しているため、これがないとボタンが壊れる

## 前提・オーナー要望

- Web ベースの UI。Node.js サーバを手動で立てるのは不可 → Electron アプリ（インストーラでスタートメニュー登録）。
- 参加表明は YouTube チャットのコマンド。**ゲーム内ID 必須**（`!参加 ID`）。
- 次の対戦は UI 表示 + YouTube チャット投稿 + OBS オーバーレイ。
- 将来：配信画面キャプチャで勝敗を自動判定（未着手）。

## コマンド

- `npm start` — 開発起動（`scripts/start.js` 経由。ELECTRON_RUN_AS_NODE が残る環境対策）
- `npm test` — ユニットテスト（node:test、`test/*.test.js`）
- `npm run smoke` — 一時データで自動操作し `.smoke/` に各画面のスクリーンショットを保存（UI 変更後の確認用）
- `npm run guide-shots` — 使い方ガイド（`docs/guide.md`）用のスクリーンショットを `docs/images/guide/` に撮り直す（`scripts/guide-shots.js`）。UI を変えたら実行
- `npm run dist` — Windows インストーラ生成（`dist/MatchQueue Setup x.y.z.exe`）

## 構成

- `src/main/engine.js` — 対戦進行エンジン（Electron 非依存・テスト対象）。状態変化で `change`、投稿文で `post` を emit
- `src/main/main.js` — Electron メイン。IPC の `actions` 表が画面からの操作の入口
- `src/main/youtube.js` — YouTube Data API v3（fetch 直叩き、OAuth ループバック + PKCE、チャットのポーリング/投稿）
- `src/main/poster.js` — 投稿キュー（告知優先・最低間隔・返信まとめ・200 文字制限）
- `src/main/server.js` — 127.0.0.1 の HTTP サーバ（`/overlay`、SSE `/events`、`/oauth/callback`）既定ポート 17800
- `src/main/onecomme.js` — わんコメ連携（プラグインの配置、転送されたコメントの受信・重複除去）
- `src/onecomme/plugin.js` — わんコメに入れるプラグインのテンプレート（`__PORT__` / `__TOKEN__` を置換）
- `src/main/store.js` — userData（`%APPDATA%/MatchQueue`）に JSON 保存。配信回の履歴は `sessions/`
- `src/renderer/` — 管理画面（素の HTML/JS、CSP あり、インラインスクリプト不可）
- `src/overlay/overlay.html` — OBS ブラウザソース用（1920×1080、透過）
- `docs/concept.md` — 検討資料 / `docs/youtube-setup.md` — Google Cloud 初期設定手順（ユーザー向け）
- `docs/guide.md` — 使い方ガイド（配信者向け。ゲーム別の設定・配信中の操作・視聴者への案内文）。README はセットアップ中心、配信中の使い方はこちら
- 初期のイメージ画面（`mockups/`）は 2026-09-24 に削除（git 履歴には残っている）

## 実装上の注意

- 依存はビルド用の electron / electron-builder のみ。ランタイム依存を増やさない方針。
- プレイヤーのキーは `yt:<channelId>` / `manual:<n>` / `host`（配信者）。
- 試合は `current.teams = [[key...], [key...]]`。連勝は `champ`（チームのキーをソートして `+` 連結した teamId）で管理。
- 協力プレイは `data.party = { no, guests, stays, dead, reserved, target }`（配信者は暗黙で常に参加）。対戦の `current` とは排他。
  `reserved` = 死亡で空いたが次のプレイまで補充しない枠数。履歴は `type: 'coop'` で対戦と同じ `history` に入る。
- `npm run smoke` はポート 17899 を使う（本番起動中の 17800 と衝突しないように）。
- 配信者が YouTube チャットで `!参加` しても `host` とは別人扱い（`yt:<自分のチャンネル>`）。配信者の参加は画面で操作する。
- チャット接続直後の 1 ページ目は過去ログなのでコマンド処理しない。
- 秘密情報（クライアントシークレット・トークン）は Electron safeStorage で暗号化して `youtube.json` に保存。
- API クォータ（既定 10,000/日）：チャット取得 ≒5、投稿 ≒50 として推定表示。

## 未決事項・次の候補

- 対象ゲーム名、Bot 投稿アカウント、OBS 利用有無（`docs/concept.md` 7章）
- 実配信での YouTube 連携の検証（OAuth・チャット取得・投稿・クォータ実測）
- アプリアイコン、総当たり/トーナメント形式、勝敗自動判定

## 作業ルール

- ドキュメント・UI 文言は日本語。
- 決定事項や進捗が出たらこのファイルに追記していく。
