/**
 * Session Time Limit — a wall-clock budget per user prompt (default: 5 minutes).
 *
 * How it works:
 * - Every user prompt starts a fresh budget window (`input` event).
 * - The agent is told the deadline up front (system prompt section `time_budget`),
 *   so it can pace itself and come back in time.
 * - While a run is active, Pi steers a heads-up reminder when ~20% of the budget is
 *   left, and a wrap-up reminder when the budget is used up.
 * - When a run settles over budget, Pi asks what to do:
 *     · N more minutes (just this run)
 *     · rest of this session (no more limits)
 *     · set a new limit for this session
 *     · stop here
 *   The first three continue the run automatically.
 * - Footer shows the remaining time; `/time-limit` inspects and changes the budget.
 *
 * Optional settings (settings.json, global or project):
 *   "sessionTimeLimit": { "minutes": 5, "enabled": true }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXT = "session-time-limit";
const STATUS_KEY = EXT;
const SECTION_KEY = "time_budget";

const DEFAULT_LIMIT_MS = 5 * 60_000;
const TICK_MS = 1_000;
/** Heads-up when this share of the budget is left... */
const WARN_RATIO = 0.2;
/** ...but never earlier than this. */
const MIN_WARN_MS = 30_000;

const OPTION_MORE = "More time (just this run)";
const OPTION_SESSION = "Rest of this session (no more limits)";
const OPTION_CUSTOM = "Set a new limit for this session…";
const OPTION_STOP = "Stop here";

interface PersistedState {
	unlimitedForSession?: boolean;
	limitMs?: number;
}

const DURATION_UNITS: [string, number][] = [
	["ms", 1],
	["hours", 3_600_000],
	["hour", 3_600_000],
	["hrs", 3_600_000],
	["hr", 3_600_000],
	["h", 3_600_000],
	["minutes", 60_000],
	["minute", 60_000],
	["mins", 60_000],
	["min", 60_000],
	["m", 60_000],
	["seconds", 1_000],
	["second", 1_000],
	["secs", 1_000],
	["sec", 1_000],
	["s", 1_000],
];

/** Parses "5m", "90s", "1h", "1h30m", "2m30s" or a bare number of minutes. */
function parseDuration(raw: string): number | undefined {
	const text = raw.trim().toLowerCase().replace(/\s+/g, "");
	if (!text) return undefined;
	if (/^\d+(?:[.,]\d+)?$/.test(text)) {
		const minutes = Number(text.replace(",", "."));
		return minutes > 0 ? Math.round(minutes * 60_000) : undefined;
	}
	let rest = text;
	let total = 0;
	while (rest.length > 0) {
		const numberMatch = rest.match(/^(\d+(?:[.,]\d+)?)/);
		if (!numberMatch) return undefined;
		const value = Number(numberMatch[1].replace(",", "."));
		if (!Number.isFinite(value)) return undefined;
		rest = rest.slice(numberMatch[0].length);
		const unit = DURATION_UNITS.find(([name]) => rest.startsWith(name));
		if (unit) rest = rest.slice(unit[0].length);
		total += value * (unit ? unit[1] : 60_000);
	}
	return total > 0 ? Math.round(total) : undefined;
}

function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatLimit(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
	if (ms % 60_000 === 0) return `${ms / 60_000} min`;
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
	return formatClock(ms);
}

