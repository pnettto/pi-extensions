/**
 * /btw — ask a quick side question about the current session without
 * touching the main thread.
 *
 * - Works while the agent is running (extension commands execute immediately).
 * - Snapshots the current conversation, sends it + your question to the
 *   current model in a one-off request (no tools), and streams the answer
 *   into a floating overlay.
 * - Nothing is written to the session; the main agent never sees it.
 *
 * Keys in the overlay: ↑/↓ scroll · PgUp/PgDn page · Esc/Enter/q close
 * (closing while streaming aborts the side request).
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getMarkdownTheme,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

class BtwOverlay implements Component {
	private answer = "";
	private status: "streaming" | "done" | "error" | "aborted" = "streaming";
	private errorText = "";
	private scroll = 0;
	private follow = true;
	private md: Markdown;
	private lastBodyHeight = 10;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private question: string,
		private modelLabel: string,
		private onClose: () => void,
	) {
		this.md = new Markdown("", 0, 0, getMarkdownTheme());
	}

	append(delta: string) {
		this.answer += delta;
		this.md.setText(this.answer);
		this.tui.requestRender();
	}

	finish(status: "done" | "error" | "aborted", errorText = "") {
		this.status = status;
		this.errorText = errorText;
		this.tui.requestRender();
	}

	invalidate() {
		this.md.invalidate();
	}

	handleInput(data: string) {
		const page = Math.max(1, this.lastBodyHeight - 1);
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
			this.onClose();
		} else if (matchesKey(data, "up") || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.follow = false;
		} else if (matchesKey(data, "down") || data === "j") {
			this.scroll += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - page);
			this.follow = false;
		} else if (matchesKey(data, "pageDown") || data === " ") {
			this.scroll += page;
		} else {
			return;
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
		const qLines = wrap(`Q: ${this.question}`, inner).map((l) => row(t.fg("muted", l)));

		// Body
		let body = this.answer ? this.md.render(inner) : [];
		if (this.status === "streaming" && !this.answer) body = [t.fg("dim", "thinking…")];
		if (this.status === "error") body = [...body, "", t.fg("error", `Error: ${this.errorText}`)];
		if (this.status === "aborted") body = [...body, "", t.fg("warning", "Aborted")];

		const maxTotal = Math.max(8, Math.floor(this.tui.terminal.rows * 0.8));
		const bodyHeight = Math.max(3, maxTotal - qLines.length - 4);
		this.lastBodyHeight = bodyHeight;
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.follow) this.scroll = maxScroll;
		this.scroll = Math.min(this.scroll, maxScroll);
		if (this.scroll >= maxScroll) this.follow = true;
		const visible = body.slice(this.scroll, this.scroll + bodyHeight);

		// Footer
		const state =
			this.status === "streaming" ? t.fg("warning", "● streaming") : this.status === "done" ? t.fg("success", "✓ done") : "";
		const pos = body.length > bodyHeight ? t.fg("dim", ` ${this.scroll + 1}-${this.scroll + visible.length}/${body.length}`) : "";
		const help = t.fg("dim", "↑↓/PgUp/PgDn scroll · Esc close · not saved to session");

		return [
			top,
			...qLines,
			row(t.fg("dim", "─".repeat(inner))),
			...visible.map(row),
			row(`${state}${pos}  ${help}`),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
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
	return out.slice(0, 4);
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
			const controller = new AbortController();
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

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const overlay = new BtwOverlay(tui, theme, question, modelLabel, () => {
						controller.abort();
						done();
					});

					(async () => {
						try {
							const stream = ctx.modelRegistry.streamSimple(
								model,
								{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
								{ signal: controller.signal },
							);
							for await (const ev of stream) {
								if (ev.type === "text_delta") overlay.append(ev.delta);
							}
							const result = await stream.result();
							if (result.stopReason === "aborted") overlay.finish("aborted");
							else if (result.stopReason === "error") overlay.finish("error", result.errorMessage ?? "unknown error");
							else overlay.finish("done");
						} catch (err) {
							if (controller.signal.aborted) overlay.finish("aborted");
							else overlay.finish("error", err instanceof Error ? err.message : String(err));
						}
					})();

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
