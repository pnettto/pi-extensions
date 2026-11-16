/**
 * Commit Gate — asks before the agent runs `git commit`.
 * Choose "Yes, for the rest of this session" to stop asking until the session ends
 * (or run /allow-commits). New/resumed/forked sessions start gated again.
 * Blocks commits outright when there is no UI (print/RPC mode).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Matches `git commit`, `git -C dir commit`, `git -c k=v commit --amend`, etc.
const commitRe = /\bgit(\s+(-C|-c)\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+commit\b/;

export default function (pi: ExtensionAPI) {
	let allowedForSession = false;

	pi.on("session_start", async () => {
		allowedForSession = false;
	});

	pi.registerCommand("allow-commits", {
		description: "Let the agent commit without asking for the rest of this session",
		handler: async (_args, ctx) => {
			allowedForSession = true;
			ctx.ui.notify("Commits allowed for this session", "info");
		},
	});

	pi.registerCommand("gate-commits", {
		description: "Ask again before each commit in this session",
		handler: async (_args, ctx) => {
			allowedForSession = false;
			ctx.ui.notify("Will ask before each commit", "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		if (!commitRe.test(command)) return undefined;
		if (allowedForSession) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "git commit requires user approval; no UI to confirm" };
		}

		const once = "Yes, this once";
		const session = "Yes, for the rest of this session";
		const choice = await ctx.ui.select(`Agent wants to commit:\n\n  ${command}\n\nAllow?`, [
			"No",
			once,
			session,
		]);

		if (choice === session) {
			allowedForSession = true;
			return undefined;
		}
		if (choice === once) return undefined;
		return { block: true, reason: "User declined the commit. Do not retry unless asked." };
	});
}
