# Extensions

A centered panel for extensions, tools, and settings. Uses the current Pi theme.

## Open

Run `/reload` after installation or an update. Open with **`/extensions`** or **Ctrl+Shift+X**. Ctrl+X retains its built-in copy action.

## Navigation

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Change section |
| ↑ / ↓ | Select an item |
| Enter / → | Focus the selected item’s details |
| ↑ / ↓ in details | Move the reading cursor; scroll when it reaches the edge |
| Escape / ← in details | Return to the item list |
| Escape in the list | Close |
| Space | Change the selected tool, setting, or extension loading rule |
| Enter on the Settings row | Open that extension’s inline settings |
| ↑ / ↓ while editing settings | Select a setting |
| ← / → while editing settings | Change its value |
| Enter / Space while editing settings | Cycle its value |
| d | Show or hide technical notes and source paths |
| / | Search names and descriptions |
| Enter / Escape during search | Finish editing the filter |
| Backspace outside search | Clear the filter |

Enter never launches or prepares extension commands. Commands and usage notes are documentation only. No Page Up or Page Down keys are needed.

The panel is capped at 104 columns and 45 rows (50% taller than the previous 30-row maximum). It fits within smaller terminals. Wide layouts show the list and details side by side; narrow layouts show details after Enter.

## Extension loading

Local extensions appear first; built-ins appear last. Each group is sorted by name.

Space requests confirmation, then saves an exact inclusion or exclusion to the global Pi `settings.json`, preserving unrelated settings. Run `/reload` to apply. Reloading may restart integrations or the sandbox. The panel cannot disable itself.

“Loaded commands or tools detected” means Pi’s registry reports resources from that source. “Discovered; load status unverified” means a local entrypoint was found, but Pi exposes no public complete loaded-extension registry. Hook-only package or CLI extensions may not appear. Project-local files are inspected only in trusted projects. Project and CLI rules can override global rules.

## Tools

Descriptions, parameter types, required fields, exposure, and source paths come from Pi’s registry. Space changes model visibility. Tool switches are blocked while a response is running.

By default, switches affect the current runtime. Enable **Remember tool switches** to persist the off-list in `~/.pi/agent/extensions-manager.json`. It is applied at session start and before subsequent turns. Existing density and tool preferences are read from the previous configuration if needed; the former palette setting is ignored.

Tool visibility is not a security permission. Deferred and codemode tools may remain callable through other tools when model visibility is off. Extension safety hooks are independent of tool declarations.

## Settings

- **List density:** one row per item, or a blank row between items.
- **Remember tool switches:** persist the tool off-list globally.
- **Tool output:** expand or collapse tool results in the current session.

The Settings section also includes 15 Pi settings: thinking visibility, startup display, prompt-cache warming, cache notices, editor and transcript padding, autocomplete rows, hardware cursor, inline images, scrollbar, copy-on-select, automatic compaction, automatic retry, double-Escape behavior, and Mermaid rendering. Space cycles the available values. These are global settings; run `/reload` to apply. Project settings can override them.

## Per-extension settings

Select an extension and press **→**. The right pane’s divider and header use the theme accent, and its header shows **Details · selected**. Use **↑/↓** to move the visible reading cursor to **Settings →**, then press **Enter** to open the controls.

Settings remain in the same pane: **↑/↓** selects a setting and **←/→** changes its value. Enter or Space also cycles values. Escape returns to the Settings row, then to the list. No shortcut or separate Pi setting picker is needed.

Names and values are aligned, the selected setting’s description appears beneath the controls, and volume and time values include units. Changes save immediately; a reload is still required to apply extension preferences. Available settings:

- **notify:** completion sound, permission sound, volume.
- **clear-on-quit:** clear screen, clear scrollback.
- **git-checkpoint:** checkpoint creation, restore prompt on fork. Disabling the prompt skips restoration; it never auto-restores.
- **status-footer:** custom footer, clock, API cost.
- **session-time-limit:** time-limit enabled, default minutes. Resumed sessions may retain a session-specific limit.

Changes are stored under `extensionPreferences` in global `settings.json`, except time-limit settings, which use the extension’s existing `sessionTimeLimit` configuration. All require `/reload`. Extensions without a settings adapter do not show a Settings row. Existing extension commands remain available independently.

## Tests

```sh
node --test ~/.pi/agent/extensions/extensions-manager/extensions.test.mjs
```

Tests use an isolated temporary agent directory and Pi’s real light/dark theme renderers. They check discovery, settings preservation, dimensions, arrow-based detail scrolling, inline setting edits without Pi pickers, command-launch removal, tool switches, busy-state rejection, search, technical-detail visibility, and loading confirmation. The resolver targets this machine’s Pi 1.5.2 installation.

For a plain-text layout preview, run with `EXTENSIONS_PREVIEW=1`; the test writes `/tmp/extensions-preview.txt`.
