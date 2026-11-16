/**
 * Host credentials for the Gondolin guest, gated by user approval.
 *
 * The guest only ever sees placeholders in env vars (GH_TOKEN,
 * CLOUDFLARE_API_TOKEN, ...). When an outbound HTTPS request carries one of
 * those placeholders to the service's hosts, the request is held and the user
 * is asked to approve it. Only after approval is the real token read from the
 * host (gh, wrangler, gcloud, keychain, ...) and swapped into the request by
 * Gondolin. Denied requests get a 403 and never leave the host.
 *
 * Grants: "this command" lasts until the current bash tool call finishes;
 * "this session" lasts until pi exits (or /creds revoke). `!` commands you run
 * yourself are approved automatically.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHttpHooks } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Service = {
	id: string;
	label: string;
	/** env var that carries the placeholder in the guest */
	envVar: string;
	/** extra guest env vars that get the same placeholder */
	aliases?: string[];
	/** hosts the real token may be sent to */
	hosts: string[];
	/** placeholder prefix, for clients that sniff token format */
	placeholderPrefix?: string;
	/** how long a fetched token is reused before re-reading it from the host */
	ttlMs: number;
	/** reads the real token on the host; returns undefined when not logged in */
	fetchToken: () => Promise<string | undefined>;
	/** short hint shown when no token is available */
	setupHint: string;
};

const KEYCHAIN_SERVICE = "pi-gondolin";

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string | undefined> {
	return new Promise((resolve) => {
		// Run from $HOME, not pi's cwd: in a project, `npx wrangler` would pick up
		// the project's node_modules, which the Linux guest may have installed.
		execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, cwd: os.homedir() }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});
}

/** Token stored with: security add-generic-password -s pi-gondolin -a <id> -w */
function keychain(account: string) {
	return run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
}

