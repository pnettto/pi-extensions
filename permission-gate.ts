/**
 * Permission Gate — asks before running destructive / hard-to-reverse bash commands.
 * Applies on the host AND in Gondolin (whose workspace mount writes through).
 * Blocks when there is no approval UI (print/JSON mode); RPC can approve via UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removalSession, resetRemovalSession } from "./shared/removal-session.ts";

const dangerousPatterns: { re: RegExp; why: string }[] = [
	{ re: /\bsudo\b/, why: "sudo" },
	{ re: /\b(chmod|chown)\b.*\b777\b/, why: "world-writable permissions" },
	{ re: /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/, why: "force push" },
	{ re: /\bgit\s+reset\s+.*--hard\b/, why: "git reset --hard" },
	{ re: /\bgit\s+clean\b.*-[a-z]*f/, why: "git clean -f" },
	{ re: /\bgit\s+branch\s+.*-D\b/, why: "force branch delete" },
	{ re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, why: "discard all working changes" },
	{ re: /\bgit\s+stash\s+(drop|clear)\b/, why: "drop stash" },
	{ re: /\bdeno\s+task\s+deploy\b|\bdeno\s+deploy\b/, why: "deploy" },
	{ re: /\b(npm|pnpm|yarn)\s+publish\b/, why: "publish package" },
	{ re: /\b(mkfs|dd\s+if=)/, why: "disk-level write" },
	{ re: /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i, why: "destructive SQL" },
	{ re: />\s*\/dev\/(sd|disk)/, why: "write to raw disk" },
	{ re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, why: "pipe remote script to shell" },
];

// Inspect the whole command, not just its first executable: wrappers (env,
// command, bash -c, xargs, busybox, ...) and compound commands can all run rm.
// This deliberately also matches literal rm in quoted data/comments. It is a
// conservative lexical tripwire, NOT a shell interpreter or filesystem policy;
// dynamically computed commands and scripts without literal rm are out of scope.
function containsRm(command: string): boolean {
	const normalized = command.replace(/\\\r?\n/g, "").replace(/[\\'"]/g, "");
	return /(^|[^\w.-])rm(?=$|[\s;&|()<>{}])/m.test(normalized);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => resetRemovalSession(ctx));
	pi.on("session_shutdown", (_event, ctx) => resetRemovalSession(ctx));
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		const hits = dangerousPatterns.filter((p) => p.re.test(command)).map((p) => p.why);
		const state = removalSession(ctx);
		const needsRemovalApproval = containsRm(command) && !state.allowed;
		if (needsRemovalApproval) hits.unshift("rm deletion");
		if (hits.length === 0) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (${hits.join(", ")}); no UI to confirm` };
		}

		const canAllowSession = needsRemovalApproval && hits.length === 1;
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(`⚠️  Dangerous command (${hits.join(", ")}):\n\n  ${command}\n\nAllow?${canAllowSession ? "\nSession approval covers removals on all host-backed mounts." : ""}`, [
				"No",
				"Yes, run it",
				...(canAllowSession ? ["Allow in this session"] : []),
			]);
		} catch {
			return { block: true, reason: "Approval unavailable; command blocked" };
		}

		const allowSession = canAllowSession && choice === "Allow in this session";
		if ((choice !== "Yes, run it" && !allowSession) || ctx.signal?.aborted || removalSession(ctx) !== state) {
			return { block: true, reason: "Command not approved. Do not retry unless asked." };
		}
		if (allowSession) state.allowed = true;
		return undefined;
	});
}
