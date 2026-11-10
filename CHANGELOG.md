# Changelog

Notable changes to Worktree Kanban (named Agent Kanban before 0.1.84). This file is a summary, grouped by version range. The notes for every single version, with download links, are on the [Releases](https://github.com/kazuya83/worktree-kanban/releases) page.

Each release that changes the app raises the last number of the version. There is no separate compatibility promise while the version is 0.x.

## Unreleased

### Added

- Custom board columns and lanes (Settings > "Board columns", per project): add, remove, rename, and reorder columns (drag the ⠿ handle or use the ↑ / ↓ buttons), and split a column into lanes stacked top to bottom, which can be reordered the same way (for example, Done and Close under Done). Every column and lane needs a plain-language description. When you save, AI converts the descriptions into a stage (Todo, Running, Review, Done), conditions (merged, PR closed, CI result, waiting for you, and so on), and the columns a card may move to next; you check the result before it is saved to `.worktree-kanban/board.json` in the repository, so the team can share it by committing it. Cards are sorted into columns and lanes automatically by those conditions, without calling AI each time. Cards can be dragged only to the allowed next columns or between lanes of the same column, and a card moved by hand is sorted again when its state changes. The phone page shows the same columns and lanes. Without the file, the board keeps the usual four columns.
- CLI and MCP: `wtk` creates tasks, lists them, shows their status, and operates them (start, stop, resume, follow-up instructions, approvals, answers, merge, PRs, delete, Pipelines) from the shell and scripts, and `wtk mcp` offers the same as an MCP server for agents. Install `wtk` from Settings > "CLI / MCP", which also shows the MCP settings to copy. If the app is not running, wtk starts it in headless mode. The API listens only on 127.0.0.1; other computers pair with a one-time code and connect over an SSH tunnel. See [docs/cli.md](docs/cli.md).
- "Mark done" for tasks in a git repository: the top of the detail panel has a "Mark done" button next to Merge / Create PR, so a task can be finished without merging or opening a PR. If the worktree has no changes, its worktree and branch are cleaned up; if it has changes, they are kept and the task can be moved back to Review. Tasks marked done this way show "Done" instead of "Merged".
- Progress at a glance: each agent is drawn as a pixel-art robot. On the board, the card of every started task shows the robot at a desk with a speech bubble for what it is doing now (editing, running a command, searching, and so on), a blinking antenna while it waits for you, and a segmented TODO bar. In the Progress tab, the robot walks a road of TODO flags to the current TODO, waits before the finish line while the task is in review, and jumps at the goal under confetti when it is done. Each agent has its own color, and custom agents use theirs. With "Reduce motion" on, the robot is drawn still.
- PR review comments: unresolved line comments, review bodies ("Request changes" and comments), and conversation comments on the task's PR, including those from bots, are shown on the card with an "Ask to fix" button. The agent fixes them, the app pushes, then replies to and resolves each line-comment thread and posts one combined reply for the other comments. Comments already handled are not picked up again. A project setting (off by default) fixes new comments automatically, up to 3 times in a row. GitLab merge requests work the same way (unresolved discussions and notes).
- Pipeline and competition are no longer mutually exclusive: both can always be set up, and the "Agent" field when creating a task lists single agents, custom agents, Pipelines, and competitions together. The "Orchestration to use" choice is removed. Each project can have any number of competitions, each with its own name and agents; the earlier "agents to compete" become the first one. "Selected by default for new tasks and chats" can now also be a Pipeline or a competition (conversations, and tasks where it cannot be used, get the first of the agents to use); the Pipeline "Make default" button is removed.
- Built-in browser: the "Browser" tab in the detail panel opens the task's development server on its own port (`WORKTREE_KANBAN_PORT`) and can start it with the run script. In Design Mode, click elements on the page to send their HTML, CSS and screenshots to the agent along with what you want changed.
- Use from your phone: from anywhere, see the board in a phone browser (iPhone and Android), create and start tasks, send follow-up instructions, approve, and answer questions. The app starts Cloudflare Tunnel (`cloudflared`, Quick Tunnel or a named tunnel), so no port forwarding is needed. Phones pair with a one-time QR code, tokens expire after 30 days, and each phone can be revoked. Merging, PRs, and settings are not available from the phone. The phone page uses a versioned HTTP API (`/api/v1`) that a future native app can also use.
- The agent selected by default for new tasks and conversations can now be one of the project's custom agents, and it is remembered per project. Existing projects keep the value used so far. If the chosen custom agent is deleted or its base agent is unchecked, the first of the agents to use is selected.
- A guide for moving from Conductor, with the steps to export Conductor Cloud data first (English and Japanese).
- Branch per sprint (project setting, off by default): when on, each sprint gets a branch (`sprint/<name>-<ID>`) created from the base branch when its first task starts. Tasks in the sprint start from that branch and merge (or open PRs) into it. A task in several sprints uses the sprint you choose in its "Sprint" dialog; if none is chosen, it starts from the base branch. The sprint shows its branch with "Merge into base" and "Create PR" buttons; completing a sprint does not merge anything by itself.
- Headless mode (`--headless`): keeps the scheduler, Issue watching, Slack, the remote control host, and the mobile page running without a window, including on a Linux server with no display. Approvals and questions wait until answered and are posted to Slack. Tokens can come from environment variables or a token file readable only by you (`chmod 600`). The desktop app and headless mode refuse to run at the same time on one machine. A Linux `tar.gz` with a `worktree-kanban-headless` launcher is added to the release files. See [docs/headless.md](docs/headless.md).
- Share project settings with your team: put the project's settings (setup, teardown, and run scripts, ports, base branch, how to land, permissions, Pipelines, custom agents, competitions, and more) in `.worktree-kanban/settings.json` in the repository. Settings > "Share with team" writes the file from the current settings. Items in the file use the file's value; items changed in Settings on a PC become overrides for that PC and can be put back to the file's value. Scripts from the file ask before they run the first time and whenever they change. The first port and the number of ports per task are now project settings (`WORKTREE_KANBAN_PORT_COUNT` tells scripts the number).
- Terminal panel: the tabs at the bottom can be dragged to change their order. The order is kept after reloading the window.

### Security

- Tasks created from Issues and tasks requested from Slack, including their subtasks and relay branches, never run with "Allow everything automatically". They run with `acceptEdits` (file edits automatic, commands need approval) even when the project's permission mode is `bypassPermissions`, so a malicious Issue cannot run commands without approval. The card log says so when this applies.

### Fixed

- Claude Code: an instruction starting with `/chrome` no longer ends with "/chrome isn't available in this environment.". The app removes `/chrome` and starts Claude Code with `--chrome` (Claude in Chrome), and keeps it on for later runs of the same task. Skills (`/skill-name`) now also work when the app language is not Japanese.

## 0.1.96

### Changed

- Clicking outside the detail panel, on its left, closes it.

## 0.1.95

### Added

- Integrations with GitLab, Linear, and Jira, including self-hosted GitLab and Jira Data Center: create tasks from Issue numbers or URLs, link Issues in PRs and MRs, sync status with the card, write comments back, and handle sub-issues.
- GitLab merge requests: create them, check conflicts and pipeline results, and detect merges.
- Slack integration: notifications for completions, failures, and items waiting for you, and starting tasks from Slack for allowed users only. Nobody can start a task by default.
- Approving and answering from Slack: buttons on notifications for permission checks, agent questions, spec checks, and replies, limited to allowed users. Slack offers Allow only when the full tool input can be shown. Needs "Interactivity & Shortcuts" turned on in the Slack app.
- An "Integrations" section in Settings. Tokens are encrypted with a key from the OS secure storage.
- In-card approval for Codex (`codex app-server`) and Cursor (`cursor-agent acp`). Versions that do not support it keep the previous behavior.

## 0.1.94

### Added

- Antigravity CLI as an agent.

## 0.1.93

### Added

- Checkpoints: restore a task to the point before a Pipeline step or an agent run. Files, Pipeline progress, and the conversation go back together.

## 0.1.92

### Added

- Watch Issues on a schedule and create a card for each new Issue.
- More feature GIFs on the website.

### Changed

- The README and website now lead with chaining agents into flowcharts.
- Improved the detail panel layout.

## 0.1.91

### Added

- A guide for moving from Vibe Kanban (English and Japanese).
- "Agents to use" in Settings: pick the agents you use, so the app no longer assumes Claude Code.

## 0.1.90

### Added

- Ports per task: each worktree gets 10 ports, so parallel development servers do not collide.
- `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md`.

## 0.1.89

### Added

- English versions of the documents in `docs/`.

## 0.1.88

### Added

- Setup and cleanup scripts for worktrees, and a run button.

## 0.1.87

### Added

- Send line comments on a diff to the agent.

## 0.1.86

### Added

- Show CI results, and fix failures automatically.

## 0.1.85

### Changed

- The license changed from MIT to [FSL-1.1-ALv2](LICENSE). Each version becomes available under the Apache License 2.0 two years after its release. Versions up to 0.1.84 stay under MIT.

## 0.1.84

### Changed

- Renamed from Agent Kanban to Worktree Kanban. Existing data, SSH keys, and updates keep working.
- Added an MIT `LICENSE` file, and a README, screenshots, a demo GIF, and a website in five languages.

## 0.1.83

### Added

- The app is available in English, Spanish, French, and Simplified Chinese, as well as Japanese.

## 0.1.75 – 0.1.82

### Added

- Task scheduler: create and run tasks at a set time (0.1.80).
- Edit a Pipeline flowchart in natural language (0.1.77).
- Copy button on code blocks (0.1.79).
- Labels on cards for subtasks that a Pipeline creates (0.1.82).

### Changed

- Links open in the default browser (0.1.78).
- Settings moved to a full-screen tab in the top-bar menu (0.1.81).

## 0.1.55 – 0.1.74

### Added

- Choose the model for each task or conversation (0.1.55).
- Projects without git (0.1.56), and tasks that do not change source files (0.1.74).
- Settings per repository (0.1.59).
- Pipelines as flowcharts (0.1.60), several Pipelines in one repository (0.1.67), and names for them (0.1.71).
- Custom agents (0.1.61).
- Progress tab (0.1.64).
- Subtasks that run in parallel or in order, with progress shown, and the option to start a single one (0.1.68 – 0.1.70).

## 0.1.33 – 0.1.54

### Added

- Remote control: operate the board from another PC (0.1.33), over an SSH tunnel (0.1.34), with SSH key creation in the app (0.1.36) and reconnecting to the previous destination (0.1.37).
- Image and file attachments (0.1.39).
- Several repositories open as tabs (0.1.44).
- Chat tab in the task details (0.1.45).
- App update from settings, with an automatic update option (0.1.47).

### Changed

- Release notes list the changes since the previous version under headings (0.1.50).

### Fixed

- Several problems when using chat and repository tabs during remote control (0.1.51 – 0.1.54).

## 0.1.19 – 0.1.32

### Added

- WSL repositories on Windows (0.1.19).
- Codex CLI and Gemini CLI (0.1.21), and Cursor CLI (0.1.24).
- Spec check: work out the details of a vague task in a conversation (0.1.21).
- Combinations of several agents (0.1.21 – 0.1.23), and customizable Pipelines (0.1.29).
- Clone from a URL or create a new repository in the app (0.1.31).

## 0.1.9 – 0.1.18

### Added

- Update the status of GitHub Issues automatically or from the app, with a configurable status field (0.1.9 – 0.1.15).
- Choose between merging directly and creating a PR (0.1.9).
- File tree in the diff tab (0.1.9).
- Continue the conversation after a task finishes (0.1.9).
- Conversations that are not tied to a task (0.1.13), and a notification center (0.1.13).
- Natural-language branch naming rules (0.1.14).
- Resolve PR conflicts in the app (0.1.15).

### Security

- Validated outside input such as branch names, session IDs, and approval tokens (0.1.14).

## 0.1.0 – 0.1.8

### Added

- First release: a kanban board that runs Claude Code in parallel, one git worktree per task, with approval on the card.
- Desktop builds and one-line installers.
- Create tasks from GitHub Issues (0.1.1).
- Send messages to a running agent with btw (0.1.2).
- Pick a past conversation (0.1.3) or a skill (0.1.4) for a task.
- Answer agent questions from the card (0.1.5).
- Push after a merge, and resolve conflicts (0.1.6).
- Tab that shows the work in each worktree (0.1.7).
