[English](mobile.md) · [日本語](mobile.ja.md)

# スマホから使う（外からスマホのブラウザでボードを操作する）

Worktree Kanban を動かしている PC（Mac・Windows・Linux）のボードを、**外出先からスマホのブラウザ**で見て操作できます。iPhone（Safari）と Android（Chrome）に対応しています。アプリを入れる必要はありません。

スマホからできること:

- ボードとタスクの状態を見る（リポジトリの切り替え・列ごとの一覧・確認待ちの印）
- タスクのログ（チャット）を見る
- 新しいタスクを作って始める
- 動いているタスクへの追加の指示、承認・拒否、質問への回答
- 通知を見て、そのタスクを開く

スマホからできないこと:

- マージ・PR の作成・タスクの破棄・設定の変更・連携のトークンの操作（PC の画面で行います）
- スマホの中でエージェント（`claude` など）を動かすこと。エージェントはいつも PC で動きます
- PC のアプリを閉じている間の操作。スマホから使えるのは、PC で Worktree Kanban を開いている間だけです

## しくみ

```
スマホのブラウザ ──HTTPS──▶ Cloudflare ──トンネル──▶ cloudflared（PC） ──▶ Worktree Kanban（127.0.0.1:17832）
```

- アプリは `127.0.0.1` だけで待ち受けます。外からは、PC で動かす [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)（`cloudflared`）を通してだけ届きます。**ルーターのポート開放は要りません**
- `cloudflared` は Cloudflare の無料のプログラムです。アプリは `cloudflared` を自動ではダウンロードしません。下の手順で入れてください

## 1. cloudflared を入れる

