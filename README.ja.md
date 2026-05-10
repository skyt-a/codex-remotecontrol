# codex-remotecontrol

`codex-remotecontrol` は、ローカルで動いている Codex app-server のセッションを、同じPCやLAN内のスマホ/ブラウザから操作するための小さなWebアプリです。

Codex app-server は `127.0.0.1` で起動し、外部から見えるのはトークン保護された Node.js のブリッジだけです。スレッド、ターン、ストリーミング出力、承認、モデル選択、サンドボックス設定、画像添付をブラウザから扱えます。

## できること

- 既存スレッドの一覧表示、検索、再開
- 新規スレッドの開始、メッセージ送信
- Codex の実行中表示とストリーミング出力の表示
- コマンド出力やツール呼び出しの折りたたみ表示
- 会話中のテキストブロックをワンボタンでコピー
- 承認リクエストの許可/拒否
- モデル、承認ポリシー、サンドボックスの選択
- 画像の添付、プレビュー、個別削除
- Codex が作業中のメッセージをキューに保存し、必要なら即時送信
- 会話中の画像表示
- macOS の `caffeinate` による Keep Awake 切り替え

## 必要なもの

- Node.js 22 以降
- `codex app-server` を使える Codex CLI
- 信頼できるローカルネットワーク
- Keep Awake を使う場合は macOS

まず Codex 側が使えるか確認してください。

```bash
codex app-server --help
```

## 起動方法

```bash
npm install
npm run phone
```

起動すると、次のようなURLが表示されます。

```text
http://127.0.0.1:8787/?token=...
http://192.168.x.x:8787/?token=...
```

PC上のブラウザでは `127.0.0.1` のURLを開きます。スマホや別端末から使う場合は、同じWi-Fi/LANに接続したうえで `192.168.x.x` のようなLAN URLを開きます。

## Keep Awake

サイドバーの `Keep Awake` をオンにすると、サーバー側で `caffeinate -ims` を起動し、このWebアプリを動かしているMacのアイドルスリープを抑止します。外出先から長めに使う場合はオンにしてください。

これは「すでにスリープしたMacをWebから起こす」機能ではありません。Macが起きていて、このWebアプリにアクセスできる状態の間だけ、以後のスリープを防ぐ機能です。サーバーを終了すると自動的に解除されます。

## 外出先から使う場合

このアプリは、そのままではインターネットに公開されません。出先から使いたい場合は、PCとスマホを同じ仮想LANに入れる Tailscale や ZeroTier の利用を推奨します。

Cloudflare Tunnel や ngrok で公開することも技術的には可能ですが、Codexを操作できる画面なので追加認証やアクセス制限なしで公開しないでください。ルーターのポート開放で直接公開する運用は推奨しません。

## 設定

環境変数で挙動を変更できます。

- `PORT` または `CODEX_REMOTE_PORT`: Webブリッジのポート。既定値は `8787`
- `HOST` または `CODEX_REMOTE_HOST`: Webブリッジの待受ホスト。既定値は `0.0.0.0`
- `CODEX_REMOTE_TOKEN`: アクセストークン。未指定の場合は `.phone-token` が作成されます
- `CODEX_REMOTE_CWD`: Codex の既定作業ディレクトリ。既定値は現在のディレクトリ
- `CODEX_APP_SERVER_WS`: Codex app-server の WebSocket URL。既定値は `ws://127.0.0.1:45213`
- `CODEX_BIN`: Codex 実行ファイル。既定値は `codex`

例:

```bash
CODEX_REMOTE_PORT=8790 CODEX_REMOTE_CWD="$HOME/project" npm run phone
```

## セキュリティ上の注意

- このアプリを公開インターネットへ直接出さないでください
- Codex app-server 自体は `127.0.0.1` で起動し、LAN向けにはこのブリッジだけが公開されます
- トークンを知っている人はブラウザから Codex を操作できます
- 必要がない限り、サンドボックスは `workspace-write` または `read-only` を使ってください
- 共有Wi-Fiや信頼できないネットワークでは使わないでください

## Codex Desktop との関係

このアプリは Codex app-server のセッションを操作するためのものです。Codex Desktop アプリの画面そのものをリアルタイム同期したり、Desktop 側の会話UIへ同じ表示を即時反映したりするものではありません。

## よくあるトラブル

### スマホから開けない

- PCとスマホが同じWi-Fi/LANにいるか確認してください
- `127.0.0.1` のURLではなく、`192.168.x.x` のLAN URLをスマホで開いてください
- macOSやセキュリティソフトのファイアウォールで Node.js の通信が止められていないか確認してください
- 外出先から使う場合は Tailscale や ZeroTier などを使ってください

### `thread not found` が出る

Codex 側で対象スレッドを再開できない状態です。画面の `Resume` を押すか、スレッド一覧から開き直してください。それでも戻らない場合は、新しいスレッドを開始してください。

### メッセージがすぐ送られずキューに入る

Codex が作業中のときは、誤送信や二重送信を避けるため、送信内容はキューに入ります。すぐ送りたい場合は Queue の `Send now` を押してください。

## 開発と検証

```bash
npm run check
npm run build
npm run server:smoke
```

`build` は現在 `check` と同じです。このアプリはバンドラーを使わず、ブラウザ標準のJavaScriptとNode.js組み込みAPIで動きます。

## 参考

- OpenAI Codex remote connections: https://developers.openai.com/codex/remote-connections
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server
- Sunwood AI Labs article: https://note.com/sunwood_ai_labs/n/n0e0a896b6d8c