async function wranglerToken(): Promise<string | undefined> {
	const out = await run("npx", ["-y", "wrangler", "auth", "token", "--json"], 60_000);
	if (!out) return undefined;
	try {
		const parsed = JSON.parse(out);
		return typeof parsed?.token === "string" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

async function stripeKey(): Promise<string | undefined> {
	try {
		const toml = await readFile(path.join(os.homedir(), ".config/stripe/config.toml"), "utf8");
		return toml.match(/^\s*test_mode_api_key\s*=\s*['"]([^'"]+)['"]/m)?.[1];
	} catch {
		return undefined;
	}
}

const MINUTE = 60_000;

export const SERVICES: Service[] = [
	{
		id: "github",
		label: "GitHub",
		envVar: "GH_TOKEN",
		aliases: ["GITHUB_TOKEN"],
		hosts: ["github.com", "*.github.com", "*.githubusercontent.com"],
		ttlMs: 60 * MINUTE,
		fetchToken: async () => (await keychain("github")) ?? run("gh", ["auth", "token"]),
		setupHint: "Run `gh auth login` on the host.",
	},
	{
		id: "cloudflare",
		label: "Cloudflare",
		envVar: "CLOUDFLARE_API_TOKEN",
		hosts: ["api.cloudflare.com"],
		// wrangler's OAuth token lasts ~1h; `wrangler auth token` refreshes it.
		ttlMs: 10 * MINUTE,
		fetchToken: async () => (await keychain("cloudflare")) ?? wranglerToken(),
		setupHint: "Run `npx wrangler login` on the host.",
	},
	{
		id: "deno-deploy",
		label: "Deno Deploy",
		envVar: "DENO_DEPLOY_TOKEN",
		hosts: ["deno.com", "*.deno.com"],
		placeholderPrefix: "ddo_",
		ttlMs: 60 * MINUTE,
		fetchToken: () => keychain("deno-deploy"),
		setupHint:
			"Create a token at https://console.deno.com/account/tokens, then run `security add-generic-password -s pi-gondolin -a deno-deploy -w` on the host.",
	},
	{
		id: "gcloud",
		label: "Google Cloud",
		envVar: "GOOGLE_OAUTH_ACCESS_TOKEN",
		aliases: ["CLOUDSDK_AUTH_ACCESS_TOKEN"],
		hosts: ["*.googleapis.com"],
		ttlMs: 30 * MINUTE,
		fetchToken: () => run("gcloud", ["auth", "print-access-token"]),
		setupHint: "Run `gcloud auth login` on the host.",
	},
	{
		id: "stripe",
		label: "Stripe (test mode)",
		envVar: "STRIPE_API_KEY",
		hosts: ["api.stripe.com", "files.stripe.com"],
		ttlMs: 60 * MINUTE,
		fetchToken: async () => (await keychain("stripe")) ?? stripeKey(),
		setupHint: "Run `stripe login` on the host.",
	},
];

const NOT_FETCHED = "pi-gondolin-not-approved";
const PROMPT_TIMEOUT_MS = 2 * MINUTE;

const ALLOW_COMMAND = "Allow for this command";
const allowSessionLabel = (s: Service) => `Allow ${s.label} for this session`;
const DENY = "Deny";

function randomSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}

function hostMatches(hostname: string, patterns: string[]): boolean {
	const host = hostname.toLowerCase();
	return patterns.some((pattern) => {
		const regex = new RegExp(
			`^${pattern
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
			"i",
		);
		return regex.test(host);
	});
}

function requestCarries(request: Request, placeholder: string): boolean {
	if (request.url.includes(placeholder)) return true;
	for (const [, value] of request.headers) {
		if (value.includes(placeholder)) return true;
		const basic = value.match(/^Basic\s+(\S+)\s*$/i);
		if (basic) {
			try {
				if (Buffer.from(basic[1], "base64").toString("utf8").includes(placeholder)) return true;
			} catch {
				// not base64
			}
		}
	}
	return false;
}

export type CredentialBroker = ReturnType<typeof createCredentialBroker>;

export function createCredentialBroker(getCtx: () => ExtensionContext | undefined) {
	const placeholders = new Map<string, string>();
	const secrets: Record<string, { hosts: string[]; value: string; placeholder: string }> = {};
	for (const service of SERVICES) {
		const placeholder = `${service.placeholderPrefix ?? ""}pi_gondolin_${service.id.replace(/-/g, "_")}_${randomSuffix(24)}`;
		placeholders.set(service.id, placeholder);
		secrets[service.envVar] = { hosts: service.hosts, value: NOT_FETCHED, placeholder };
	}

	const sessionGrants = new Set<string>();
	const commandGrants = new Set<string>();
	const commandDenials = new Set<string>();
	const pendingPrompts = new Map<string, Promise<boolean>>();
	const tokenFetchedAt = new Map<string, number>();
	let activeCommand: string | undefined;
	let userCommandDepth = 0;

	// biome-ignore lint/style/useConst: assigned right below
	let secretManager: ReturnType<typeof createHttpHooks>["secretManager"];

	async function ensureToken(service: Service): Promise<string | undefined> {
		const fetchedAt = tokenFetchedAt.get(service.id);
		if (fetchedAt && Date.now() - fetchedAt < service.ttlMs) return "cached";
		const token = await service.fetchToken();
		if (!token) return undefined;
		secretManager.updateSecret(service.envVar, { value: token });
		tokenFetchedAt.set(service.id, Date.now());
		return token;
	}

	async function ask(service: Service, request: Request): Promise<boolean> {
		const ctx = getCtx();
		if (!ctx?.hasUI) return false;
		const url = new URL(request.url);
		const lines = [
			`Use ${service.label} credentials?`,
			"",
			`  ${request.method} ${url.host}${url.pathname}`,
			activeCommand ? `  from: ${activeCommand.length > 200 ? `${activeCommand.slice(0, 200)}…` : activeCommand}` : "  from: a background process",
		];
		const options = activeCommand ? [ALLOW_COMMAND, allowSessionLabel(service), DENY] : [allowSessionLabel(service), DENY];
		const choice = await ctx.ui.select(lines.join("\n"), options, { timeout: PROMPT_TIMEOUT_MS });
		if (choice === allowSessionLabel(service)) {
			sessionGrants.add(service.id);
			return true;
		}
		if (choice === ALLOW_COMMAND) {
			commandGrants.add(service.id);
			return true;
		}
		if (activeCommand) commandDenials.add(service.id);
		return false;
	}

	async function authorize(service: Service, request: Request): Promise<boolean> {
		if (userCommandDepth > 0 || sessionGrants.has(service.id) || commandGrants.has(service.id)) return true;
		if (commandDenials.has(service.id)) return false;
		// One prompt per service at a time; parallel requests share the answer.
		let pending = pendingPrompts.get(service.id);
		if (!pending) {
			pending = ask(service, request).finally(() => pendingPrompts.delete(service.id));
			pendingPrompts.set(service.id, pending);
		}
		return pending;
	}

	function deny(service: Service, message: string): Response {
		getCtx()?.ui.notify(`${service.label}: ${message}`, "warning");
		return new Response(`pi-gondolin: ${message}\n`, {
			status: 403,
			headers: { "content-type": "text/plain" },
		});
	}

	const hooks = createHttpHooks({
		secrets,
		onRequest: async (request) => {
			const hostname = new URL(request.url).hostname;
			for (const service of SERVICES) {
				if (!hostMatches(hostname, service.hosts)) continue;
				if (!requestCarries(request, placeholders.get(service.id)!)) continue;
				if (!(await authorize(service, request))) {
					return deny(service, `request to ${hostname} blocked (not approved)`);
				}
				const token = await ensureToken(service);
				if (!token) return deny(service, `not logged in on the host. ${service.setupHint}`);
			}
			return undefined;
		},
	});
	secretManager = hooks.secretManager;

	const guestEnv: Record<string, string> = {};
	for (const service of SERVICES) {
		const placeholder = placeholders.get(service.id)!;
		guestEnv[service.envVar] = placeholder;
		for (const alias of service.aliases ?? []) guestEnv[alias] = placeholder;
	}
	guestEnv.WRANGLER_SEND_METRICS = "false";

	// Not secret, but wrangler needs it when using an API token. Filled in lazily.
	run("npx", ["-y", "wrangler", "whoami", "--json"], 60_000).then((out) => {
		try {
			const id = out && JSON.parse(out)?.accounts?.[0]?.id;
			if (typeof id === "string") guestEnv.CLOUDFLARE_ACCOUNT_ID = id;
		} catch {
			// ignore
		}
	});

	return {
		httpHooks: hooks.httpHooks,
		/** env vars to pass into every guest exec (placeholders only) */
		guestEnv,
		/** wrap a bash tool call so "this command" grants end with it */
		async withCommand<T>(command: string, fn: () => Promise<T>): Promise<T> {
			activeCommand = command;
			try {
				return await fn();
			} finally {
				activeCommand = undefined;
				commandGrants.clear();
				commandDenials.clear();
			}
		},
		/** wrap a user `!` command: credentials are approved automatically */
		async withUserCommand<T>(fn: () => Promise<T>): Promise<T> {
			userCommandDepth++;
			try {
				return await fn();
			} finally {
				userCommandDepth--;
			}
		},
		status(): string {
			return SERVICES.map((s) => {
				const state = sessionGrants.has(s.id) ? "allowed for session" : "asks each command";
				return `${s.label} (${s.envVar}): ${state}`;
			}).join("\n");
		},
		revokeAll() {
			sessionGrants.clear();
			commandGrants.clear();
			for (const service of SERVICES) secretManager.updateSecret(service.envVar, { value: NOT_FETCHED });
			tokenFetchedAt.clear();
		},
	};
}
