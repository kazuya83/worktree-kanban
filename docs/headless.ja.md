[English](headless.md) · [日本語](headless.ja.md)

# 常駐モード（ウィンドウを開かずに動かす）

Worktree Kanban を、ウィンドウを開かずに動かし続けるモードです。アプリの画面を閉じている間や、画面のない Linux のサーバー（VPS など）でも、次のものが動きます。

- タスクスケジューラ
- Issue の監視と、そこから始まるタスク
- Slack からのタスクの開始と、Slack への通知（承認・回答も Slack のボタンでできます）
- 遠隔操作のホスト（別の PC のアプリから、SSH 経由でボードを操作する）
- スマホ用の Web 画面（前にデスクトップ版で使えるようにしていたとき）

常駐モードは、デスクトップ版と同じアプリを `--headless` 付きで起動したものです。ボードのデータもデスクトップ版と同じものを使います。

確かめた環境は macOS と Linux（Ubuntu 24.04、画面なし）です。Windows でも同じ引数で起動できますが、まだ確かめていません。

## 起動する

| OS | コマンド |
| --- | --- |
| macOS | `"/Applications/Worktree Kanban.app/Contents/MacOS/Worktree Kanban" --headless` |
| Linux（tar.gz） | `./worktree-kanban-headless`（展開したフォルダの中） |
| Linux（AppImage） | `./worktree-kanban-x.y.z-linux-x86_64.AppImage --headless` |
| Windows | `"%LOCALAPPDATA%\Programs\Worktree Kanban\Worktree Kanban.exe" --headless` |

起動すると、状態と通知がログ（標準出力）に1行ずつ出ます。

```
[2026-11-08 11:13:38] Worktree Kanban 0.2.0 を常駐モードで起動しました（pid 95847、データ: /home/me/.config/agent-kanban）
[2026-11-08 11:13:38] 遠隔操作のホスト: 127.0.0.1:17831 で待ち受けています。ペアリングのコード 292408（11:23:38 まで。出し直すには kill -USR2 95847）
[2026-11-08 11:13:38] Slack: connected: Slack に接続しています。メンションと /コマンドを受け取れます
```

指定できるもの:

| 指定 | 内容 |
| --- | --- |
| `--headless` | 常駐モードで起動します。環境変数 `WORKTREE_KANBAN_HEADLESS=1` でも同じです |
| `--remote-host[=ポート]` | 遠隔操作のホストを始めます（ポートの既定は 17831）。待ち受けるのは `127.0.0.1` だけで、操作側からは SSH 経由でつなぎます |
| `--secrets-file=パス` | トークンのファイルの場所です（下の「トークン」）。環境変数 `WORKTREE_KANBAN_SECRETS_FILE` でも指定できます |
| `--user-data-dir=パス` | ボードのデータを別の場所に置きます |

### Linux のサーバーで動かす

1. Release から `worktree-kanban-x.y.z-linux-x64.tar.gz` を取ってきて展開します
2. 足りないライブラリを入れます（Ubuntu 24.04 の例）

   ```sh
   sudo apt-get install -y libnss3 libgbm1 libasound2t64 libgtk-3-0t64 git
   ```

3. 使うエージェントの CLI（`claude` など）と `gh` を入れて、サーバーでログインしておきます。エージェントはサーバーで動きます
4. `./worktree-kanban-headless --remote-host` で起動します

`worktree-kanban-headless` は、`--headless` を付けてアプリを起動するスクリプトです。tar.gz を展開しただけでは Chromium のサンドボックス（`chrome-sandbox`）が使えないので、そのときは `--no-sandbox` も付けます。常駐モードは Web のページを開かないので、サンドボックスを使わなくても困りません。使うときは、`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` を実行してください。

D-Bus につながらないというエラー（`Failed to connect to the bus`）がログに出ることがあります。動きには関係ありません。

## 初めての設定（遠隔操作でつなぐ）

常駐モードには画面がないので、リポジトリを開く・連携を設定するといった操作は、手元の PC のアプリから[遠隔操作](remote.ja.md)で行います。

1. サーバーで `--remote-host` を付けて起動し、ログに出たペアリングのコード（6 桁）を控えます。コードの期限は 10 分です。切れたら `kill -USR2 <pid>` で出し直せます
2. 手元のアプリで、RC設定を開き、「SSH 経由」でサーバーにつなぎます（ポートは 17831）。コードを入れるとペアリングできます
3. ホストのタブで、リポジトリを開く・設定の「連携」で Slack などを設定する・スケジュールを作る、を行います