| OS | 入れ方 |
| --- | --- |
| Mac | `brew install cloudflared`（[Homebrew](https://brew.sh/) が要ります） |
| Windows | `winget install --id Cloudflare.cloudflared`。PowerShell で実行します。[公式のダウンロード](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)のインストーラーでもかまいません |
| Linux | [公式のダウンロード](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)にある、ディストリビューションごとのパッケージ（.deb / .rpm）かバイナリ |

入れたら、Worktree Kanban の上部の **「スマホ」** を押します。`cloudflared` のパスが出ていれば準備できています。出ていないときは「もう一度確かめる」を押してください。PATH に無い場所に入れたときは、PATH を通してからアプリを起動し直します。

## 2. トンネルの種類を選ぶ

| | Quick Tunnel（初期値） | 名前付きトンネル |
| --- | --- | --- |
| 要るもの | なし（アカウント不要） | Cloudflare のアカウント（無料）と、Cloudflare に置いた自分のドメイン |
| URL | `https://〇〇.trycloudflare.com`。**アプリやトンネルを起動するたびに変わります** | `https://kanban.example.com` のように決まった URL |
| URL が変わったとき | スマホで QR コードを読み直します（ペアリングはそのまま残ります） | 変わりません |
| 向いている使い方 | まず試す・ときどき使う | 毎日使う |

Quick Tunnel は Cloudflare が試用向けに出しているもので、動き続ける保証はありません。つながらない日が続くときは、名前付きトンネルにしてください。

### 名前付きトンネルの作り方

1. [Cloudflare のダッシュボード](https://dash.cloudflare.com/)で、使うドメインを Cloudflare に追加します（ネームサーバーを Cloudflare に向けます）
2. **Zero Trust** → **Networks** → **Tunnels** で **Create a tunnel** を押し、**Cloudflared** を選んで名前を付けます
3. インストールのコマンドの例に出る `cloudflared service install eyJ…` の **`eyJ…` の部分がトンネルのトークン**です。コピーします。PC にサービスとして入れる必要はありません。Worktree Kanban が `cloudflared` を起動します
4. **Public Hostname** で、サブドメインとドメイン（例: `kanban` と `example.com`）を決め、**Service** を `HTTP`、URL を `127.0.0.1:17832` にします
5. Worktree Kanban の「スマホ」で **名前付きトンネル** を選び、公開するホスト名（例: `kanban.example.com`）とトークンを入れて **「トンネルの設定を保存」** を押します

トークンは OS の安全な保存先（macOS のキーチェーン・Windows の DPAPI・Linux の GNOME Keyring や KWallet）に入れます。`board.json` には入れません。

> 画面やダッシュボードの名前は、Cloudflare の変更で変わることがあります。見つからないときは [Cloudflare のドキュメント](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)を見てください。

## 3. スマホをつなぐ

1. 「スマホ」で **「使う」** を押します。「トンネル: つながっています」と URL が出るまで待ちます（Quick Tunnel は数秒〜30 秒ほど）
2. **「スマホをつなぐ」** を押すと、QR コードと 8 文字のコードが出ます
3. スマホのカメラで QR コードを読み取り、開いたページでそのまま使えます。読み取れないときは、URL をスマホで開いて 8 文字のコードを入れます
4. よく使うなら、ブラウザの「ホーム画面に追加」で、アプリのように開けます

コードは **10 分間・1 回だけ** 使えます。2 台目のスマホをつなぐときは、もう一度「スマホをつなぐ」を押します。

## 安全のきまり

- ペアリングしたスマホには、アプリがトークンを渡します。**トークンは 30 日で切れます**。切れたら、もう一度 QR コードでつなぎます
- PC には、トークンそのものではなく SHA-256 のハッシュだけを保存します
- つないだスマホは「つないだスマホ」の一覧に出ます。なくした・手放したスマホは **「無効にする」** を押してください。すぐに使えなくなり、開いている画面も切れます
- コードを 5 回間違えると、そのコードは使えなくなります。同じところからの試しすぎも止めます
- スマホからは、上の「できること」の操作しか受け付けません。マージ・PR・設定の変更・トークンの読み出しはできません
- スマホに渡すボードからは、遠隔操作のトークンなどの秘密を外します
- URL を知っている人は、ペアリングの画面までは開けます。ボードを見たり操作したりするには、PC に出るコードかトークンが要ります。名前付きトンネルでは、Cloudflare Access でログインを足すこともできます
- 使わないときは「止める」を押すと、外からは届かなくなります

## つながらないとき

| 様子 | 直し方 |
| --- | --- |
| 「cloudflared が見つかりません」 | 上の手順で入れて「もう一度確かめる」を押します。Mac で Finder から起動したときに見つからないなら、`/opt/homebrew/bin` か `/usr/local/bin` に入っているかを確かめます |
| 「トンネル: エラー」のまま | 社内のネットワークなどで、外への接続（ポート 7844）が止められていることがあります。別のネットワークで試すか、名前付きトンネルにします。アプリは間隔を空けながら、つなぎ直し続けます |
| 名前付きトンネルでつながらない | トークンが正しいか、Public Hostname の URL が `127.0.0.1:17832` になっているかを確かめます |
| スマホで「トークンが無効です」と出てペアリングの画面に戻る | 期限が切れたか、PC で無効にされました。QR コードでつなぎ直します |
| Quick Tunnel の URL が開けなくなった | アプリかトンネルを起動し直すと URL が変わります。PC の「スマホをつなぐ」で、新しい QR コードを読み取ってください |
| ポート 17832 がほかのアプリで使われている | ほかのアプリを止めるか、`board.json` の `mobilePort` を変えます。名前付きトンネルの Public Hostname も同じポートにします |

## スマホアプリを作る人へ

スマホの画面は、アプリの HTTP API（`/api/v1/…`）だけを使っています。API の呼び出しは `mobile/assets/api-client.js` にまとまっています。DOM を使わない部品なので、ネイティブのアプリからも同じ API を使えます。

- `POST /api/v1/pair` `{code, deviceName}` → トークン
- `GET /api/v1/session` → 端末の情報と、使える操作の一覧
- `POST /api/v1/invoke` `{channel, arg}` → 操作（チャンネルは `src/mobile-server.js` の `MOBILE_CHANNELS`）
- `GET /api/v1/events` → Server-Sent Events（`board:changed`・`card:log` など）
- `POST /api/v1/logout`

認証は `Authorization: Bearer <token>` です。

[← README に戻る](../README.ja.md)
