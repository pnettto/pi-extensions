import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, replaceControlCharacters, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// shared with file-explorer.ts
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
 * VS Code–style "Source Control" panel docked on the right side of the TUI.
 * Same feel as file-explorer.ts (only one of the two panels is open at a time).
 *
 *   ctrl+g              toggle the panel (open + focus / close)
 *   (pi's external-editor key moved to ctrl+shift+g in ~/.pi/agent/keybindings.json)
 *   /changes            open, or re-focus an open panel
 *   /changes close      close the panel
 *
 * Panel (when focused):
 *   ↑/↓ j/k  move          enter / →   open diff (file) · expand (group)
 *   ←        collapse group / jump to group header
 *   s        stage file (or whole group on a header)
 *   u        unstage file (or whole "Staged Changes" group on its header)
 *   o        open file in the macOS default app
 *   a / @    add @path to the chat message (focus stays)
 *   .        toggle hidden files (gitignored; shared with the file explorer)
 *   r        refresh       esc  back to chat (panel stays)   q / ctrl+g  close
 *
 * Diff viewer:
 *   ↑/↓ j/k scroll · PgUp/PgDn/space · g/G top/bottom · [ ] prev/next hunk
 *   ←/→ h/l prev/next changed file · esc/q back to the list · ctrl+g close all
 *
 * Mouse (pi fullscreen mode): click file = diff, click group = collapse/expand,
 * wheel = scroll, click outside = close.
 */

const PANEL_ID = "git-changes";
const PANEL_EVENT = "side-panel:open"; // shared with file-explorer.ts
const PANEL_WIDTH = 40;
const MIN_TERM_WIDTH = 90;
const REFRESH_MS = 4000;
const MAX_DIFF_LINES = 20000;

type Group = "merge" | "staged" | "changes" | "ignored";
interface Entry {
	group: Group;
	code: string; // M A D R C T U(ntracked) !(conflict)
	path: string; // relative to repo root
	orig?: string; // rename/copy source
}
type Row = { kind: "header"; group: Group; count: number } | { kind: "file"; entry: Entry };
interface DiffLine {
	kind: "add" | "del" | "ctx" | "hunk" | "meta";
	old?: number;
	nw?: number;
	text: string;
}

const GROUP_LABEL: Record<Group, string> = { merge: "MERGE CHANGES", staged: "STAGED CHANGES", changes: "CHANGES", ignored: "IGNORED" };
const GROUP_ORDER: Group[] = ["merge", "staged", "changes", "ignored"];

const codeColor = (code: string) =>
	code === "I" ? "dim" : code === "A" || code === "U" ? "success" : code === "D" || code === "!" ? "error" : code === "R" || code === "C" ? "accent" : "warning";

function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout, stderr) => {
			if (err && !okCodes.includes(typeof err.code === "number" ? err.code : -1)) {
				reject(new Error(String(stderr || err.message).trim().split("\n")[0]));
			} else resolve(String(stdout));
		});
	});
}

function parseStatus(out: string): { branch: string; entries: Entry[] } {
	const parts = out.split("\0");
	const entries: Entry[] = [];
	let branch = "";
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (!p) continue;
		if (p.startsWith("## ")) {
			branch = p.slice(3);
			continue;
		}
		const x = p[0]!;
		const y = p[1]!;
		const file = p.slice(3);
		let orig: string | undefined;
		if ("RC".includes(x) || "RC".includes(y)) orig = parts[++i];
		if (x === "!") continue;
		if (x === "?") {
			entries.push({ group: "changes", code: "U", path: file });
			continue;
		}
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
			entries.push({ group: "merge", code: "!", path: file });
			continue;
		}
		if (x !== " ") entries.push({ group: "staged", code: x, path: file, orig: "RC".includes(x) ? orig : undefined });
		if (y !== " ") entries.push({ group: "changes", code: y, path: file, orig: "RC".includes(y) ? orig : undefined });
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return { branch, entries };
}

