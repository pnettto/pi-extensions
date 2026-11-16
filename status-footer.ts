/**
 * Status Footer — a richer, prettier status bar.
 *
 * Line 1:  📁 cwd  ⎇ branch ✚dirty ↑ahead ↓behind · session name        ⠹ editing main.ts · ⏱ 12m · 14:32
 * Line 2:  ◔ ▰▰▰▱▱▱▱▱▱▱ 31% 62k/200k   ↑12k ↓3.1k ⚡92% $0.42            ● claude-opus-4-8 · high
 * Line 3:  extension statuses (only when something set one)
 *
 * /footer toggles back to the built-in footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS: Record<string, string> = {
	read: "reading",
	edit: "editing",
	write: "writing",
	bash: "running",
	grep: "searching",
	find: "finding",
	ls: "listing",
	questionnaire: "asking you",
};

type Git = { branch?: string; dirty: number; untracked: number; ahead: number; behind: number };

const fmtTok = (n: number) =>
	n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;

const fmtDur = (ms: number) => {
	const m = Math.floor(ms / 60_000);
	if (m < 1) return `${Math.floor(ms / 1000)}s`;
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

const shortCwd = (cwd: string) => {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
};

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let options: { enabled?: boolean; showClock?: boolean; showCost?: boolean } = {};
	let ctxRef: ExtensionContext | undefined;
	let requestRender: () => void = () => {};

	// live state
	let busy = false;
	let activity: string | undefined;
	let toolCount = 0;
	let toolErrors = 0;
	let turnCount = 0;
	let lastRunMs: number | undefined;
	let runStartedAt = 0;
	const sessionStart = Date.now();
	let git: Git = { dirty: 0, untracked: 0, ahead: 0, behind: 0 };

	// ---- git -------------------------------------------------------------
	let gitInFlight = false;
	async function refreshGit() {
		if (!ctxRef || gitInFlight) return;
		gitInFlight = true;
		try {
			const r = await pi.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctxRef.cwd, timeout: 3000 });
			if (r.code !== 0) {
				git = { dirty: 0, untracked: 0, ahead: 0, behind: 0 };
				return;
			}
			const next: Git = { dirty: 0, untracked: 0, ahead: 0, behind: 0 };
			for (const line of r.stdout.split("\n")) {
				if (line.startsWith("# branch.head ")) next.branch = line.slice(14);
				else if (line.startsWith("# branch.ab ")) {
					const m = line.match(/\+(\d+) -(\d+)/);
					if (m) [next.ahead, next.behind] = [Number(m[1]), Number(m[2])];
				} else if (line.startsWith("? ")) next.untracked++;
				else if (/^[12u] /.test(line)) next.dirty++;
			}
			git = next;
			requestRender();
		} catch {
			/* ignore */
		} finally {
			gitInFlight = false;
		}
	}

	// ---- usage totals (cached by entry count) -----------------------------
	let usageCache: { key: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; hit?: number } | undefined;
	function usage(ctx: ExtensionContext) {
		const sm = ctx.sessionManager;
		const entries = sm.getEntries();
		const key = `${sm.getSessionId()}:${sm.getLeafId()}:${entries.length}`;
		if (usageCache?.key === key) return usageCache;
		const u = { key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hit: undefined as number | undefined };
		const add = (x: any) => {
			if (!x) return;
			u.input += x.input ?? 0;
			u.output += x.output ?? 0;
			u.cacheRead += x.cacheRead ?? 0;
			u.cacheWrite += x.cacheWrite ?? 0;
			u.cost += x.cost?.total ?? 0;
		};
		for (const e of entries as any[]) {
			if (e.type === "usage") add(e.usage);
			else if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message.usage;
				add(m);
				const prompt = (m?.input ?? 0) + (m?.cacheRead ?? 0) + (m?.cacheWrite ?? 0);
				u.hit = prompt > 0 ? (m.cacheRead / prompt) * 100 : u.hit;
			} else if (e.type === "message" && e.message.role === "toolResult") add(e.message.usage);
			else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) add(e.usage);
		}
		usageCache = u;
		return u;
	}

	// ---- layout helper -----------------------------------------------------
	function row(left: string, right: string, width: number) {
		const lw = visibleWidth(left);
		const rw = visibleWidth(right);
		if (lw + 2 + rw <= width) return left + " ".repeat(width - lw - rw) + right;
		const roomLeft = Math.max(0, width - rw - 2);
		if (roomLeft >= 20) return truncateToWidth(left, roomLeft, "…") + " ".repeat(Math.max(2, width - Math.min(lw, roomLeft) - rw)) + right;
		return truncateToWidth(left, width, "…");
	}

	// ---- footer ------------------------------------------------------------
	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !enabled) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => {
				refreshGit();
				tui.requestRender();
			});
			let frame = 0;
			const spin = setInterval(() => {
				frame++;
				if (busy) tui.requestRender();
			}, 90);
			const tick = setInterval(() => tui.requestRender(), 30_000); // keep clock/duration fresh
			const gitPoll = setInterval(refreshGit, 20_000);

			const sep = theme.fg("borderMuted", " · ");
			const c = (color: Parameters<typeof theme.fg>[0], s: string) => theme.fg(color, s);

			return {
				dispose() {
					unsubBranch();
					clearInterval(spin);
					clearInterval(tick);
					clearInterval(gitPoll);
					requestRender = () => {};
				},
				invalidate() {},
				render(width: number): string[] {
					const cx = ctxRef ?? ctx;
					const lines: string[] = [];

					// ── line 1: where + activity ──────────────────────────────
					const project = basename(cx.cwd);
					const parent = shortCwd(cx.cwd).slice(0, -project.length);
					let l1 = `${c("accent", "📁")} ${c("dim", parent)}${theme.bold(c("text", project))}`;

					const branch = git.branch ?? footerData.getGitBranch();
					if (branch) {
						let g = ` ${c("accent", "⎇")} ${c("text", branch === "(detached)" ? "detached" : branch)}`;
						if (git.dirty) g += c("warning", ` ✚${git.dirty}`);
						if (git.untracked) g += c("muted", ` ?${git.untracked}`);
						if (git.ahead) g += c("success", ` ↑${git.ahead}`);
						if (git.behind) g += c("error", ` ↓${git.behind}`);
						if (!git.dirty && !git.untracked) g += c("success", " ✓");
						l1 += g;
					}
					const name = cx.sessionManager.getSessionName();
					if (name) l1 += sep + c("muted", `“${name}”`);

					let act: string;
					if (busy) {
						const s = c("accent", SPINNER[frame % SPINNER.length]);
						const elapsed = c("dim", ` ${fmtDur(Date.now() - runStartedAt)}`);
						act = `${s} ${c("text", activity ?? "thinking")}${elapsed}`;
					} else {
						act = lastRunMs !== undefined ? c("dim", `last run ${fmtDur(lastRunMs)}`) : "";
					}
					const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
					const r1 = [
						act,
						c("dim", `⏱ ${fmtDur(Date.now() - sessionStart)}`),
						c("dim", `🔧 ${toolCount}`) + (toolErrors ? c("error", ` ✗${toolErrors}`) : ""),
						options.showClock !== false ? c("dim", clock) : "",
					]
						.filter(Boolean)
						.join(sep);
					lines.push(row(l1, r1, width));

					// ── line 2: context + cost + model ─────────────────────────
					const cu = cx.getContextUsage();
					const pct = cu?.percent ?? null;
					const win = cu?.contextWindow ?? cx.model?.contextWindow ?? 0;
					const slots = 10;
					const filled = pct === null ? 0 : Math.min(slots, Math.round((pct / 100) * slots));
					const barColor = pct === null ? "dim" : pct > 85 ? "error" : pct > 65 ? "warning" : "success";
					const pie = pct === null ? "◌" : pct < 12.5 ? "○" : pct < 37.5 ? "◔" : pct < 62.5 ? "◑" : pct < 87.5 ? "◕" : "●";
					const bar = c(barColor, "▰".repeat(filled)) + c("borderMuted", "▱".repeat(slots - filled));
					const pctStr = pct === null ? c("dim", "?") : c(barColor, `${pct.toFixed(0)}%`);
					const tokStr = cu?.tokens != null ? c("dim", ` ${fmtTok(cu.tokens)}/${fmtTok(win)}`) : c("dim", ` /${fmtTok(win)}`);
					let l2 = `${c(barColor, pie)} ${bar} ${pctStr}${tokStr}`;

					const u = usage(cx);
					const stats: string[] = [];
					if (u.input || u.output) stats.push(c("dim", `↑${fmtTok(u.input)} ↓${fmtTok(u.output)}`));
					if (u.hit !== undefined && (u.cacheRead || u.cacheWrite)) {
						stats.push(c(u.hit > 70 ? "success" : u.hit > 30 ? "muted" : "warning", `⚡${u.hit.toFixed(0)}%`));
					}
					if (options.showCost !== false && u.cost) stats.push(c(u.cost > 5 ? "warning" : "muted", `$${u.cost.toFixed(2)}`));
					if (stats.length) l2 += "   " + stats.join(" ");

					const model = cx.model?.id ?? "no-model";
					let r2 = `${c("accent", "●")} ${c("text", model)}`;
					if (cx.model?.reasoning) {
						const lvl = pi.getThinkingLevel() ?? "off";
						const tokenFor: Record<string, any> = {
							off: "thinkingOff",
							minimal: "thinkingMinimal",
							low: "thinkingLow",
							medium: "thinkingMedium",
							high: "thinkingHigh",
							xhigh: "thinkingXhigh",
							max: "thinkingMax",
						};
						r2 += sep + c(tokenFor[lvl] ?? "muted", lvl === "off" ? "no think" : `🧠 ${lvl}`);
					}
					lines.push(row(l2, r2, width));

					// ── line 3: extension statuses ─────────────────────────────
					const statuses = [...footerData.getExtensionStatuses().values()]
						.map((s) => s.replace(/[\r\n\t]+/g, " ").trim())
						.filter(Boolean);
					if (statuses.length) lines.push(truncateToWidth(statuses.join(sep), width, "…"));

					return lines;
				},
			};
		});
	}

	// ---- events --------------------------------------------------------------
	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		options = (pi.getSettings() as any).extensionPreferences?.["status-footer"] ?? {};
		enabled = options.enabled !== false;
		usageCache = undefined;
		install(ctx);
		refreshGit();
	});

	pi.on("agent_start", async (_e, ctx) => {
		ctxRef = ctx;
		busy = true;
		activity = undefined;
		runStartedAt = Date.now();
	});

	pi.on("turn_start", async () => {
		turnCount++;
		activity = "thinking";
		requestRender();
	});

	pi.on("tool_execution_start", async (e) => {
		if (e.parentToolCallId) return;
		const verb = VERBS[e.toolName] ?? e.toolName;
		const a = e.args ?? {};
		let target = "";
		if (typeof a.path === "string") target = basename(a.path);
		else if (typeof a.command === "string") target = a.command.split("\n")[0];
		else if (typeof a.pattern === "string") target = a.pattern;
		if (target.length > 32) target = target.slice(0, 31) + "…";
		activity = target ? `${verb} ${target}` : verb;
		requestRender();
	});

	pi.on("tool_execution_end", async (e) => {
		if (e.parentToolCallId) return;
		toolCount++;
		if (e.isError) toolErrors++;
		activity = "thinking";
		if (["bash", "edit", "write"].includes(e.toolName)) refreshGit();
	});

	pi.on("agent_settled", async () => {
		busy = false;
		activity = undefined;
		lastRunMs = Date.now() - runStartedAt;
		refreshGit();
		requestRender();
	});

	pi.on("model_select", async () => requestRender());
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_info_changed", async () => requestRender());

	pi.registerCommand("footer", {
		description: "Toggle the status footer / built-in footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("Status footer on", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored", "info");
			}
		},
	});
}
