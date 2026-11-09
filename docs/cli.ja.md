[English](cli.md) · [日本語](cli.ja.md)

# CLI と MCP

エージェントや外のスクリプトから、ウィンドウを使わずに、タスクを作る・状態を見る・操作する（開始・承認・回答・マージ・PR・削除・Pipeline の起動）ができます。入口は 2 つで、どちらもアプリの中の同じ API を使います。

- `wtk`: シェルやスクリプトから使うコマンド
- `wtk mcp`: Claude Code・Codex・Cursor などのエージェントから呼べる MCP サーバー（stdio）

## 準備

1. 設定の「CLI・MCP」を開く
2. 「CLI・MCP から使えるようにする」にチェックを付ける（最初から付いています）
3. 「wtk を入れる」を押す。`~/.local/bin/wtk`（Windows は `%USERPROFILE%\.local\bin\wtk.cmd`）ができます。このフォルダが `PATH` に入っていなければ、足すか、フルパスで呼んでください
4. エージェントから使うときは、そこに出ている `claude mcp add-json …` のコマンド（Claude Code）をコピーして動かすか、そこに出ている JSON をエージェントの MCP の設定に足します

`wtk` はアプリの exe を Node.js として動かすので、ほかに入れるものはありません。アプリを移した（AppImage を入れ替えた）ときは、次にアプリを起動したときに `wtk` を書き直します。

## コマンド

```sh
wtk status                         # アプリ・接続先・リポジトリ
wtk tasks                          # 今のフォルダを含むリポジトリのタスク
wtk tasks --all --status review    # すべてのリポジトリの、レビュー中のタスク
wtk show <id>                      # 1 件。承認待ちと質問も出す
wtk create "ログインの不具合を直す"   # タスクを作る（Todo に置く）
wtk create "ログインの不具合を直す" --start --agent codex
echo "長い指示" | wtk create - --title "リファクタリング"
wtk pipelines                      # リポジトリの Pipeline
wtk run-pipeline Review "ダークモードを足す"
wtk start|stop|resume <id>
wtk send <id> "ドキュメントも直して"
wtk approve <id> [--always]        # いちばん古い承認待ち（--req <reqId> で選べる）
wtk deny <id> --message "ステージングの DB を使って"
wtk answer <id> --json '{"どの DB？":"Postgres"}'
wtk logs <id> --tail 20
wtk diff <id>
wtk merge <id> [--push]
wtk pr <id> [--base main]
wtk delete <id> --yes              # タスクを破棄する（worktree とブランチも消す）
wtk call <channel> '<json>'        # API のチャンネルを直接呼ぶ
```

どのコマンドも `--json` を付けると JSON で出します。オプションの一覧は `wtk --help` で見られます。

`--repo` を付けなければ、今のフォルダを含むリポジトリを使います。タスクの worktree の中なら、その worktree の元のリポジトリです。どちらでもなければ、アプリで開いているタブを使います。

## MCP のツール

`list_repos`、`list_tasks`、`get_task`、`get_task_logs`、`get_task_diff`、`create_task`、`list_pipelines`、`run_pipeline`、`start_task`、`stop_task`、`resume_task`、`send_message`、`answer_approval`、`answer_question`、`move_task`、`merge_task`、`create_pr`、`complete_task`、`delete_task`

`create_task` は、`start` を true にしなければ Todo に置くだけです。`delete_task` には `confirm: true` が要ります。

## アプリが動いていないとき

このマシンでアプリが動いていなければ、`wtk`（`wtk mcp` は最初にツールが呼ばれたとき）がアプリを[常駐モード](headless.ja.md)で起動し、使えるようになるまで待ちます。ログはデータのフォルダの `headless.log` に出ます。止めるときは `kill <pid>` です（`wtk status` でモードが分かります）。起動させたくないときは `--no-start` を付けると、エラーで終わります。

デスクトップ版が「CLI・MCP から使えるようにする」をオフにして動いているときは、2 つ目のアプリは起動しません。オンにするか、アプリを終了してください。

## ほかの PC から使う

API は、アプリが動いている PC の `127.0.0.1` だけで待ち受けます。ほかの PC からは、SSH でポートを転送し、コードで 1 回だけペアリングします。

1. ほかの PC で: `ssh -N -L 47821:127.0.0.1:47821 <アプリの PC>`（ポートは設定の「CLI・MCP」に出ています）
2. アプリの PC で: 設定の「CLI・MCP」の「ペアリングコードを出す」を押すか、`wtk pair-code` を動かす
3. ほかの PC で: `wtk login --url http://127.0.0.1:47821 --code <コード>`

コードは 10 分間、1 回だけ使えます。トークンはデータのフォルダの `cli-login.json`（本人だけが読める）に保存し、1 年間使えます。`login` したあとは、そのアプリを使います。このマシンのアプリを使うときは `--local` を付け、トークンを忘れるときは `wtk logout` を動かします。ペアリングした PC は、設定の「CLI・MCP」（か `wtk devices`）に出て、そこで無効にできます。ペアリングした PC からは、ペアリングコードを出すことも、ほかの PC を無効にすることもできません。

ほかの PC にも `wtk` が要ります。アプリを入れて「wtk を入れる」を押すか、`WORKTREE_KANBAN_URL` と `WORKTREE_KANBAN_TOKEN` を設定して、`src/kanban-cli.js` を Node.js で動かしてください。

## 安全のために

- API が受け付けるのは、`127.0.0.1` からの、トークンが付いていて、`Origin` ヘッダーの無いリクエストだけです（Web ページからは呼べません）
- 同じ PC で使うトークンは、データのフォルダの `api.json`（本人だけが読める）にあり、アプリを起動するたびに変わります
- ペアリングしたトークンは、SHA-256 のハッシュだけを保存します
- 設定・フォルダの操作・ターミナルは、API からは使えません

## 環境変数

| 名前 | 意味 |
| --- | --- |
| `WORKTREE_KANBAN_URL` / `WORKTREE_KANBAN_TOKEN` | このアプリとトークンを使う（`--url` / `--token` と同じ） |
| `WORKTREE_KANBAN_DATA_DIR` | アプリのデータのフォルダ（`wtk` が設定する） |
| `WORKTREE_KANBAN_APP` | 常駐モードで起動する exe（`wtk` が設定する） |