function formatBranch(raw: string): string {
	if (!raw) return "";
	let s = raw.replace(/^No commits yet on /, "");
	const ahead = /ahead (\d+)/.exec(s)?.[1];
	const behind = /behind (\d+)/.exec(s)?.[1];
	s = s.replace(/ \[.*\]$/, "").split("...")[0]!;
	return `${s}${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`;
}

function parseDiff(out: string): DiffLine[] {
	const res: DiffLine[] = [];
	let o = 0;
	let n = 0;
	let inHunks = false;
	let combined = false;
	for (const raw0 of out.split("\n")) {
		if (res.length >= MAX_DIFF_LINES) {
			res.push({ kind: "meta", text: "… diff truncated" });
			break;
		}
		const raw = replaceControlCharacters(raw0.replace(/\t/g, "    "));
		if (/^(diff --git|diff --cc|diff --combined|index |--- |\+\+\+ )/.test(raw)) continue;
		const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (m) {
			o = Number(m[1]);
			n = Number(m[2]);
			inHunks = true;
			combined = false;
			res.push({ kind: "hunk", text: raw });
			continue;
		}
		if (raw.startsWith("@@@")) {
			inHunks = true;
			combined = true;
			res.push({ kind: "hunk", text: raw });
			continue;
		}
		if (!inHunks) {
			if (raw) res.push({ kind: "meta", text: raw });
			continue;
		}
		if (combined) {
			const pre = raw.slice(0, 2);
			res.push({ kind: pre.includes("+") ? "add" : pre.includes("-") ? "del" : "ctx", text: raw });
			continue;
		}
		const c = raw[0];
		if (c === "+") res.push({ kind: "add", nw: n++, text: raw.slice(1) });
		else if (c === "-") res.push({ kind: "del", old: o++, text: raw.slice(1) });
		else if (c === " ") res.push({ kind: "ctx", old: o++, nw: n++, text: raw.slice(1) });
		else if (c === "\\") res.push({ kind: "meta", text: raw });
	}
	if (res.length === 0) res.push({ kind: "meta", text: "No textual changes" });
	return res;
}

