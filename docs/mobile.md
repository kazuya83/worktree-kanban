[English](mobile.md) · [日本語](mobile.ja.md)

# Use from your phone (operate the board from a phone browser, from anywhere)

You can view and operate the board of the PC running Worktree Kanban (Mac, Windows, or Linux) **from your phone's browser, even when you are away**. iPhone (Safari) and Android (Chrome) are supported. Nothing needs to be installed on the phone.

What you can do from the phone:

- See the board and task status (switch repositories, list by column, items waiting for you)
- Read a task's log (chat)
- Create a new task and start it
- Send follow-up instructions to a running task, allow or deny permission checks, and answer questions
- See notifications and open the task

What you cannot do from the phone:

- Merge, create PRs, discard tasks, change settings, or touch integration tokens (do these on the PC)
- Run agents (`claude` and so on) on the phone itself. Agents always run on the PC
- Anything while the app is closed on the PC. The phone works only while Worktree Kanban is open on the PC

## How it works

```
Phone browser ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared (PC) ──▶ Worktree Kanban (127.0.0.1:17832)
```

- The app listens only on `127.0.0.1`. From outside, requests reach it only through [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`) running on the PC. **No port forwarding on your router is needed**
- `cloudflared` is a free program from Cloudflare. The app does not download it for you. Install it with the steps below

## 1. Install cloudflared

| OS | How to install |
| --- | --- |
| Mac | `brew install cloudflared` (needs [Homebrew](https://brew.sh/)) |
| Windows | `winget install --id Cloudflare.cloudflared` in PowerShell, or the installer from the [official downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |
| Linux | The package (.deb / .rpm) or binary for your distribution from the [official downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |

Then click **Phone** at the top of Worktree Kanban. If the path of `cloudflared` is shown, you are ready. If not, click "Check again". If you installed it somewhere outside your PATH, add it to PATH and restart the app.

## 2. Choose a tunnel type

| | Quick Tunnel (default) | Named tunnel |
| --- | --- | --- |
| You need | Nothing (no account) | A Cloudflare account (free) and your own domain on Cloudflare |
| URL | `https://….trycloudflare.com`. **It changes every time the app or tunnel starts** | A fixed URL such as `https://kanban.example.com` |
| When the URL changes | Scan the QR code again on the phone (the pairing is kept) | It does not change |
| Good for | Trying it out, occasional use | Daily use |

Quick Tunnel is offered by Cloudflare for testing and is not guaranteed to keep working. If it keeps failing, switch to a named tunnel.

### Creating a named tunnel

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), add your domain to Cloudflare (point its name servers to Cloudflare)
2. In **Zero Trust** → **Networks** → **Tunnels**, click **Create a tunnel**, choose **Cloudflared**, and give it a name
3. The install command shown, `cloudflared service install eyJ…`, contains the **tunnel token: the `eyJ…` part**. Copy it. You do not need to install it as a service; Worktree Kanban starts `cloudflared` itself
4. Under **Public Hostname**, choose a subdomain and domain (for example `kanban` and `example.com`), set **Service** to `HTTP` and the URL to `127.0.0.1:17832`
5. In Worktree Kanban's Phone dialog, choose **Named tunnel**, enter the hostname (for example `kanban.example.com`) and the token, and click **Save tunnel settings**

The token is stored in the OS secure storage (macOS Keychain, Windows DPAPI, GNOME Keyring or KWallet on Linux), never in `board.json`.

> Names in the dashboard may change as Cloudflare updates it. If you cannot find them, see [Cloudflare's documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/).

## 3. Connect your phone

1. In the Phone dialog, click **Use**. Wait until it shows "Tunnel: Connected" and the URL (a few seconds to about 30 seconds for Quick Tunnel)
2. Click **Connect a phone**. A QR code and an 8-character code appear
3. Scan the QR code with the phone's camera and use the page that opens. If it does not scan, open the URL on the phone and enter the 8-character code
4. If you use it often, use the browser's "Add to Home Screen" to open it like an app

The code works **once, for 10 minutes**. To connect a second phone, click "Connect a phone" again.

## Security

- A paired phone receives a token from the app. **Tokens expire after 30 days**. When it expires, connect again with a QR code
- The PC stores only a SHA-256 hash of each token, not the token itself
- Paired phones are listed under "Connected phones". If a phone is lost or given away, click **Revoke**. It stops working at once, and any open page is disconnected
- After 5 wrong codes, the code stops working. Too many attempts from the same place are also blocked
- The phone can only do the operations listed above. It cannot merge, create PRs, change settings, or read tokens
- The terminal (a shell on the PC) can be used from a phone only while "Allow the terminal from phones" is on in the desktop app (off by default)
- Secrets such as remote-control tokens are removed from the board sent to the phone
- Anyone with the URL can open the pairing page, but seeing or operating the board needs the code shown on the PC or a token. With a named tunnel, you can also put a login in front of it with Cloudflare Access
- Click **Stop** when you are not using it, and nothing can reach it from outside

## Terminal

If you turn on "Allow the terminal from phones" in "Use from your phone" in the desktop app, the phone can open a shell on the PC. A terminal button appears at the top of the board, and a "Terminal" button appears in a task's details once its worktree exists. Keys that are hard to type on a phone keyboard (Esc, Tab, Ctrl, arrows, ^C) are in a row at the bottom.

This means **full control of the PC** from the phone, so it is off by default. Turn it on only when you need it. While it is off, the PC also refuses terminal requests from phones. The shells keep running on the PC until they are closed, even if you leave the page on the phone.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "cloudflared was not found" | Install it with the steps above and click "Check again". On a Mac, if it is not found when the app is started from Finder, check that it is in `/opt/homebrew/bin` or `/usr/local/bin` |
| "Tunnel: Error" stays | Some networks, such as office networks, block outgoing connections (port 7844). Try another network, or use a named tunnel. The app keeps reconnecting with increasing intervals |
| A named tunnel does not connect | Check the token, and that the Public Hostname URL is `127.0.0.1:17832` |
| The phone says the token is invalid and returns to pairing | It expired or was revoked on the PC. Connect again with a QR code |
| Opening the Quick Tunnel URL says the server cannot be found | The URL does not open for about 30 seconds after it appears. Opening it during that time makes the phone's DNS remember "not found", and it fails for 1–2 minutes. Wait a little and open it again |
| The Quick Tunnel URL stopped opening | The URL changes when the app or tunnel restarts. Click "Connect a phone" on the PC and scan the new QR code |
| Port 17832 is used by another app | Stop the other app, or change `mobilePort` in `board.json`. Use the same port in the named tunnel's Public Hostname |

## For people building a phone app

The phone page uses only the app's HTTP API (`/api/v1/…`). The calls are collected in `mobile/assets/api-client.js`, a module that does not use the DOM, so a native app can use the same API.

- `POST /api/v1/pair` `{code, deviceName}` → token
- `GET /api/v1/session` → device information and the list of allowed operations
- `POST /api/v1/invoke` `{channel, arg}` → an operation (channels are `MOBILE_CHANNELS` in `src/mobile-server.js`)
- `GET /api/v1/events` → Server-Sent Events (`board:changed`, `card:log`, and so on)
- `GET /api/v1/poll?after=<seq>&epoch=<epoch>` → the same events by long polling (waits up to 25 seconds). Quick Tunnel does not pass the body of Server-Sent Events, so the phone page switches to this when no `hello` arrives over SSE within a few seconds
- `POST /api/v1/logout`

Authentication is `Authorization: Bearer <token>`.

[← Back to README](../README.md)