一度ペアリングすれば、次からはコードなしでつなげます。前回 `--remote-host` で始めたホストは、次の起動でも自動で始まります。

## トークン

Slack などの連携のトークンは、次の順で探して、最初に見つかったものを使います。

1. 環境変数
2. トークンのファイル（既定は、データのフォルダの `headless.env`）
3. デスクトップ版や遠隔操作で保存したもの（OS の安全な保存先の鍵で暗号化してあるもの）

Linux のサーバーでは、キーチェーン（GNOME Keyring など）がないことが多く、3 は使えません。そのときは 1 か 2 に書いてください。

| 連携 | 環境変数の名前 |
| --- | --- |
| Slack（Bot Token） | `WORKTREE_KANBAN_SLACK_BOT_TOKEN` |
| Slack（App-Level Token） | `WORKTREE_KANBAN_SLACK_APP_TOKEN` |
| GitLab | `WORKTREE_KANBAN_GITLAB_TOKEN` |
| Linear | `WORKTREE_KANBAN_LINEAR_API_KEY` |
| Jira | `WORKTREE_KANBAN_JIRA_TOKEN` |
| スマホ用の名前付きトンネル | `WORKTREE_KANBAN_MOBILE_NAMED_TUNNEL_TOKEN` |

起動したときに、どの名前をどこから読んだかがログに出ます（値は出しません）。

トークンのファイルは、1行に `名前=値` を書きます。

```sh
# ~/.config/agent-kanban/headless.env
WORKTREE_KANBAN_SLACK_BOT_TOKEN=xoxb-...
WORKTREE_KANBAN_SLACK_APP_TOKEN=xapp-...
```

- ファイルは本人だけが読めるようにしてください（`chmod 600`）。ほかの人も読めるときや、持ち主が違うときは、読まずに起動をやめます
- データのフォルダは、macOS は `~/Library/Application Support/agent-kanban`、Linux は `~/.config/agent-kanban`、Windows は `%APPDATA%\agent-kanban` です
- トークン以外の連携の設定（通知のチャンネル・許可するユーザー・チャンネルとプロジェクトの対応など）は、遠隔操作で設定の「連携」から入れます。トークンの欄は、環境変数かファイルにあれば「設定済み」になります

## 承認待ちと質問

画面を見ている人がいなくても、エージェントの承認待ちと質問は、**答えが来るまで待ちます**。勝手に許可も拒否もしません。

- Slack の連携で「確認待ちを通知する」がオンで、「通知を投稿するチャンネル ID」があれば、そのチャンネルに通知します。Slack から頼んだタスクは、そのスレッドに通知します
- 「タスクの開始と承認・回答ができる Slack ユーザー ID」に書いた人は、通知のボタンで許可・拒否・回答ができます。入力の全文を Slack に出せない承認は、Slack からは拒否だけができます
- 遠隔操作かスマホの画面からも答えられます

Slack につながっていないときや、通知のチャンネルが空のときは、起動したときにログで知らせます。

## デスクトップ版との関係

デスクトップ版と常駐モードは、同じマシンで同時には動かせません。同じボードを2つのアプリで動かすと、タスクやスケジュールが二重に動くためです。

- 常駐モードが動いているときにデスクトップ版を開くと、理由を出して終わります。先に常駐モードを止めてください
- デスクトップ版が動いているときに常駐モードを起動すると、理由をログに出して終わります（終了コード 1）

## 止める

`Ctrl+C` か `kill <pid>`（SIGTERM）で止まります。実行中のタスクはその場で中断し、それまでの変更をタスクのブランチにコミットしてから終わります。次に起動したあと、タスクの「再開」で続けられます。片付けが止まってしまったときは、もう一度送ると待たずに終わります。

### systemd で自動で起動する（例）

アプリは自動起動の登録をしません。Linux で使うときの例です。

```ini
# ~/.config/systemd/user/worktree-kanban.service
[Unit]
Description=Worktree Kanban (headless)
After=network-online.target

[Service]
ExecStart=%h/worktree-kanban/worktree-kanban-headless --remote-host
Restart=on-failure
# 本体にだけ SIGTERM を送り、タスクをコミットするまで待つ
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

`systemctl --user enable --now worktree-kanban` で始め、`journalctl --user -u worktree-kanban -f` でログを見ます。ログアウトしても動かし続けるには `loginctl enable-linger` を実行してください。

## 更新

常駐モードは、新しい版を自動では入れません。新しい版が出ると、ログで知らせます。止めてから新しい版に入れ替えて、起動し直してください。

[← README に戻る](../README.ja.md)
