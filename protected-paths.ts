/**
 * Protected Paths — blocks write/edit tools on secrets and generated/internal dirs.
 * Reading is still allowed. Edit the lists below to adjust.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Exact filenames, or prefixes (".env" also matches ".env.local", ".env.production", ...)
const protectedNames = [/^\.env(\..+)?$/, /^\.dev\.vars$/, /\.(pem|key|p12|pfx)$/, /^id_(rsa|ed25519|ecdsa)(\.pub)?$/, /^\.npmrc$/, /^\.netrc$/];
// Allow these even though they match above (templates are safe to edit)
const allowedNames = [/^\.env\.(example|sample|template)$/];
// Directory segments that must never be written into
const protectedDirs = [".git", "node_modules", ".ssh", ".aws", ".gnupg"];
// Absolute files
const protectedAbs = [resolve(homedir(), ".pi/agent/auth.json")];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const raw = String(event.input.path ?? "");
		const abs = resolve(ctx.cwd ?? process.cwd(), raw.replace(/^~(?=\/|$)/, homedir()));
		const name = basename(abs);
		const segments = abs.split(sep);

		const allowed = allowedNames.some((re) => re.test(name));
		const reason =
			protectedAbs.includes(abs) ? "credential store"
			: !allowed && protectedNames.some((re) => re.test(name)) ? "secret file"
			: protectedDirs.find((d) => segments.includes(d)) ? `inside ${protectedDirs.find((d) => segments.includes(d))}/`
			: undefined;

		if (!reason) return undefined;

		ctx.hasUI && ctx.ui.notify(`Blocked ${event.toolName} to protected path: ${raw}`, "warning");
		return { block: true, reason: `Path "${raw}" is protected (${reason}). Ask the user to change it manually.` };
	});
}
