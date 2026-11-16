# pi extensions

My personal extensions for the [pi coding agent](https://github.com/earendil-works/pi). Drop this folder at `~/.pi/agent/extensions/`.

| Extension | What it does |
|---|---|
| `file-explorer.ts` | VS Code–style file tree side panel (`ctrl+f`, `.` toggles hidden files) |
| `git-changes.ts` | Source-control side panel with stage/unstage and diff viewer (`ctrl+g`, `.` toggles ignored files) |
| `git-checkpoint.ts` | Stash checkpoints each turn so `/fork` can restore code state |
| `commit-gate.ts` | Asks before the agent runs `git commit` |
| `permission-gate.ts` | Asks before destructive bash commands |
| `protected-paths.ts` | Blocks writes/edits to secrets and generated dirs |
| `deepseek-web.ts` | `web_search` / `web_fetch` tools via the DeepSeek API |
| `btw.ts` | `/btw <question>` — ask a side question about the session (even mid-run); answer streams in a tinted overlay where you can type follow-ups; never added to context |
| `questionnaire.ts` | Tool for asking the user multiple-choice questions |
| `session-time-limit.ts` | Per-prompt wall-clock time budget |
| `status-footer.ts` | Richer status bar (git, context, cost, model) |
| `notify.ts` | Chime when pi is done or needs permission |
| `clear-on-quit.ts` | Clears the terminal on exit |
| `gondolin/` | Runs tools inside a sandboxed micro-VM; credentials stay on the host and are injected on approval (`npm install` + `build-image.sh`) |

No secrets live in this repo — tokens are read at runtime from the keychain / CLIs.
