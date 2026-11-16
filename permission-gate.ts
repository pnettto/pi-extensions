/**
 * Permission Gate — asks before running destructive / hard-to-reverse bash commands.
 * Blocks them outright when there is no UI (print/RPC mode).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dangerousPatterns: { re: RegExp; why: string }[] = [
	{ re: /\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, why: "recursive/forced delete" },
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

export default function (pi: ExtensionAPI) {
	// Only gate host sessions. Gondolin VM is the default; host mode = --no-vm / --no-gondolin / PI_NO_GONDOLIN.
	const hostMode =
		["1", "true", "yes"].includes((process.env.PI_NO_GONDOLIN ?? "").toLowerCase()) ||
		["--no-vm", "--no-gondolin"].some((f) => process.argv.includes(f));
	if (!hostMode) return;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		const hits = dangerousPatterns.filter((p) => p.re.test(command)).map((p) => p.why);
		if (hits.length === 0) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (${hits.join(", ")}); no UI to confirm` };
		}

		const choice = await ctx.ui.select(`⚠️  Dangerous command (${hits.join(", ")}):\n\n  ${command}\n\nAllow?`, [
			"No",
			"Yes, run it",
		]);

		if (choice !== "Yes, run it") {
			return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
