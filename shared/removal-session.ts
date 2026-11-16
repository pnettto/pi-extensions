import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type RemovalSession = { allowed: boolean };
// Pi loads extensions with jiti moduleCache:false. A process-local registry is
// needed so both gates see the same grant even when this module is loaded twice.
// Session lifecycle resets replace the token, invalidating pending approvals.
const key = Symbol.for("pi.extensions.removal-session.v1");
const registry = globalThis as typeof globalThis & { [key]?: Map<string, RemovalSession> };
const sessions = registry[key] ??= new Map<string, RemovalSession>();

export function removalSession(ctx: ExtensionContext): RemovalSession {
	const id = ctx.sessionManager.getSessionId();
	let state = sessions.get(id);
	if (!state) sessions.set(id, state = { allowed: false });
	return state;
}

export function resetRemovalSession(ctx: ExtensionContext): void {
	sessions.set(ctx.sessionManager.getSessionId(), { allowed: false });
}
