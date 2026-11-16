import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// shared with git-changes.ts
const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "side-panels.json");
const HIDDEN_EVENT = "side-panel:show-hidden";
function loadShowHidden(): boolean {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).showHidden !== false;
	} catch {
		return true;
	}
}
function saveShowHidden(v: boolean) {
	try {
		let cur: any = {};
		try {
			cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
		} catch {}
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, showHidden: v }, null, 2) + "\n");
	} catch {}
}

/**
 * VS Code–style file explorer docked on the right side of the TUI.
 *
 *   ctrl+f              toggle the panel (open + focus / close)
 *   (ctrl+f cursor-right is moved to the → key only in ~/.pi/agent/keybindings.json)
 *   /explorer           open, or re-focus an open panel
 *   /explorer close     close the panel
 *
 * When focused:
 *   ↑/↓ j/k   move          →/l/enter   expand dir
 *   ←/h       collapse/up   enter (file) add @path to the message (focus stays)
 *   r         refresh       .            toggle hidden files
 *   c         clear change markers
 *   o         open selected file/folder in the macOS default app (Finder for folders)
 *   esc       back to editor (panel stays)   q   close panel
 *
 * Mouse (pi fullscreen mode, the default):
 *   click file    open it in the macOS default app
 *   click folder  expand / collapse
 *   wheel         scroll the tree
 *   click outside close the panel
 *   Clicks never take keyboard focus, so typing keeps going to the chat input.
 *
 * Files changed by the agent (write/edit tools) are marked A/M and their
 * folders are auto-expanded; git status decorations are shown when in a repo.
 */

const PANEL_WIDTH = 36;
const MIN_TERM_WIDTH = 90;
const MAX_DIR_ENTRIES = 500;
const GUEST_WORKSPACE = "/workspace"; // gondolin sandbox mount point

type Mark = "A" | "M" | "D" | "?";
interface Row {
	abs: string;
	name: string;
	depth: number;
	isDir: boolean;
}

