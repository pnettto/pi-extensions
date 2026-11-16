# Sharing Pi behavior safely

This is a public **source repo**, not a backup of `~/.pi/agent`.
The existing extension layout is intentionally retained to avoid breaking imports,
VM build scripts, tests, and existing installations. The repository name need not change.

## On this computer

Edit reusable extensions and prompts here, then `/reload` in Pi. Keep personal
values, credentials, generated reports and logs outside this checkout.

- `prompts/`: generic instructions, never real report output or personal context.
- `defaults/settings.json`: selected non-secret defaults only; not live settings.
- `defaults/keybindings.json`: shared shortcuts.
- `resources.json`: explicit resources connected by setup. It is not a wildcard.
- `public-files.json`: exact files permitted in the Git index. New files require
  deliberate addition after reviewing their contents. An allowlist entry is NOT
  proof that an existing file cannot acquire secrets later.

Run `python3 scripts/setup.py` for a preview. Use `--apply` to connect resources.
Existing different files are never overwritten. `--adopt-identical` backs up
identical regular files under the PRIVATE agent directory, then links them.
Live settings stay local: setup only fills missing defaults, recursively, and
never copies local settings back into this repository. Later changes to defaults
will NOT override existing settings; apply those deliberately on each device.
Do not choose an agent directory inside this public checkout.

## Another computer (macOS/Linux)

1. Install Pi, Python 3, Git, and Gitleaks (`brew install gitleaks` on macOS;
   elsewhere install Gitleaks from its official distribution).
2. Clone `https://github.com/pnettto/pi-extensions.git` into `~/.pi/config`.
3. Run `python3 ~/.pi/config/scripts/setup.py` and review the preview.
4. Run the same command with `--apply`.
5. Sign into Pi and configure private integrations locally. Run `/reload`.

Setup creates individual symlinks for approved extensions/prompts/shortcuts;
private prompt files and unlisted extensions are left alone. New computers need
integration-specific dependencies too: Gondolin requires its own npm install,
VM build and supported host; macOS keychain integrations are not portable as-is.
The notification sound is NOT distributed; install your own licensed sound at
`~/.pi/agent/sounds/Kalimba.mp3`. Credentials are never synchronized.

To sync: commit/push here, pull elsewhere, rerun setup, then `/reload`.
No automatic commit, push or upload is performed by setup.

## Before publishing

Setup installs pre-commit and pre-push hooks. Both fail closed when Gitleaks is
missing or reports a finding. They check exact paths, reject symlinks/submodules,
scan staged blobs (not merely working files), and scan all locally referenced
Git history. Pre-push additionally checks historical paths. CI repeats checks,
but CI is detection AFTER upload, not a prevention boundary.

1. Review `git diff` and `git diff --cached` for personal/confidential material.
2. Add only intended files; approve new paths in `public-files.json` explicitly.
3. Run `python3 scripts/check-public.py --history` after staging.
4. Commit, review outgoing commits, then push normally. Do not bypass hooks or
   use unattended `/yolo` publishing in this repository.

Hooks can be bypassed and scanners cannot understand all sensitive prose. There
is no absolute guarantee. Keep GitHub secret scanning/push protection enabled
where available. A newly cloned device MUST run setup to install local hooks.
Do not add Gitleaks exclusions simply to make a check green. If a real secret
was published, revoke/rotate it first; deleting the current file is insufficient.

## Existing code: important limits

The initial allowlist inventories existing tracked files; it is NOT a completed
privacy/security audit of those files or history. In particular, Hawk currently
names a personal service endpoint in code. The endpoint isn't a credential, but
this integration needs local configuration before this becomes a generic setup.
Review existing personal URLs and workflows before the next publication.

Extension development contract:
- source and generic defaults live here;
- secrets come from environment/keychain;
- personal configuration and runtime writes go to the agent directory, NEVER
  an extension's source directory;
- tests use temporary directories, not real credentials;
- dependencies, VM images, caches and generated outputs are never approved files.

Most current runtime writes use the agent directory, not source. This was a
focused inspection, not a complete audit. A custom agent directory is respected
by setup, but several existing extensions still hard-code `~/.pi/agent`.
