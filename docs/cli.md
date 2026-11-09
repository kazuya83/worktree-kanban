[English](cli.md) · [日本語](cli.ja.md)

# CLI and MCP

Agents and scripts can create tasks, check their status, and operate them (start, approve, answer, merge, open PRs, delete, run Pipelines) without the window. There are two entry points, and both talk to the same API inside the app:

- `wtk`, a command for your shell and scripts
- `wtk mcp`, an MCP server (stdio) that agents such as Claude Code, Codex, and Cursor can call

## Set up

1. Open Settings > "CLI / MCP"
2. Check "Allow use from the CLI and MCP" (on by default)
3. Click "Install wtk". It writes `~/.local/bin/wtk` (Windows: `%USERPROFILE%\.local\bin\wtk.cmd`). If that folder is not on `PATH`, add it, or call wtk by its full path
4. To use it from an agent, copy the `claude mcp add-json …` command shown there (Claude Code), or add the JSON shown there to the agent's MCP settings

`wtk` runs the app's own executable as Node.js, so nothing else needs to be installed. If you move the app (or replace the AppImage), the app rewrites `wtk` the next time it starts.

## Commands

```sh
wtk status                         # the app, the connection, and the repositories
wtk tasks                          # tasks of the repository that contains the current folder
wtk tasks --all --status review    # tasks in review, in every repository
wtk show <id>                      # one task, with pending approvals and questions
wtk create "Fix the login bug"     # create a task (stays in Todo)
wtk create "Fix the login bug" --start --agent codex
echo "long prompt" | wtk create - --title "Refactor"
wtk pipelines                      # Pipelines of the repository
wtk run-pipeline Review "Add a dark mode"
wtk start|stop|resume <id>
wtk send <id> "Also update the docs"
wtk approve <id> [--always]        # the oldest pending approval (or --req <reqId>)
wtk deny <id> --message "Use the staging DB"
wtk answer <id> --json '{"Which DB?":"Postgres"}'
wtk logs <id> --tail 20
wtk diff <id>
wtk merge <id> [--push]
wtk pr <id> [--base main]
wtk delete <id> --yes              # discard the task, its worktree and branch
wtk call <channel> '<json>'        # any API channel
```

Add `--json` to any command to get JSON. Run `wtk --help` for every option.

Without `--repo`, wtk uses the repository that contains the current folder. Inside a task's worktree, that is the repository the worktree came from. Otherwise it uses the tab open in the app.

## MCP tools

`list_repos`, `list_tasks`, `get_task`, `get_task_logs`, `get_task_diff`, `create_task`, `list_pipelines`, `run_pipeline`, `start_task`, `stop_task`, `resume_task`, `send_message`, `answer_approval`, `answer_question`, `move_task`, `merge_task`, `create_pr`, `complete_task`, `delete_task`

`create_task` leaves the task in Todo unless `start` is true. `delete_task` needs `confirm: true`.

## When the app is not running

If no app is running on this machine, `wtk` (and `wtk mcp`, on the first tool call) starts the app in [headless mode](headless.md) and waits until it is ready. Its log goes to `headless.log` in the data folder. To stop it, use `kill <pid>` (`wtk status` shows the mode). Add `--no-start` to get an error instead of starting it.

If the desktop app is running with "Allow use from the CLI and MCP" turned off, wtk does not start a second app. Turn it on, or quit the app.

## Use from another computer

The API listens only on `127.0.0.1` of the computer running the app. From another computer, forward the port over SSH and pair once with a code:

1. On the other computer: `ssh -N -L 47821:127.0.0.1:47821 <the app's computer>` (the port is shown in Settings > "CLI / MCP")
2. On the app's computer: click "Show a pairing code" in Settings > "CLI / MCP", or run `wtk pair-code`
3. On the other computer: `wtk login --url http://127.0.0.1:47821 --code <code>`

The code works once, for 10 minutes. The token is saved in `cli-login.json` in the data folder (readable only by you) and is valid for a year. After `login`, wtk uses that app; add `--local` to use the app on this computer instead, and run `wtk logout` to forget the token. Paired computers are listed in Settings > "CLI / MCP" (or `wtk devices`) and can be revoked there. Paired computers cannot show pairing codes or revoke others.

The other computer also needs `wtk`. Install the app there and click "Install wtk", or set `WORKTREE_KANBAN_URL` and `WORKTREE_KANBAN_TOKEN` and run `src/kanban-cli.js` with Node.js.

## Security

- The API accepts only requests from `127.0.0.1`, with a token, and without an `Origin` header (web pages cannot call it)
- On the same computer, the token is in `api.json` in the data folder, readable only by you, and changes every time the app starts
- Paired tokens are stored only as SHA-256 hashes
- Settings, folders, and the terminal are not available through the API

## Environment variables

| Name | Meaning |
| --- | --- |
| `WORKTREE_KANBAN_URL` / `WORKTREE_KANBAN_TOKEN` | Use this app and token (same as `--url` / `--token`) |
| `WORKTREE_KANBAN_DATA_DIR` | The app's data folder (set by `wtk`) |
| `WORKTREE_KANBAN_APP` | The executable to start in headless mode (set by `wtk`) |
