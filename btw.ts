/**
 * /btw — ask a quick side question about the current session without
 * touching the main thread.
 *
 * - Works while the agent is running (extension commands execute immediately).
 * - Snapshots the current conversation, sends it + your question to the
 *   current model (no tools), and streams the answer into a floating overlay.
 * - Type follow-up questions in the overlay's input line; the side thread
 *   (transcript snapshot + all Q&A turns) is sent with each follow-up.
 * - Nothing is written to the session; the main agent never sees it.
 *
 * Keys in the overlay: type + Enter follow up · ↑/↓ scroll · PgUp/PgDn page ·
 * Esc close (closing while streaming aborts the side request).
 */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getMarkdownTheme,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const BG_COLOR = "customMessageBg" as const; // theme bg used for the overlay panel
const MAX_CONTEXT_CHARS = 300_000; // keep the most recent part of long sessions

const SYSTEM_PROMPT = `You are answering a quick "by the way" side question from the user about an ongoing coding-agent session.
The main agent may still be working; you are a separate, read-only helper.
You have no tools. Answer only from the conversation transcript provided and general knowledge.
If the transcript does not contain enough information, say so briefly.
Be concise and direct. Use markdown when helpful.`;

function buildPrompt(ctx: ExtensionCommandContext, question: string): string {
	const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
	let transcript = serializeConversation(messages);
	if (transcript.length > MAX_CONTEXT_CHARS) {
		transcript = `[...earlier conversation truncated...]\n\n${transcript.slice(-MAX_CONTEXT_CHARS)}`;
	}
	return [
		`Working directory: ${ctx.cwd}`,
		"",
		"<transcript>",
		transcript || "(empty session)",
		"</transcript>",
		"",
		"<side_question>",
		question,
		"</side_question>",
	].join("\n");
}

type TurnStatus = "streaming" | "done" | "error" | "aborted";

interface Turn {
	question: string;
	answer: string;
	status: TurnStatus;
	errorText: string;
	md: Markdown;
}

class BtwOverlay implements Component, Focusable {
	private turns: Turn[] = [];
	private scroll = 0;
	private follow = true;
	private lastBodyHeight = 10;
	private input = new Input({ prompt: "› " });
	private _focused = false;

