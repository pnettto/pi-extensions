# pi extensions

My personal extensions for the [pi coding agent](https://github.com/earendil-works/pi). Drop this folder at `~/.pi/agent/extensions/`.

| Extension | What it does |
|---|---|
| `extensions-manager/` | `/extensions` or `ctrl+shift+x`: extension loading rules, tool switches, searchable details, and display settings; Enter focuses details and arrows scroll |
| `file-explorer.ts` | VS Code–style file tree side panel (`ctrl+f`, `.` toggles hidden files); tree and Git status auto-refresh every 3 seconds while visible |
| `git-changes.ts` | Source-control side panel with stage/unstage and diff viewer (`ctrl+g`, `.` toggles ignored files) |
| `git-checkpoint.ts` | Stash checkpoints each turn so `/fork` can restore code state |
| `yolo.ts` | `/yolo [notes]` — has the agent commit, push, and run the project's deploy command |
| `commit-gate.ts` | Asks before the agent runs `git commit` |
| `permission-gate.ts` | Requires approval for literal `rm` and other matched dangerous bash commands, with optional session allowance for removals |
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

## Shell deletion approval

`permission-gate.ts` intercepts the agent's `bash` tool before execution. It does
not treat a user request such as “remove that file” as approval. Matched calls
require **Yes, run it**, unless removal approval was explicitly granted for the
session. Removal-only dialogs also offer **Allow in this session**. No, dismissal,
UI failure, aborted approval, or no UI blocks unapproved execution.
TUI and RPC clients can provide approval UI; print/JSON calls are blocked.

**Allow in this session** authorizes subsequent removals across `/workspace`,
`/cache/npm` and `/cache/deno`, including renames and replacements. The grant is
shared between command preflight and the filesystem gate, so choosing it in
either dialog avoids repeated removal prompts in both layers. It does not
approve unrelated dangers such as sudo, force-push, deploy or publish; mixed
danger command dialogs do not offer the session option. State is process-memory
only and resets on session start/shutdown, including new, resume, fork and
reload. Pending approvals cannot revive a grant after a reset.

The gate runs with either backend. Gondolin is not a disposable copy of the
project: `/workspace` is a writable `RealFSProvider` mount of the host working
directory. Deleting there deletes the host file too.

### Incident and execution path (Pi 1.5.2)

1. Provider tool `functions.bash` reaches Pi's logical `bash` tool.
2. `AgentSession._beforeToolCall` (`dist/core/agent-session.js`) emits `tool_call`
   through `ExtensionRunner.emitToolCall`. A block prevents the backend from
   being invoked, including registered overrides and nested tool calls.
3. `gondolin/index.ts` registers a `bash` override, builds `createBashTool` with
   `createGondolinBashOps`, and executes `vm.exec([shellPath, "-lc", command])`.
4. The workspace mount writes the operation through to the host. Credential
   approval in `credentials.ts` governs outbound credentials, not filesystem work.

Approval was absent for two independent reasons: the old permission extension
returned before registering its hook unless host mode was explicitly selected,
and its rm pattern required force/recursive options. Plain `rm -- file` would
therefore also have missed approval in host mode. Both restrictions are removed;
the other existing dangerous-command patterns now apply in Gondolin too.

### Coverage and limits

There are now two independent gates:

- `permission-gate.ts`: command preflight, before any part of a recognized
  dangerous bash call executes (host or Gondolin).
- `gondolin/deletion-gate.ts`: host-mount filesystem enforcement, immediately
  before each `unlink`, `rmdir` or `rename` is delegated to the real host FS.
  Every host-backed mount is wrapped: `/workspace`, `/cache/npm`, `/cache/deno`.

The rm tripwire scans the **whole command**, so literal rm is covered inside
`bash/sh -c`, `env`, `command`, `exec`, `busybox`, `xargs`, `find -exec`, remote
shell strings, pipelines, conditionals, subshells, substitutions, loops and
semicolon/newline-separated commands. Absolute paths, simple quoting, escaped
letters and line continuations are recognized. It gates the entire tool call
before any part executes, not individual commands after earlier parts ran.
Conservative scanning can also prompt for rm in quoted data or comments.

**The filesystem gate does not inspect command text.** Guest filesystem RPCs
for removal converge on the protected providers, including `rm`, `unlink`,
`rmdir`, `find -delete`, Python/Node filesystem APIs, generated commands, scripts,
package-manager cleanup, and user-entered `!`/`!!` commands. Without a session
grant, each actual unlink, directory removal or rename requires **Yes, this
operation**. One-time command approval does not authorize filesystem operations;
**Allow in this session** does. Recursive removals prompt for every entry unless
a session allowance was chosen, and can partially complete if some operations
are approved and later ones denied.

All renames are gated, including moves to unused destinations: renaming removes
the source name and can replace a destination. Avoiding an existence check also
avoids an authorization race. Atomic-save tools, git and package managers may
therefore prompt for renames and temporary-file cleanup. Concurrent filesystem
dialogs are serialized across mounts. Denial, dismissal, UI errors, no UI,
cancellation or session replacement fail closed with EACCES. Host-side sync
provider removal methods always deny because they cannot await approval;
synchronous guest syscalls still use asynchronous filesystem RPCs and can prompt.

**Remaining boundaries:** This protects removal of entries on Gondolin's
host-backed mounts, not all forms of data loss. Writes, overwrites, truncation
and edits to file contents remain allowed; this is not backup/ransomware
protection. The VM's private disk is outside the policy. Host mode (`--no-vm`,
`--no-gondolin`, `PI_NO_GONDOLIN`) has only the lexical command gate, not this
filesystem enforcement. Trusted extensions/direct host processes can also bypass
the mount layer. Do not select host mode for robust deletion protection. Some
destructive git/SQL/disk commands still have independent preflight patterns.

### Activation and regression checks

Use `/reload` or restart Pi after changing the extension. Reloading also restarts
Gondolin and discards VM-local ephemeral state; it does not undo host changes.
No image rebuild or Pi package patch is needed. The protection requires this
global extension to remain loaded; disabling extensions disables the gate.

Run with Node 24+ from this directory:

```sh
node --test tests/*.test.mjs
```

Tests do not execute shell deletion commands, delete host files, or start a VM.
They exercise the hook, wrapper/compound cases, fail-closed decisions, and Pi's
installed `runToolCall` preflight with a mock backend. Filesystem tests use
Gondolin's real `FsRpcService` and in-memory backend to verify denied operations
preserve entries, approved operations proceed, sync entry points deny, concurrent
prompts serialize, and cancellation/session replacement invalidate approval.
Session tests cover cross-gate and cross-mount grants, lifecycle resets, queued
requests, separately loaded helper modules and unrelated dangerous commands.
The integration test uses `~/.pi/agent/install/current-version`;
set `PI_TEST_INSTALL` to another managed install root if needed.
