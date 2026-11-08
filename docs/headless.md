[English](headless.md) · [日本語](headless.ja.md)

# Headless mode (run without a window)

Headless mode keeps Worktree Kanban running without opening a window. While the app window is closed, or on a Linux server with no display (a VPS, for example), the following keep working:

- The task scheduler
- Issue watching, and the tasks it starts
- Starting tasks from Slack, and notifications to Slack (approvals and answers also work with the Slack buttons)
- The remote control host (operate the board from the app on another PC, over SSH)
- The mobile web page (if you enabled it earlier in the desktop app)

Headless mode is the same app as the desktop app, started with `--headless`. It uses the same board data as the desktop app.

It has been checked on macOS and on Linux (Ubuntu 24.04, no display). Windows accepts the same flags, but it has not been checked yet.

## Start it

| OS | Command |
| --- | --- |
| macOS | `"/Applications/Worktree Kanban.app/Contents/MacOS/Worktree Kanban" --headless` |
| Linux (tar.gz) | `./worktree-kanban-headless` (inside the extracted folder) |
| Linux (AppImage) | `./worktree-kanban-x.y.z-linux-x86_64.AppImage --headless` |
| Windows | `"%LOCALAPPDATA%\Programs\Worktree Kanban\Worktree Kanban.exe" --headless` |

Once started, status and notifications are written to the log (standard output), one line each: the start, the remote control host (its port and the 6-digit pairing code), the Slack connection, and every notification. The log lines are in Japanese for now.

Options:

| Option | What it does |
| --- | --- |
| `--headless` | Starts in headless mode. The environment variable `WORKTREE_KANBAN_HEADLESS=1` does the same |
| `--remote-host[=port]` | Starts the remote control host (default port 17831). It listens only on `127.0.0.1`; the controlling PC connects over SSH |
| `--secrets-file=path` | Where the token file is (see "Tokens" below). You can also set it with the environment variable `WORKTREE_KANBAN_SECRETS_FILE` |
| `--user-data-dir=path` | Keeps the board data in a different place |

### Run it on a Linux server

1. Download `worktree-kanban-x.y.z-linux-x64.tar.gz` from Releases and extract it
2. Install the missing libraries (example for Ubuntu 24.04)

   ```sh
   sudo apt-get install -y libnss3 libgbm1 libasound2t64 libgtk-3-0t64 git
   ```

3. Install the agent CLIs you use (`claude` and so on) and `gh`, and sign in to them on the server. The agents run on the server
4. Start it with `./worktree-kanban-headless --remote-host`

`worktree-kanban-headless` is a script that starts the app with `--headless`. Just extracting the tar.gz does not set up the Chromium sandbox (`chrome-sandbox`), so in that case the script also adds `--no-sandbox`. Headless mode opens no web pages, so running without the sandbox is fine. To use the sandbox, run `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.

The log may show D-Bus errors (`Failed to connect to the bus`). They do not affect anything.

## First setup (connect with remote control)

Headless mode has no screen, so you open repositories and set up integrations from the app on your own PC, using [remote control](remote.md).

1. Start the server with `--remote-host` and note the 6-digit pairing code in the log. The code is valid for 10 minutes. When it expires, `kill -USR2 <pid>` shows a new one
2. In your local app, open RC settings and connect to the server "via SSH" (port 17831). Enter the code to pair
3. On the host tab, open repositories, set up Slack and others under "Integrations" in the settings, and create schedules

Once paired, you can connect again without a code. A host started once with `--remote-host` starts again automatically on the next launch.

## Tokens

Tokens for Slack and the other integrations are looked up in this order, and the first one found is used:

1. Environment variables
2. The token file (by default `headless.env` in the data folder)
3. Tokens saved from the desktop app or over remote control (encrypted with a key from the OS secure storage)

Linux servers often have no keychain (GNOME Keyring and the like), so 3 is not available there. Use 1 or 2 instead.

| Integration | Environment variable |
| --- | --- |
| Slack (Bot Token) | `WORKTREE_KANBAN_SLACK_BOT_TOKEN` |
| Slack (App-Level Token) | `WORKTREE_KANBAN_SLACK_APP_TOKEN` |
| GitLab | `WORKTREE_KANBAN_GITLAB_TOKEN` |
| Linear | `WORKTREE_KANBAN_LINEAR_API_KEY` |
| Jira | `WORKTREE_KANBAN_JIRA_TOKEN` |
| Named tunnel for the mobile page | `WORKTREE_KANBAN_MOBILE_NAMED_TUNNEL_TOKEN` |

At startup, the log shows which names were read and from where (never the values).

The token file has one `NAME=value` per line.

```sh
# ~/.config/agent-kanban/headless.env
WORKTREE_KANBAN_SLACK_BOT_TOKEN=xoxb-...
WORKTREE_KANBAN_SLACK_APP_TOKEN=xapp-...
```

- Make the file readable only by you (`chmod 600`). If others can read it, or it belongs to another user, the app does not read it and stops
- The data folder is `~/Library/Application Support/agent-kanban` on macOS, `~/.config/agent-kanban` on Linux, and `%APPDATA%\agent-kanban` on Windows
- Integration settings other than tokens (the notification channel, allowed users, the channel-to-project map and so on) are entered over remote control under "Integrations" in the settings. A token field shows as set when the token is in an environment variable or the file

## Approvals and questions

Even when nobody is watching, approval requests and questions from agents **wait until an answer comes**. Nothing is allowed or denied on its own.

- If "Notify when waiting for you" is on in the Slack integration and a "Channel ID for notifications" is set, they are posted to that channel. Tasks requested from Slack are posted to their thread
- People listed in "Slack user IDs that can start tasks, approve, and answer" can allow, deny, and answer with the buttons in the notification. When the full input cannot be shown in Slack, the request can only be denied from Slack
- You can also answer from remote control or the mobile page

If Slack is not connected, or the notification channel is empty, the log says so at startup.

## Relationship with the desktop app

The desktop app and headless mode cannot run at the same time on the same machine. Running the same board in two apps would run tasks and schedules twice.

- If you open the desktop app while headless mode is running, it shows the reason and quits. Stop headless mode first
- If you start headless mode while the desktop app is running, it writes the reason to the log and quits (exit code 1)

## Stop it

Stop it with `Ctrl+C` or `kill <pid>` (SIGTERM). Running tasks are interrupted, and their changes so far are committed to the task branch before it quits. After the next start, continue them with "Resume" on the task. If cleanup hangs, sending the signal again quits without waiting.

### Start automatically with systemd (example)

The app does not register itself to start automatically. Here is an example for Linux.

```ini
# ~/.config/systemd/user/worktree-kanban.service
[Unit]
Description=Worktree Kanban (headless)
After=network-online.target

[Service]
ExecStart=%h/worktree-kanban/worktree-kanban-headless --remote-host
Restart=on-failure
# Send SIGTERM only to the main process, and wait until tasks are committed
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

Start it with `systemctl --user enable --now worktree-kanban`, and follow the log with `journalctl --user -u worktree-kanban -f`. To keep it running after you log out, run `loginctl enable-linger`.

## Updates

Headless mode does not install new versions automatically. When a new version is out, the log says so. Stop it, replace it with the new version, and start it again.

[← Back to README](../README.md)
