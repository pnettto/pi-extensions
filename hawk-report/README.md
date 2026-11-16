# Hawk integration

The only command is **`/hawk`**. With no arguments (or unclassified text), it asks what to do, then guides you through content, title/date and confirmation. All manual content uploads are confirmed before authentication/network writes. Cancelling any prompt stops the operation.

## Agent-callable Hawk tool

The extension also registers a model-only **`hawk` tool**. You can ask the assistant naturally, e.g. “Upload index.html to Hawk”, and it calls:

```json
{"action":"file","path":"index.html"}
```

Supported actions: `note`, `journal`, `task`, `file`, `notepad`, `report`, `status`. Optional fields: `content`, `path`, `title`, `date`, `time`. For text destinations, provide inline content OR a text-file path, not both. `status` is read-only and needs no confirmation; every manual write, including reports, requires approval. Missing UI, denial, dismissal and cancellation block authentication and posting.

Both `/hawk` and the tool call `sendHawk()` in `manual.mjs`: the same validation, host-file handling, approval, authentication and posting flow. The tool waits for completion and returns structured status/IDs/metadata, never passwords or tokens. It emits progress updates while running. Errors do not cause automatic retries. Model instructions explicitly prefer the tool over shell scripts or recreated API logic.

The automatic daily report path retains the user's standing authorization and does not prompt each morning. Manual report requests do prompt. Reload Pi to expose newly registered tools to the model.

## Direct routes

```text
/hawk
/hawk note "An idea worth keeping" --title "Idea"
/hawk journal "What happened today" --date today --title "Daily log"
/hawk task "Review the PR" --date tomorrow
/hawk task "Review the PR" --date 2026-11-17 --time 09:30
/hawk file "/absolute/path/document.pdf"
/hawk notepad "Quick scratch notes" --date today --title "Scratchpad"
/hawk journal --file "report.md" --date yesterday --title "Work report"
/hawk report today
/hawk report yesterday
/hawk status
/hawk help
```

Dates accept `today`, `yesterday`, `tomorrow`, or `YYYY-MM-DD`. Future dates are valid for tasks and dated notes, but not generated reports.

Routes:
- `note`: private standalone note, with no Journal date.
- `journal`: private Journal note tied to a date (default today).
- `task` (alias `tasks`): add daily tasks without replacing existing tasks; multiline content becomes one task per line. Optional `--time HH:MM` applies to each new task.
- `file` (alias `files`): raw file upload to Hawk's private file storage, up to 100 MB. Requires the Hawk deployment's file storage to be configured.
- `notepad`: a note in the day's task-log/notepad section, using the daily notes endpoint. This is separate from the Journal note collection.
- `report`: optional integration with the report extension; generate/cache and post a daily report. Past days are final reports; today creates a separate **so far** snapshot. Existing reports/snapshots are not overwritten.
- `status`: yesterday's automatic report publication state (or a busy indication).

Text routes support `--file path` to read Markdown/text from a host file instead of inline text. Paths resolve on the host relative to Pi's working directory; `~/` is supported. Notes/tasks are limited to 50 KB per request, and task batches to 100 entries. New manual posts create new entries; they are not edit/sync commands. Manual posts are not automatically retried, because an interrupted response may still have saved successfully.

## Automatic daily reports

Automatic posting remains enabled by default until the user asks to disable it. There is **no separate automation command**. First interactive startup each day, or a new message after midnight, requests yesterday's report from the separate report generator and posts a private Journal note. No multi-day automatic backfill, cron or detached daemon.

Generation is independently implemented in `../report/`; it sends session text only to the configured model provider. This Hawk integration sends only the resulting report (or the explicitly selected manual content/file) to Hawk. `/report` remains a separate prompt template for reports in chat.

## Security and persistence

- Origin: https://hawk.pnetto.store . Password: macOS Keychain service `pi-hawk-password`, account = macOS username. Password/token stay in memory, never in model prompts or logs.
- Posting state/locks/settings: `~/.pi/agent/hawk-reports/`. Generator-owned cache: `~/.pi/agent/reports/`.
- Automatic report IDs are stable, with locks and `baseRev: 0` to prevent duplicates or overwriting edited/trashed reports.
- Private notes/journal entries explicitly use `isPublic: false`. Tasks and notepad notes use authenticated daily-log endpoints. File uploads are not marked public or inline.
- Failed automatic reports retry on a later startup/message (ten-minute in-session cooldown). Empty completed days are skipped. Generic manual posts do not use automatic retry.
- Host execution outside Gondolin. Pi must stay open; shutdown/reload cancels work. Print/JSON/RPC startup does not launch automation.
- Existing `settings.json` with `automatic: false` remains respected; changing automation is a local configuration change, not a slash command.

API contracts verified against:
- https://github.com/pnettto/hawk/blob/main/server/routeHandlers/notes.ts
- https://github.com/pnettto/hawk/blob/main/server/routeHandlers/app.ts
- https://github.com/pnettto/hawk/blob/main/server/routeHandlers/files.ts

Activate changes with `/reload`.

```sh
node --test ~/.pi/agent/extensions/hawk-report/*.test.mjs
```

Tests use mocked HTTP and temporary files. They do not upload live notes/tasks/files.
