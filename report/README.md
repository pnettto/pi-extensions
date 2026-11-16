# Report generation (no Hawk dependency)

This extension reads local Pi sessions, requests a report from the selected model, and caches the result in `~/.pi/agent/reports/`. It does not retrieve credentials, log into Hawk or upload notes. No automatic task starts when this extension is used alone.

- `/report`, `/report week`, `/report yesterday`: the existing independent prompt template, generating a report in chat.
- `/report-generate [today|yesterday|YYYY-MM-DD]`: background-generate a daily report, cache it locally and display it in chat. Default: today. No uploads.

The report generator exports `generateReport()` for optional integrations. Hawk's separate extension can call it when explicitly posting a report or running its daily automation. The Hawk extension must be enabled for uploads, and the report extension must be enabled for this integration. Either extension can load alone.

Cache files are private JSON with report content and metadata. Today's snapshot and completed-day final report use separate cache keys. Cached outputs are reused rather than regenerated. Empty completed days are remembered; today's empty result is not permanent.

User/assistant session texts go to the configured model provider (normal provider usage may apply), never to Hawk from this extension. Tool-call arguments/results are excluded. Transcript instructions are treated as untrusted data, with model instructions to exclude secrets and recap-only activity. Closing/reloading Pi cancels outstanding command-driven generation; lock files prevent duplicate concurrent generation.