function formatTimeOfDay(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

export default function sessionTimeLimit(pi: ExtensionAPI): void {
	let defaultLimitMs = DEFAULT_LIMIT_MS;
	let limitMs = DEFAULT_LIMIT_MS;
	let enabled = true;
	let unlimitedForSession = false;
	let deadline: number | undefined;
	let runActive = false;
	let warned = false;
	let wrapped = false;
	let asking = false;
	let lastCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastStatusText: string | undefined;

	const remainingMs = (): number | undefined => (deadline === undefined ? undefined : deadline - Date.now());
	const warnAtMs = (): number => Math.max(MIN_WARN_MS, Math.round(limitMs * WARN_RATIO));
	const budgetActive = (): boolean => enabled && !unlimitedForSession;

	function readSettings(): void {
		const settings = pi.getSettings() as Record<string, unknown>;
		const raw = (settings.sessionTimeLimit ?? settings[EXT]) as
			| { minutes?: unknown; limitMinutes?: unknown; enabled?: unknown }
			| undefined;
		if (raw && typeof raw === "object") {
			const minutes = raw.minutes ?? raw.limitMinutes;
			if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
				defaultLimitMs = Math.round(minutes * 60_000);
			} else if (typeof minutes === "string") {
				const parsed = parseDuration(minutes);
				if (parsed) defaultLimitMs = parsed;
			}
			if (typeof raw.enabled === "boolean") enabled = raw.enabled;
		}
	}

	function armDeadline(): void {
		warned = false;
		wrapped = false;
		deadline = budgetActive() ? Date.now() + limitMs : undefined;
	}

	function persist(): void {
		const data: PersistedState = { unlimitedForSession, limitMs };
		pi.appendEntry(EXT, data);
	}

	function restore(ctx: ExtensionContext): void {
		let restored = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== EXT) continue;
			const data = entry.data as PersistedState | undefined;
			if (!data) continue;
			if (typeof data.limitMs === "number" && data.limitMs > 0) limitMs = data.limitMs;
			if (typeof data.unlimitedForSession === "boolean") unlimitedForSession = data.unlimitedForSession;
			restored = true;
		}
		if (!restored) limitMs = defaultLimitMs;
	}

	function paint(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		let text: string | undefined;
		const left = remainingMs();
		if (!budgetActive()) {
			text = unlimitedForSession ? theme.fg("muted", "⏱ off") : undefined;
		} else if (left === undefined) {
			text = theme.fg("muted", `⏱ ${formatLimit(limitMs)}`);
		} else if (left <= 0) {
			text = theme.fg("error", `⏱ ${formatLimit(limitMs)} used`);
		} else {
			const color = left <= warnAtMs() ? "warning" : "muted";
			text = theme.fg(color, `⏱ ${formatClock(left)}`);
		}
		if (text === lastStatusText) return;
		lastStatusText = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function steer(content: string): void {
		pi.sendMessage({ customType: EXT, content, display: true }, { deliverAs: "steer" });
	}

	function headsUpMessage(leftMs: number): string {
		return [
			`⏳ ${formatClock(leftMs)} left of this prompt's ${formatLimit(limitMs)} time budget (deadline ${formatTimeOfDay(deadline ?? Date.now())}).`,
			"Start converging now: finish the step you are on, skip optional follow-ups and extra verification, and get ready to hand back a status.",
		].join("\n");
	}

	function wrapUpMessage(): string {
		return [
			`⏰ Time budget used up (${formatLimit(limitMs)} of work).`,
			"Stop starting new work. Reply with a short status: what is done, what is left, and the next concrete step.",
			`Then ask the user whether to continue — Pi offers them: "${OPTION_MORE}", "${OPTION_SESSION}", "${OPTION_CUSTOM}", "${OPTION_STOP}".`,
		].join("\n");
	}

	function budgetSection(): string | undefined {
		if (!enabled) return undefined;
		if (unlimitedForSession) {
			return "Time budget: none for this session — the user removed the per-prompt time limit. Take the time the task needs.";
		}
		if (deadline === undefined) return undefined;
		const left = deadline - Date.now();
		return [
			`Per-prompt time budget: ${formatLimit(limitMs)} of wall-clock per user message; the clock restarts on every new user message.`,
			`Current time: ${formatTimeOfDay(Date.now())}. This run's deadline: ${formatTimeOfDay(deadline)} (${left > 0 ? `${formatClock(left)} left` : "already used up"}).`,
			"Pace the work to land before the deadline: prefer finishing what you started over opening new investigations, keep tool calls purposeful, and check the clock with `date +%T` when unsure.",
			"When Pi says the budget is nearly gone or used up, stop starting new work, wrap up with a short status (done / remaining / next step) and ask the user whether to continue.",
		].join("\n");
	}

	function tick(): void {
		const ctx = lastCtx;
		if (!ctx) return;
		const left = remainingMs();
		if (left !== undefined && runActive && budgetActive()) {
			if (left <= 0 && !wrapped) {
				wrapped = true;
				steer(wrapUpMessage());
			} else if (left > 0 && left <= warnAtMs() && !warned) {
				warned = true;
				steer(headsUpMessage(left));
			}
		}
		paint(ctx);
	}

	function startTicker(ctx: ExtensionContext): void {
		stopTicker();
		lastCtx = ctx;
		ticker = setInterval(tick, TICK_MS);
	}

	function stopTicker(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function describeState(): string {
		const left = remainingMs();
		if (!enabled) return `Session time limit is disabled in settings (${EXT}).`;
		if (unlimitedForSession) return "Session time limit: off for the rest of this session.";
		if (left === undefined) return `Session time limit: ${formatLimit(limitMs)} per prompt (no active run).`;
		if (left <= 0) return `Session time limit: ${formatLimit(limitMs)} per prompt — used up (${formatClock(-left)} over).`;
		return `Session time limit: ${formatLimit(limitMs)} per prompt — ${formatClock(left)} left (deadline ${formatTimeOfDay(deadline ?? Date.now())}).`;
	}

	function continueRun(content: string): void {
		pi.sendMessage({ customType: EXT, content, display: true }, { triggerTurn: true });
	}

	async function askForCustomLimit(ctx: ExtensionContext): Promise<number | undefined> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const raw = await ctx.ui.input(
				`New time limit for this session (e.g. 10m, 90s, 1h) — current ${formatLimit(limitMs)}`,
				formatLimit(limitMs),
			);
			if (raw === undefined) return undefined; // cancelled
			if (!raw.trim()) return undefined;
			const parsed = parseDuration(raw);
			if (parsed) return parsed;
			ctx.ui.notify(`Could not read "${raw}". Use a duration such as 10m, 90s, or 1h.`, "warning");
		}
		return undefined;
	}

	async function askToContinue(ctx: ExtensionContext): Promise<void> {
		const usedLabel = formatLimit(limitMs);
		const title = `⏱ Time limit reached — ${usedLabel} budget used`;

		if (!ctx.hasUI) {
			ctx.ui.notify(`${title}. Send a new message to continue.`, "warning");
			return;
		}

		const moreOption = `${formatLimit(limitMs)} more (just this run)`;
		const choice = await ctx.ui.select(title, [moreOption, OPTION_SESSION, OPTION_CUSTOM, OPTION_STOP]);
		if (choice === undefined || choice === OPTION_STOP) return;

		if (choice === moreOption) {
			armDeadline();
			continueRun(
				`The user granted another ${formatLimit(limitMs)} of work. Continue where you left off and land the task before the new deadline (${formatTimeOfDay(deadline ?? Date.now())}).`,
			);
			return;
		}

		if (choice === OPTION_SESSION) {
			unlimitedForSession = true;
			deadline = undefined;
			persist();
			paint(ctx);
			ctx.ui.notify("Time limit off for the rest of this session.", "info");
			continueRun("The user removed the time limit for the rest of this session. Continue the task at your own pace.");
			return;
		}

		if (choice === OPTION_CUSTOM) {
			const parsed = await askForCustomLimit(ctx);
			if (parsed === undefined) return;
			limitMs = parsed;
			unlimitedForSession = false;
			armDeadline();
			persist();
			paint(ctx);
			ctx.ui.notify(`Time limit for this session: ${formatLimit(limitMs)} per prompt.`, "info");
			continueRun(
				`The user set a new ${formatLimit(limitMs)} budget for this session. Continue where you left off and land the task before the new deadline (${formatTimeOfDay(deadline ?? Date.now())}).`,
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		readSettings();
		unlimitedForSession = false;
		deadline = undefined;
		runActive = !ctx.isIdle();
		asking = false;
		lastStatusText = undefined;
		restore(ctx);
		if (limitMs > 0 && runActive) armDeadline();
		startTicker(ctx);
		paint(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTicker();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source !== "extension") {
			// A new user message starts a fresh budget window.
			runActive = true;
			armDeadline();
			paint(ctx);
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user" && deadline === undefined && budgetActive()) armDeadline();
		const section = budgetSection();
		if (section) event.systemPromptOptions.sections[SECTION_KEY] = section;
		else delete event.systemPromptOptions.sections[SECTION_KEY];
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		runActive = true;
		paint(ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		runActive = false;
		paint(ctx);
		if (event.aborted || asking || !budgetActive()) return;
		const left = remainingMs();
		if (left === undefined || left > 0) return;
		asking = true;
		try {
			await askToContinue(ctx);
		} finally {
			asking = false;
			paint(ctx);
		}
	});

	pi.registerCommand("time-limit", {
		description: "Show or change the per-prompt time limit: /time-limit [10m | off | default | reset]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "status") {
				if (!ctx.hasUI) {
					ctx.ui.notify(describeState(), "info");
					return;
				}
				const choice = await ctx.ui.select(describeState(), [
					`Keep ${formatLimit(limitMs)} and restart the clock`,
					OPTION_SESSION,
					"Use the default limit",
					"Set a custom limit…",
				]);
				if (choice === undefined) return;
				if (choice.startsWith("Keep")) {
					armDeadline();
					paint(ctx);
					ctx.ui.notify(`Clock restarted: ${formatClock(limitMs)} left.`, "info");
				} else if (choice === OPTION_SESSION) {
					unlimitedForSession = true;
					deadline = undefined;
					persist();
					paint(ctx);
					ctx.ui.notify("Time limit off for the rest of this session.", "info");
				} else if (choice === "Use the default limit") {
					limitMs = defaultLimitMs;
					unlimitedForSession = false;
					armDeadline();
					persist();
					paint(ctx);
					ctx.ui.notify(`Time limit reset to the default: ${formatLimit(limitMs)} per prompt.`, "info");
				} else {
					const parsed = await askForCustomLimit(ctx);
					if (parsed === undefined) return;
					limitMs = parsed;
					unlimitedForSession = false;
					armDeadline();
					persist();
					paint(ctx);
					ctx.ui.notify(`Time limit: ${formatLimit(limitMs)} per prompt.`, "info");
				}
				return;
			}

			if (["off", "none", "unlimited"].includes(arg)) {
				unlimitedForSession = true;
				deadline = undefined;
				persist();
				paint(ctx);
				ctx.ui.notify("Time limit off for the rest of this session.", "info");
				return;
			}

			if (["default", "on"].includes(arg)) {
				limitMs = defaultLimitMs;
				unlimitedForSession = false;
				armDeadline();
				persist();
				paint(ctx);
				ctx.ui.notify(`Time limit reset to the default: ${formatLimit(limitMs)} per prompt.`, "info");
				return;
			}

			if (["reset", "restart"].includes(arg)) {
				unlimitedForSession = false;
				armDeadline();
				paint(ctx);
				ctx.ui.notify(`Clock restarted: ${formatClock(limitMs)} left.`, "info");
				return;
			}

			const parsed = parseDuration(arg);
			if (!parsed) {
				ctx.ui.notify(`Could not read "${args.trim()}". Use 10m, 90s, 1h, off, or default.`, "warning");
				return;
			}
			limitMs = parsed;
			unlimitedForSession = false;
			armDeadline();
			persist();
			paint(ctx);
			ctx.ui.notify(`Time limit for this session: ${formatLimit(limitMs)} per prompt.`, "info");
		},
	});
}