export default function gitChanges(pi: ExtensionAPI) {
	let cwd = process.cwd();
	let repoRoot: string | undefined;
	let repoError: string | undefined;
	let branch = "";
	let entries: Entry[] = [];
	let loaded = false;
	const collapsed = new Set<Group>();
	let selected = 0;
	let scroll = 0;
	let keepSelectionVisible = true;

	let handle: any | undefined;
	let closePanel: (() => void) | undefined;
	let tuiRef: any | undefined;
	let themeRef: any | undefined;
	let panelComp: any | undefined;
	let returnFocus: any | undefined;
	let lastCtx: ExtensionContext | undefined;
	let unpatchOutsideClick: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let closeViewer: (() => void) | undefined;

	// ---------- data ----------

	let showHidden = loadShowHidden();
	pi.events.on(HIDDEN_EVENT, (v: unknown) => {
		if (typeof v !== "boolean" || v === showHidden) return;
		showHidden = v;
		if (handle) void refresh();
	});

	const keyOf = (e: Entry) => `${e.group}:${e.path}`;

	const rows = (): Row[] => {
		const out: Row[] = [];
		for (const g of GROUP_ORDER) {
			const list = entries.filter((e) => e.group === g);
			if (!list.length) continue;
			out.push({ kind: "header", group: g, count: list.length });
			if (!collapsed.has(g)) for (const e of list) out.push({ kind: "file", entry: e });
		}
		return out;
	};

	const fileEntries = () => GROUP_ORDER.flatMap((g) => entries.filter((e) => e.group === g));

	const refresh = async () => {
		if (refreshing) return;
		refreshing = true;
		const list0 = rows();
		const cur = list0[selected];
		const curKey = cur ? (cur.kind === "file" ? keyOf(cur.entry) : `h:${cur.group}`) : undefined;
		const curPath = cur?.kind === "file" ? cur.entry.path : undefined;
		try {
			repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
			const st = parseStatus(await git(repoRoot, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]));
			branch = formatBranch(st.branch);
			entries = st.entries;
			if (showHidden) {
				// ignored files, with fully-ignored dirs collapsed (e.g. node_modules/)
				const ign = await git(repoRoot, ["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=normal"]);
				for (const p of ign.split("\0")) {
					if (p.startsWith("!! ")) entries.push({ group: "ignored", code: "I", path: p.slice(3) });
				}
			}
			repoError = undefined;
		} catch (e: any) {
			repoRoot = undefined;
			entries = [];
			branch = "";
			repoError = /not a git repository/i.test(e?.message ?? "") ? "Not a git repository" : (e?.message ?? String(e));
		} finally {
			refreshing = false;
			loaded = true;
		}
		// keep the selection on the same item when possible
		const list = rows();
		if (curKey) {
			let idx = list.findIndex((r) => (r.kind === "file" ? keyOf(r.entry) : `h:${r.group}`) === curKey);
			// file moved group (staged/unstaged): follow it
			if (idx < 0 && curPath) idx = list.findIndex((r) => r.kind === "file" && r.entry.path === curPath);
			if (idx >= 0) selected = idx;
		}
		if (selected >= list.length) selected = Math.max(0, list.length - 1);
		tuiRef?.requestRender();
	};

	const absOf = (e: Entry) => path.join(repoRoot ?? cwd, e.path);

	// ---------- actions ----------

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") => lastCtx?.ui.notify(msg, type);

	const pathsFor = (list: Entry[]) => [...new Set(list.flatMap((e) => (e.orig ? [e.orig, e.path] : [e.path])))];

	const stage = async (list: Entry[]) => {
		list = list.filter((e) => e.group !== "ignored");
		if (!repoRoot || !list.length) return;
		try {
			await git(repoRoot, ["add", "-A", "--", ...pathsFor(list)]);
		} catch (e: any) {
			notify(`git add failed: ${e.message}`, "error");
		}
		await refresh();
	};

	const unstage = async (list: Entry[]) => {
		if (!repoRoot) return;
		list = list.filter((e) => e.group === "staged");
		if (!list.length) return notify("Nothing staged here — use s to stage", "info");
		const paths = pathsFor(list);
		try {
			await git(repoRoot, ["restore", "--staged", "--", ...paths]);
		} catch {
			try {
				await git(repoRoot, ["rm", "--cached", "-r", "-q", "--", ...paths]); // repo without commits
			} catch (e: any) {
				notify(`unstage failed: ${e.message}`, "error");
			}
		}
		await refresh();
	};

	const openExternally = (e: Entry) => {
		if (e.code === "D" && e.group !== "merge") return notify(`${e.path} is deleted`, "warning");
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
		execFile(cmd, [absOf(e)], { timeout: 10000 }, (err) => {
			if (err) notify(`Could not open ${e.path}: ${String(err.message).split("\n")[0]}`, "error");
		});
	};

	const referenced = (): Set<string> => {
		const text = lastCtx?.ui.getEditorText?.() ?? "";
		return new Set([...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1]!));
	};
	const refPath = (e: Entry) => path.relative(cwd, absOf(e)) || ".";

	const addReference = (e: Entry) => {
		if (!lastCtx) return;
		const rel = refPath(e);
		if (referenced().has(rel)) return notify(`@${rel} is already in your message`);
		const text = lastCtx.ui.getEditorText?.() ?? "";
		lastCtx.ui.pasteToEditor(`${text && !/\s$/.test(text) ? " " : ""}@${rel} `);
	};

	// ---------- diff viewer ----------

	const diffArgs = (e: Entry): { args: string[]; ok: number[] } => {
		if (e.group === "staged")
			return { args: ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", "--", ...(e.orig ? [e.orig, e.path] : [e.path])], ok: [0] };
		if (e.code === "U") return { args: ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", e.path], ok: [0, 1] };
		return { args: ["diff", "--no-color", "--no-ext-diff", "--", e.path], ok: [0] };
	};

	const showDiff = (entry: Entry) => {
		if (!lastCtx || !repoRoot) return;
		if (closeViewer) closeViewer();
		const root = repoRoot;
		let current = entry;
		let lines: DiffLine[] = [{ kind: "meta", text: "Loading…" }];
		let hunks: number[] = [];
		let top = 0;
		let viewH = 10;
		let vTui: any;

		const load = async (e: Entry) => {
			current = e;
			top = 0;
			lines = [{ kind: "meta", text: "Loading…" }];
			hunks = [];
			vTui?.requestRender();
			try {
				const { args, ok } = diffArgs(e);
				lines = parseDiff(await git(root, args, ok));
			} catch (err: any) {
				lines = [{ kind: "meta", text: `Error: ${err.message}` }];
			}
			hunks = lines.flatMap((l, i) => (l.kind === "hunk" ? [i] : []));
			// sync the panel selection with the file being viewed
			const idx = rows().findIndex((r) => r.kind === "file" && keyOf(r.entry) === keyOf(e));
			if (idx >= 0) {
				selected = idx;
				keepSelectionVisible = true;
			}
			vTui?.requestRender();
			tuiRef?.requestRender();
		};

		const scrollBy = (d: number) => {
			top = Math.max(0, Math.min(Math.max(0, lines.length - viewH), top + d));
		};

		const stepFile = (d: number) => {
			const files = fileEntries();
			const i = files.findIndex((f) => keyOf(f) === keyOf(current));
			const next = files[i + d];
			if (next) void load(next);
		};

		void lastCtx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				vTui = tui;
				closeViewer = () => done();
				void load(entry);
				return {
					render(width: number): string[] {
						const th = theme;
						const w = Math.max(20, width);
						const inner = w - 2;
						const H = Math.max(6, Math.floor((tui.terminal?.rows ?? 30) * 0.9));
						viewH = H - 2;
						top = Math.max(0, Math.min(top, Math.max(0, lines.length - viewH)));
						const label =
							current.group === "staged" ? "Staged" : current.group === "merge" ? "Merge conflict" : current.code === "U" ? "Untracked" : "Working tree";
						const title = ` ${current.orig ? `${current.orig} → ` : ""}${current.path} · ${label} `;
						const border = (s: string) => th.fg("borderAccent", s);
						const out: string[] = [
							border("╭") +
								th.fg("accent", truncateToWidth(title, inner)) +
								border("─".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(title, inner)))) + "╮"),
						];
						const hasGutter = lines.some((l) => l.old !== undefined || l.nw !== undefined);
						for (let i = 0; i < viewH; i++) {
							const l = lines[top + i];
							let s = "";
							if (l) {
								const num = (v?: number) => (v === undefined ? "    " : String(v).padStart(4));
								const gutter = hasGutter && l.kind !== "hunk" && l.kind !== "meta" ? th.fg("dim", `${num(l.old)} ${num(l.nw)} │`) : "";
								if (l.kind === "add") s = `${gutter}${th.fg("toolDiffAdded", (hasGutter ? "+" : "") + l.text)}`;
								else if (l.kind === "del") s = `${gutter}${th.fg("toolDiffRemoved", (hasGutter ? "-" : "") + l.text)}`;
								else if (l.kind === "ctx") s = `${gutter}${th.fg("toolDiffContext", (hasGutter ? " " : "") + l.text)}`;
								else if (l.kind === "hunk") s = th.fg("accent", l.text);
								else s = th.fg("dim", l.text);
							}
							out.push(border("│") + truncateToWidth(s, inner, "…", true) + border("│"));
						}
						const files = fileEntries();
						const fi = files.findIndex((f) => keyOf(f) === keyOf(current));
						const hint = " ↑↓ scroll · [ ] hunk · ←→ file · esc ";
						const pos = ` file ${fi + 1}/${files.length} · ${Math.min(lines.length, top + 1)}-${Math.min(lines.length, top + viewH)}/${lines.length} `;
						const fill = Math.max(0, inner - visibleWidth(hint) - visibleWidth(pos));
						out.push(border("╰") + th.fg("dim", hint) + border("─".repeat(fill)) + th.fg("dim", pos) + border("╯"));
						return out.map((x) => truncateToWidth(x, w));
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || data === "q") return done();
						if (matchesKey(data, "ctrl+g")) {
							done();
							return close();
						}
						if (matchesKey(data, "up") || data === "k") scrollBy(-1);
						else if (matchesKey(data, "down") || data === "j") scrollBy(1);
						else if (matchesKey(data, "pageUp") || data === "b") scrollBy(-viewH);
						else if (matchesKey(data, "pageDown") || data === " ") scrollBy(viewH);
						else if (matchesKey(data, "home") || data === "g") top = 0;
						else if (matchesKey(data, "end") || data === "G") top = Math.max(0, lines.length - viewH);
						else if (data === "]" || data === "n") {
							const h = hunks.find((i) => i > top);
							if (h !== undefined) top = h;
						} else if (data === "[" || data === "N") {
							const h = [...hunks].reverse().find((i) => i < top);
							top = h ?? 0;
						} else if (matchesKey(data, "right") || data === "l") return stepFile(1);
						else if (matchesKey(data, "left") || data === "h") return stepFile(-1);
						else return;
						tui.requestRender();
					},
					handleMouse(ev: any) {
						if (ev.type === "wheel") {
							scrollBy(ev.wheelDelta ?? 0);
							tui.requestRender();
						}
						return { handled: true };
					},
					invalidate() {},
					dispose() {
						closeViewer = undefined;
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" } },
		);
	};

	// ---------- panel lifecycle ----------

	const panelHeight = () => Math.max(8, (tuiRef?.terminal?.rows ?? 30) - 8);

	const focusPanel = () => {
		if (!handle) return;
		if (handle.isHidden()) handle.setHidden(false);
		const cur = tuiRef?.getFocusedComponent?.();
		if (cur && cur !== panelComp) returnFocus = cur;
		handle.focus();
		if (!handle.isFocused()) notify(`Changes panel needs a terminal at least ${MIN_TERM_WIDTH} columns wide`, "warning");
		tuiRef?.requestRender();
	};

	const unfocusPanel = () => {
		if (!handle) return;
		if (returnFocus) handle.unfocus({ target: returnFocus });
		else handle.unfocus();
		tuiRef?.requestRender();
	};

	/** Close on a left click outside any overlay (same technique as file-explorer.ts). */
	const patchOutsideClick = (tui: any) => {
		const original = tui?.dispatchMouseToOverlay;
		if (typeof original !== "function") return;
		const patched = function (this: any, event: any) {
			const result = original.call(this, event);
			if (!result?.hit && event?.type === "press" && event?.button === "left" && handle && !handle.isHidden()) {
				queueMicrotask(() => close());
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
		cwd = ctx.cwd ?? process.cwd();
		pi.events.emit(PANEL_EVENT, PANEL_ID); // close the file explorer if it's open

		void ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				tuiRef = tui;
				themeRef = theme;
				closePanel = () => done();
				patchOutsideClick(tui);
				loaded = false;
				void refresh();
				timer = setInterval(() => void refresh(), REFRESH_MS);
				panelComp = {
					render: (width: number) => render(width),
					handleInput: (data: string) => handleInput(data),
					handleMouse: (ev: any) => handleMouse(ev),
					invalidate: () => {},
					dispose: () => {
						if (timer) clearInterval(timer);
						timer = undefined;
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
		closeViewer?.();
		if (handle?.isFocused()) unfocusPanel();
		closePanel?.();
	};

	const toggle = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (handle) close();
		else open(ctx, true);
	};

	// ---------- input ----------

	const activate = (r: Row | undefined) => {
		if (!r) return;
		if (r.kind === "header") {
			if (collapsed.has(r.group)) collapsed.delete(r.group);
			else collapsed.add(r.group);
		} else if (r.entry.group === "ignored") notify("Ignored file — o to open, a to reference", "info");
		else showDiff(r.entry);
	};

	const groupEntries = (g: Group) => entries.filter((e) => e.group === g);

	const handleInput = (data: string) => {
		const list = rows();
		const cur = list[selected];
		const move = (d: number) => {
			selected = Math.max(0, Math.min(list.length - 1, selected + d));
		};

		if (matchesKey(data, "escape")) return unfocusPanel();
		if (data === "q" || matchesKey(data, "ctrl+g")) return close();

		if (matchesKey(data, "up") || data === "k") move(-1);
		else if (matchesKey(data, "down") || data === "j") move(1);
		else if (matchesKey(data, "pageUp")) move(-panelHeight());
		else if (matchesKey(data, "pageDown")) move(panelHeight());
		else if (matchesKey(data, "home") || data === "g") selected = 0;
		else if (matchesKey(data, "end") || data === "G") selected = list.length - 1;
		else if (matchesKey(data, "return")) activate(cur);
		else if (matchesKey(data, "right") || data === "l") {
			if (cur?.kind === "header") collapsed.delete(cur.group);
			else activate(cur);
		} else if (matchesKey(data, "left") || data === "h") {
			if (cur?.kind === "header") collapsed.add(cur.group);
			else if (cur) {
				const idx = list.findIndex((r) => r.kind === "header" && r.group === cur.entry.group);
				if (idx >= 0) selected = idx;
			}
		} else if (data === "s") {
			if (cur) void stage(cur.kind === "header" ? groupEntries(cur.group).filter((e) => e.group !== "staged") : [cur.entry]);
		} else if (data === "u") {
			if (cur) void unstage(cur.kind === "header" ? groupEntries(cur.group) : [cur.entry]);
		} else if (data === "o") {
			if (cur?.kind === "file") openExternally(cur.entry);
		} else if (data === "a" || data === "@") {
			if (cur?.kind === "file") addReference(cur.entry);
		} else if (data === ".") {
			showHidden = !showHidden;
			saveShowHidden(showHidden);
			pi.events.emit(HIDDEN_EVENT, showHidden);
			notify(showHidden ? "Showing ignored files" : "Hiding ignored files", "info");
			void refresh();
		} else if (data === "r") void refresh();
		else return;

		keepSelectionVisible = true;
		tuiRef?.requestRender();
	};

	const handleMouse = (ev: any) => {
		const h = panelHeight();
		if (ev.type === "wheel") {
			const max = Math.max(0, rows().length - h);
			scroll = Math.max(0, Math.min(max, scroll + (ev.wheelDelta ?? 0)));
			keepSelectionVisible = false;
			tuiRef?.requestRender();
			return { handled: true };
		}
		if (ev.button !== "left") return { handled: true };
		if (ev.type !== "click") return { handled: true, render: false };
		const idx = ev.y >= 1 && ev.y <= h ? scroll + ev.y - 1 : -1;
		const row = rows()[idx];
		if (!row) return { handled: true };
		selected = idx;
		keepSelectionVisible = false;
		activate(row);
		tuiRef?.requestRender();
		return { handled: true };
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

		const title = ` SOURCE CONTROL${branch ? `: ${branch}` : ""} `;
		const t = truncateToWidth(title, inner);
		const out: string[] = [border("╭") + th.fg("accent", t) + border("─".repeat(Math.max(0, inner - visibleWidth(t))) + "╮")];

		const body: string[] = [];
		if (!loaded) body.push(fit(th.fg("dim", " Loading…")));
		else if (repoError) {
			body.push(fit(th.fg("warning", ` ${repoError}`)));
			body.push(fit(th.fg("dim", ` ${cwd}`)));
			body.push(fit(""));
			body.push(fit(th.fg("dim", " Start pi inside a repo to use this.")));
		} else if (!list.length) body.push(fit(th.fg("dim", " No changes — working tree clean")));

		if (body.length) {
			for (let i = 0; i < h; i++) out.push(border("│") + (body[i] ?? fit("")) + border("│"));
		} else {
			for (let i = 0; i < h; i++) {
				const r = list[scroll + i];
				let line = fit("");
				const isSel = scroll + i === selected;
				if (r?.kind === "header") {
					const icon = collapsed.has(r.group) ? "▸ " : "▾ ";
					const count = String(r.count);
					const label = truncateToWidth(GROUP_LABEL[r.group], Math.max(1, inner - 4 - count.length - 1));
					const pad = " ".repeat(Math.max(0, inner - 1 - visibleWidth(icon + label) - count.length - 1));
					const lbl = isSel && !focused ? th.underline(label) : label;
					line = fit(` ${th.fg("dim", icon)}${th.bold(th.fg("muted", lbl))}${pad}${th.fg("dim", count)} `);
				} else if (r?.kind === "file") {
					const e = r.entry;
					const color = codeColor(e.code);
					const isRef = refs.has(refPath(e));
					const lead = isRef ? th.fg("accent", "@ ") : "  ";
					const name = path.basename(e.path);
					const dirRaw = path.dirname(e.path);
					const dir = dirRaw === "." ? "" : dirRaw;
					const avail = Math.max(1, inner - 6); // " " + lead(2) + name/dir + " X "
					const nameT = truncateToWidth(name, avail, "…");
					const dirT = dir ? truncateToWidth(` ${dir}`, Math.max(0, avail - visibleWidth(nameT)), "…") : "";
					const pad = " ".repeat(Math.max(0, avail - visibleWidth(nameT) - visibleWidth(dirT)));
					const styledName = isSel && !focused ? th.underline(nameT) : nameT;
					line = fit(` ${lead}${th.fg(color, styledName)}${th.fg("dim", dirT)}${pad} ${th.fg(color, e.code)} `);
				}
				if (isSel && focused && r) line = th.bg("selectedBg", line);
				out.push(border("│") + line + border("│"));
			}
		}

		const hint = focused ? " ⏎ diff · s/u stage · esc ^G " : " ^G close · /changes ";
		const staged = entries.filter((e) => e.group === "staged").length;
		const pos = loaded && !repoError ? ` ${entries.length - staged}·${staged}s ` : "";
		const fill = Math.max(0, inner - visibleWidth(hint) - visibleWidth(pos));
		out.push(border("╰") + th.fg("dim", hint) + border("─".repeat(fill)) + th.fg("dim", pos) + border("╯"));
		return out.map((l) => truncateToWidth(l, w));
	};

	// ---------- registration ----------

	pi.registerShortcut("ctrl+g", {
		description: "Toggle git changes panel",
		handler: async (ctx) => toggle(ctx),
	});

	pi.registerCommand("changes", {
		description: "Open/focus git changes panel (args: close | refresh)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("changes panel requires interactive mode", "error");
			const a = (args ?? "").trim();
			if (a === "close") return close();
			if (a === "refresh") return void refresh();
			open(ctx, true);
		},
	});

	pi.events.on(PANEL_EVENT, (id: unknown) => {
		if (id !== PANEL_ID && handle) close();
	});

	pi.on("session_start", async (_e, ctx) => {
		lastCtx = ctx; // panel starts closed
		cwd = ctx.cwd ?? process.cwd();
	});

	pi.on("session_shutdown", async () => close());

	pi.on("tool_execution_end", async () => {
		if (handle) void refresh();
	});
}