export default function fileExplorer(pi: ExtensionAPI) {
	let root = process.cwd();
	const expanded = new Set<string>();
	const agentMarks = new Map<string, Mark>(); // abs path -> mark from agent tool calls
	let gitMarks = new Map<string, Mark>();
	let showHidden = loadShowHidden();
	pi.events.on(HIDDEN_EVENT, (v: unknown) => {
		if (typeof v === "boolean") showHidden = v;
	});
	let selected = 0;
	let scroll = 0;
	let keepSelectionVisible = true; // false after mouse wheel/click so the view isn't yanked back

	let handle: any | undefined;
	let closePanel: (() => void) | undefined;
	let tuiRef: any | undefined;
	let panelComp: any | undefined;
	let unpatchOutsideClick: (() => void) | undefined;
	// Component that had focus before the panel took it (normally the chat editor).
	// Restored explicitly on unfocus: the overlay's own "preFocus" was captured at
	// startup, when nothing was focused yet, so the default unfocus() lost focus.
	let returnFocus: any | undefined;
	let themeRef: any | undefined;
	let lastCtx: ExtensionContext | undefined;
	const pending = new Map<string, { abs: string; existed: boolean }>();

	// ---------- filesystem ----------

	const toHostPath = (p: string): string => {
		let abs = path.isAbsolute(p) ? p : path.resolve(root, p);
		if (!fs.existsSync(abs) && (abs === GUEST_WORKSPACE || abs.startsWith(GUEST_WORKSPACE + "/"))) {
			abs = path.join(root, abs.slice(GUEST_WORKSPACE.length));
		}
		return abs;
	};

	const listDir = (dir: string): Row[] => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => showHidden || !e.name.startsWith("."))
			.map((e) => {
				const abs = path.join(dir, e.name);
				let isDir = e.isDirectory();
				if (e.isSymbolicLink()) {
					try {
						isDir = fs.statSync(abs).isDirectory();
					} catch {}
				}
				return { abs, name: e.name, depth: 0, isDir };
			})
			.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
			.slice(0, MAX_DIR_ENTRIES);
	};

	let rowsCache: Row[] | undefined;
	const rows = (): Row[] => {
		if (rowsCache) return rowsCache;
		const out: Row[] = [];
		const walk = (dir: string, depth: number) => {
			for (const r of listDir(dir)) {
				out.push({ ...r, depth });
				if (r.isDir && expanded.has(r.abs)) walk(r.abs, depth + 1);
			}
		};
		walk(root, 0);
		rowsCache = out;
		return out;
	};

	const markOf = (abs: string): Mark | undefined => agentMarks.get(abs) ?? gitMarks.get(abs);
	const dirHasChanges = (abs: string): boolean => {
		const prefix = abs + path.sep;
		for (const k of agentMarks.keys()) if (k.startsWith(prefix)) return true;
		for (const k of gitMarks.keys()) if (k.startsWith(prefix)) return true;
		return false;
	};

	const refreshGit = () => {
		execFile("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 2000 }, (err, top) => {
			if (err) {
				gitMarks = new Map();
				return;
			}
			const repoRoot = top.trim();
			execFile(
				"git",
				["-C", root, "status", "--porcelain", "-uall"],
				{ timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
				(err2, out) => {
					if (err2) return;
					const m = new Map<string, Mark>();
					for (const line of out.split("\n")) {
						if (line.length < 4) continue;
						const code = line.slice(0, 2);
						let file = line.slice(3);
						if (file.includes(" -> ")) file = file.split(" -> ")[1]!;
						file = file.replace(/^"|"$/g, "");
						const mark: Mark = code === "??" ? "?" : code.includes("A") ? "A" : code.includes("D") ? "D" : "M";
						m.set(path.join(repoRoot, file), mark);
					}
					gitMarks = m;
					invalidate();
				},
			);
		});
	};

	// ---------- panel lifecycle ----------

	const invalidate = () => {
		rowsCache = undefined;
		tuiRef?.requestRender();
	};

	const panelHeight = () => Math.max(8, (tuiRef?.terminal?.rows ?? 30) - 8);

	const revealPath = (abs: string) => {
		let dir = path.dirname(abs);
		while (dir.startsWith(root) && dir !== root) {
			expanded.add(dir);
			dir = path.dirname(dir);
		}
	};

	/** Relative paths currently referenced as @path in the chat input. */
	const referenced = (): Set<string> => {
		const text = lastCtx?.ui.getEditorText?.() ?? "";
		return new Set([...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1]!));
	};

	const insertIntoEditor = (abs: string) => {
		if (!lastCtx) return;
		const rel = path.relative(root, abs) || ".";
		if (referenced().has(rel)) {
			lastCtx.ui.notify(`@${rel} is already in your message`, "info");
			return;
		}
		const text = lastCtx.ui.getEditorText?.() ?? "";
		const sep = text && !/\s$/.test(text) ? " " : "";
		lastCtx.ui.pasteToEditor(`${sep}@${rel} `);
	};

	const focusPanel = () => {
		if (!handle) return;
		if (handle.isHidden()) handle.setHidden(false);
		const cur = tuiRef?.getFocusedComponent?.();
		if (cur && cur !== panelComp) returnFocus = cur;
		handle.focus();
		if (!handle.isFocused()) lastCtx?.ui.notify(`Explorer needs a terminal at least ${MIN_TERM_WIDTH} columns wide`, "warning");
		tuiRef?.requestRender();
	};

	const unfocusPanel = () => {
		if (!handle) return;
		if (returnFocus) handle.unfocus({ target: returnFocus });
		else handle.unfocus();
		tuiRef?.requestRender();
	};

	/** Open a path with the OS default handler (runs on the host where pi runs). */
	const openExternally = (abs: string) => {
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
		execFile(cmd, [abs], { timeout: 10000 }, (err) => {
			if (err) lastCtx?.ui.notify(`Could not open ${path.relative(root, abs)}: ${String(err.message).split("\n")[0]}`, "error");
		});
	};

	// ---------- mouse ----------

	const handleMouse = (ev: any) => {
		// Row 0 is the top border, rows 1..h are tree rows, last row is the bottom border.
		const h = panelHeight();
		if (ev.type === "wheel") {
			const max = Math.max(0, rows().length - h);
			scroll = Math.max(0, Math.min(max, scroll + (ev.wheelDelta ?? 0)));
			keepSelectionVisible = false;
			tuiRef?.requestRender();
			return { handled: true };
		}
		if (ev.button !== "left") return { handled: true };
		// Must handle "press" so the TUI follows up with a "click" (and skips text selection).
		if (ev.type !== "click") return { handled: true, render: false };
		const idx = ev.y >= 1 && ev.y <= h ? scroll + ev.y - 1 : -1;
		const row = rows()[idx];
		if (!row) return { handled: true };
		selected = idx;
		keepSelectionVisible = false;
		if (row.isDir) {
			if (expanded.has(row.abs)) expanded.delete(row.abs);
			else expanded.add(row.abs);
		} else {
			openExternally(row.abs);
		}
		invalidate();
		return { handled: true };
	};

	/**
	 * Close the panel on a left click outside it. Pi's fullscreen renderer consumes mouse
	 * input before extension input listeners run, so we wrap its overlay hit-test instead:
	 * a press that hits no overlay means the click landed outside the panel.
	 */
	const patchOutsideClick = (tui: any) => {
		const original = tui?.dispatchMouseToOverlay;
		if (typeof original !== "function") return; // other renderer / API changed: feature off
		const patched = function (this: any, event: any) {
			const result = original.call(this, event);
			if (!result?.hit && event?.type === "press" && event?.button === "left" && handle && !handle.isHidden()) {
				queueMicrotask(() => close()); // after pi finishes handling the click
			}
			return result;
		};
		tui.dispatchMouseToOverlay = patched;
		unpatchOutsideClick = () => {
			if (tui.dispatchMouseToOverlay === patched) delete tui.dispatchMouseToOverlay;
			unpatchOutsideClick = undefined;
		};
	};

	const open = (ctx: ExtensionContext, focus: boolean) => {
		lastCtx = ctx;
		if (handle) {
			handle.setHidden(false);
			if (focus) focusPanel();
			return;
		}
		if (!ctx.hasUI) return;
		root = ctx.cwd ?? process.cwd();
		pi.events.emit("side-panel:open", "file-explorer"); // close the git changes panel if open

		void ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				tuiRef = tui;
				themeRef = theme;
				closePanel = () => done();
				patchOutsideClick(tui);
				refreshGit();
				panelComp = {
					render: (width: number) => render(width),
					handleInput: (data: string) => handleInput(data),
					handleMouse: (ev: any) => handleMouse(ev),
					invalidate: () => {
						rowsCache = undefined;
					},
					dispose: () => {
						unpatchOutsideClick?.();
						handle = undefined;
						closePanel = undefined;
						tuiRef = undefined;
						panelComp = undefined;
					},
				};
				return panelComp;
			},
			{
				overlay: true,
				overlayOptions: () => ({
					anchor: "top-right",
					width: PANEL_WIDTH,
					maxHeight: panelHeight() + 2,
					margin: { top: 0, right: 0 },
					nonCapturing: true,
					visible: (w: number) => w >= MIN_TERM_WIDTH,
				}),
				onHandle: (h) => {
					handle = h;
					if (focus) focusPanel();
				},
			},
		);
	};

	const close = () => {
		if (handle?.isFocused()) unfocusPanel(); // hand focus back before removing
		closePanel?.();
	};

	const toggle = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (handle) close();
		else open(ctx, true);
	};

	// ---------- input ----------

	const handleInput = (data: string) => {
		const list = rows();
		const cur = list[selected];
		const move = (d: number) => {
			selected = Math.max(0, Math.min(list.length - 1, selected + d));
		};

		if (matchesKey(data, "escape")) {
			unfocusPanel();
			return;
		} else if (data === "q" || matchesKey(data, "ctrl+f")) {
			close();
			return;
		} else if (matchesKey(data, "up") || data === "k") move(-1);
		else if (matchesKey(data, "down") || data === "j") move(1);
		else if (matchesKey(data, "pageUp")) move(-panelHeight());
		else if (matchesKey(data, "pageDown")) move(panelHeight());
		else if (matchesKey(data, "home") || data === "g") selected = 0;
		else if (matchesKey(data, "end") || data === "G") selected = list.length - 1;
		else if (matchesKey(data, "right") || data === "l") {
			if (cur?.isDir) {
				if (!expanded.has(cur.abs)) expanded.add(cur.abs);
				else move(1);
			}
		} else if (matchesKey(data, "left") || data === "h") {
			if (cur?.isDir && expanded.has(cur.abs)) expanded.delete(cur.abs);
			else if (cur) {
				const parent = path.dirname(cur.abs);
				const idx = list.findIndex((r) => r.abs === parent);
				if (idx >= 0) selected = idx;
			}
		} else if (matchesKey(data, "return")) {
			if (cur?.isDir) {
				if (expanded.has(cur.abs)) expanded.delete(cur.abs);
				else expanded.add(cur.abs);
			} else if (cur) {
				insertIntoEditor(cur.abs); // keep focus so several files can be added
			}
		} else if (data === "o") {
			if (cur) openExternally(cur.abs);
		} else if (data === "r") {
			refreshGit();
		} else if (data === ".") {
			showHidden = !showHidden;
			saveShowHidden(showHidden);
			pi.events.emit(HIDDEN_EVENT, showHidden);
		} else if (data === "c") {
			agentMarks.clear();
		} else return;

		keepSelectionVisible = true;
		invalidate();
	};

	// ---------- render ----------

	const render = (width: number): string[] => {
		const th = themeRef;
		const w = Math.max(10, width);
		const inner = w - 2;
		const h = panelHeight();
		const list = rows();
		const refs = referenced();
		const focused = !!handle?.isFocused();
		if (selected >= list.length) selected = Math.max(0, list.length - 1);
		if (keepSelectionVisible) {
			if (selected < scroll) scroll = selected;
			if (selected >= scroll + h) scroll = selected - h + 1;
		}
		if (scroll > Math.max(0, list.length - h)) scroll = Math.max(0, list.length - h);

		const border = (s: string) => th.fg(focused ? "borderAccent" : "border", s);
		const fit = (s: string) => truncateToWidth(s, inner, "…", true);

		const title = ` EXPLORER: ${path.basename(root) || root} `;
		const topFill = Math.max(0, inner - visibleWidth(title));
		const out: string[] = [border("╭") + th.fg("accent", truncateToWidth(title, inner)) + border("─".repeat(topFill) + "╮")];

		for (let i = 0; i < h; i++) {
			const r = list[scroll + i];
			let line = "";
			if (r) {
				const indent = "  ".repeat(r.depth);
				const isRef = !r.isDir && refs.has(path.relative(root, r.abs));
				const icon = r.isDir ? (expanded.has(r.abs) ? "▾ " : "▸ ") : isRef ? "@ " : "  ";
				const mark = r.isDir ? (dirHasChanges(r.abs) ? "•" : "") : (markOf(r.abs) ?? "");
				const color =
					mark === "A" || mark === "?"
						? "success"
						: mark === "M" || mark === "•"
							? "warning"
							: mark === "D"
								? "error"
								: r.isDir
									? "accent"
									: "text";
				const nameW = Math.max(1, inner - visibleWidth(indent + icon) - (mark ? 2 : 0) - 1);
				const label = truncateToWidth(r.name + (r.isDir ? "/" : ""), nameW, "…");
				const pad = " ".repeat(Math.max(0, nameW - visibleWidth(label)));
				const isSel = scroll + i === selected;
				const styledName = isSel && !focused ? th.underline(label) : label;
				line = fit(` ${indent}${th.fg(isRef ? "accent" : "dim", icon)}${th.fg(color, styledName)}${pad}${mark ? " " + th.fg(color, mark) : ""}`);
				if (isSel && focused) line = th.bg("selectedBg", line);
			} else if (i === 0) {
				line = fit(th.fg("dim", " (empty)"));
			} else line = fit("");
			out.push(border("│") + line + border("│"));
		}

		const hint = focused ? " ↑↓ ←→ ⏎ o r . esc ^F " : " ^F close · /explorer ";
		const pos = list.length ? ` ${selected + 1}/${list.length} ` : "";
		const fill = Math.max(0, inner - visibleWidth(hint) - visibleWidth(pos));
		out.push(border("╰") + th.fg("dim", hint) + border("─".repeat(fill)) + th.fg("dim", pos) + border("╯"));
		return out.map((l) => truncateToWidth(l, w));
	};

	// ---------- registration ----------

	for (const key of ["ctrl+f"]) {
		pi.registerShortcut(key, {
			description: "Toggle file explorer",
			handler: async (ctx) => toggle(ctx),
		});
	}

	pi.registerCommand("explorer", {
		description: "Open/focus file explorer (args: close | refresh)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("explorer requires interactive mode", "error");
			const a = (args ?? "").trim();
			if (a === "close") return close();
			if (a === "refresh") {
				refreshGit();
				return invalidate();
			}
			open(ctx, true); // opens, or re-focuses if already open
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		lastCtx = ctx; // panel starts closed; ctrl+f or /explorer opens it
		root = ctx.cwd ?? process.cwd(); // so change tracking resolves paths before first open
	});

	pi.on("session_shutdown", async () => close());

	// Only one right-side panel at a time (shared with git-changes.ts)
	pi.events.on("side-panel:open", (id: unknown) => {
		if (id !== "file-explorer" && handle) close();
	});

	pi.on("tool_execution_start", async (event: any) => {
		const name = String(event.toolName).toLowerCase();
		if (name !== "write" && name !== "edit") return;
		const p = event.args?.path ?? event.args?.file_path;
		if (!p) return;
		const abs = toHostPath(p);
		pending.set(event.toolCallId, { abs, existed: fs.existsSync(abs) });
	});

	pi.on("tool_execution_end", async (event: any) => {
		const info = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (info && !event.isError) {
			const prev = agentMarks.get(info.abs);
			agentMarks.set(info.abs, prev === "A" || !info.existed ? "A" : "M");
			revealPath(info.abs);
		}
		// any tool (incl. bash) may have changed the tree; only refresh while open
		if (handle) {
			refreshGit();
			invalidate();
		}
	});
}