	/** Called when the user submits a follow-up question. */
	onSubmit?: (question: string) => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private modelLabel: string,
		private onClose: () => void,
	) {}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
	}

	get busy() {
		return this.turns.at(-1)?.status === "streaming";
	}

	startTurn(question: string) {
		this.turns.push({ question, answer: "", status: "streaming", errorText: "", md: new Markdown("", 0, 0, getMarkdownTheme()) });
		this.follow = true;
		this.tui.requestRender();
	}

	append(delta: string) {
		const turn = this.turns.at(-1);
		if (!turn) return;
		turn.answer += delta;
		turn.md.setText(turn.answer);
		this.tui.requestRender();
	}

	finish(status: Exclude<TurnStatus, "streaming">, errorText = "") {
		const turn = this.turns.at(-1);
		if (!turn) return;
		turn.status = status;
		turn.errorText = errorText;
		this.tui.requestRender();
	}

	invalidate() {
		for (const t of this.turns) t.md.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string) {
		const page = Math.max(1, this.lastBodyHeight - 1);
		if (matchesKey(data, "escape")) {
			this.onClose();
		} else if (matchesKey(data, "enter")) {
			const q = this.input.getValue().trim();
			if (q && !this.busy) {
				this.input.setValue("");
				this.onSubmit?.(q);
			}
		} else if (matchesKey(data, "up")) {
			this.scroll = Math.max(0, this.scroll - 1);
			this.follow = false;
		} else if (matchesKey(data, "down")) {
			this.scroll += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - page);
			this.follow = false;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll += page;
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const border = (s: string) => t.fg("accent", s);
		const row = (s: string) => {
			const clipped = truncateToWidth(s, inner);
			return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border("│")}`;
		};

		// Header
		const title = ` btw · ${this.modelLabel} `;
		const top = border(`╭─${truncateToWidth(title, width - 4)}${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`);

		// Body: the whole side thread
		const body: string[] = [];
		this.turns.forEach((turn, i) => {
			if (i > 0) body.push("");
			body.push(...wrap(`Q: ${turn.question}`, inner).map((l) => t.fg("accent", t.bold(l))));
			body.push("");
			if (turn.answer) body.push(...turn.md.render(inner));
			else if (turn.status === "streaming") body.push(t.fg("dim", "thinking…"));
			if (turn.status === "error") body.push("", t.fg("error", `Error: ${turn.errorText}`));
			if (turn.status === "aborted") body.push("", t.fg("warning", "Aborted"));
		});

		const maxTotal = Math.max(8, Math.floor(this.tui.terminal.rows * 0.8));
		const bodyHeight = Math.max(3, maxTotal - 6);
		this.lastBodyHeight = bodyHeight;
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.follow) this.scroll = maxScroll;
		this.scroll = Math.min(this.scroll, maxScroll);
		if (this.scroll >= maxScroll) this.follow = true;
		const visible = body.slice(this.scroll, this.scroll + bodyHeight);

		// Footer
		const state = this.busy ? t.fg("warning", "● streaming") : t.fg("success", "✓ ready");
		const pos = body.length > bodyHeight ? t.fg("dim", ` ${this.scroll + 1}-${this.scroll + visible.length}/${body.length}`) : "";
		const help = t.fg("dim", this.busy ? "↑↓/PgUp/PgDn scroll · Esc close" : "Enter follow up · ↑↓/PgUp/PgDn scroll · Esc close · not saved to session");
		const inputLine = this.input.render(inner)[0] ?? "";

		const lines = [
			top,
			...visible.map(row),
			row(t.fg("dim", "─".repeat(inner))),
			row(inputLine),
			row(`${state}${pos}  ${help}`),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];

		// Tinted background for contrast with the main window. Re-apply the bg
		// after any reset sequences emitted by inner styling (markdown, fg colors).
		const bg = t.getBgAnsi(BG_COLOR);
		return lines.map((l) => {
			const padded = l + " ".repeat(Math.max(0, width - visibleWidth(l)));
			return `${bg}${padded.replace(/\x1b\[(0|49)?m/g, (m) => m + bg)}\x1b[49m`;
		});
	}
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/)) {
			if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) {
				out.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		out.push(line);
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a side question about this session (not added to context)",
		handler: async (args, ctx) => {
			let question = args.trim();
			if (!question && ctx.hasUI) question = ((await ctx.ui.input("btw:", "your side question")) ?? "").trim();
			if (!question) return;

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("btw: no model selected", "error");
				return;
			}

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: buildPrompt(ctx, question) }],
				timestamp: Date.now(),
			};
			const modelLabel = `${model.provider}/${model.id}`;

			// Non-TUI fallback: plain request + notify
			if (ctx.mode !== "tui") {
				const res = await ctx.modelRegistry.complete(model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] });
				const text = res.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (ctx.hasUI) ctx.ui.notify(text || res.errorMessage || "(no answer)", "info");
				return;
			}

			// Side-thread history: first user message carries the transcript snapshot.
			const history: Message[] = [userMessage];

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					let controller = new AbortController();
					const overlay = new BtwOverlay(tui, theme, modelLabel, () => {
						controller.abort();
						done();
					});

					const ask = async () => {
						controller = new AbortController();
						try {
							const stream = ctx.modelRegistry.streamSimple(
								model,
								{ systemPrompt: SYSTEM_PROMPT, messages: history },
								{ signal: controller.signal },
							);
							for await (const ev of stream) {
								if (ev.type === "text_delta") overlay.append(ev.delta);
							}
							const result: AssistantMessage = await stream.result();
							if (result.stopReason === "aborted") overlay.finish("aborted");
							else if (result.stopReason === "error") overlay.finish("error", result.errorMessage ?? "unknown error");
							else {
								history.push(result);
								overlay.finish("done");
							}
						} catch (err) {
							if (controller.signal.aborted) overlay.finish("aborted");
							else overlay.finish("error", err instanceof Error ? err.message : String(err));
						}
						// Failed turn: drop its question so the thread stays user/assistant alternating.
						if (history.at(-1)?.role === "user" && history.length > 1) history.pop();
					};

					overlay.onSubmit = (q) => {
						history.push({ role: "user", content: [{ type: "text", text: q }], timestamp: Date.now() });
						overlay.startTurn(q);
						void ask();
					};

					overlay.startTurn(question);
					void ask();
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%" },
				},
			);
		},
	});
}
