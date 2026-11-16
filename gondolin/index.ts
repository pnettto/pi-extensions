/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { type CredentialBroker, createCredentialBroker, SERVICES } from "./credentials.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

// Host credentials (GitHub, Cloudflare, Deno Deploy, ...) live in
// credentials.ts: the guest only sees placeholders, and each use is approved
// by the user before the real token is swapped into the outbound request.

// Custom guest image with git, gh and ripgrep preinstalled. Rebuild with:
//   cd ~/.pi/agent/extensions/gondolin
//   ~/.pi/agent/extensions/gondolin/build-image.sh
const GUEST_IMAGE = process.env.PI_GONDOLIN_IMAGE ?? "pi-dev:latest";
// Copy-on-write disk (sparse: only uses host space as it's written) and RAM.
const GUEST_DISK = process.env.PI_GONDOLIN_DISK ?? "16G";
const GUEST_MEMORY = process.env.PI_GONDOLIN_MEMORY ?? "4G";
const GUEST_CPUS = Number(process.env.PI_GONDOLIN_CPUS ?? 4);

// --- Sandbox tool discovery -------------------------------------------------
// Top-level packages come from image-config.json; probing the running guest
// confirms which are actually present (gondolin doesn't populate the apk db),
// so the agent's tool list always matches the image after a rebuild. A
// package counts if its command exists and isn't a busybox applet.
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN_PACKAGES = /^(linux-|rng-tools$|ca-certificates|e2fsprogs|font-|bash$|curl$)/;
// Package -> [command to probe, label shown to the agent] when they differ
// from the package name. Unlisted packages probe/show their own name.
const PACKAGE_TOOLS: Record<string, [string, string]> = {
	"github-cli": ["gh", "gh"],
	ripgrep: ["rg", "rg"],
	imagemagick: ["magick", "imagemagick (magick)"],
	sqlite: ["sqlite3", "sqlite3"],
	nodejs: ["node", "node"],
	openssh: ["ssh", "ssh"],
	coreutils: ["ls", "GNU coreutils"],
	findutils: ["find", "GNU findutils"],
	grep: ["grep", "GNU grep"],
	sed: ["sed", "GNU sed"],
	diffutils: ["diff", "diff"],
	procps: ["ps", "ps/top"],
};

function configuredPackages(): string[] {
	try {
		const config = JSON.parse(readFileSync(path.join(EXTENSION_DIR, "image-config.json"), "utf8"));
		return (config?.alpine?.rootfsPackages ?? []).filter((p: string) => !HIDDEN_PACKAGES.test(p));
	} catch {
		return [];
	}
}

async function describeSandbox(vm: VM): Promise<string> {
	const packages = configuredPackages();
	const commands = packages.map((p) => PACKAGE_TOOLS[p]?.[0] ?? p);
	const script = [
		`for c in ${commands.map(shQuote).join(" ")}; do`,
		'  p=$(command -v "$c") && case "$(readlink -f "$p")" in */busybox) ;; *) echo "$c";; esac',
		"done; echo ---; ls /usr/local/bin 2>/dev/null",
	].join("\n");
	const probe = await vm.exec(["/bin/sh", "-c", script]);
	const [found, localPart = ""] = probe.stdout.split("---");
	const present = new Set(found.split("\n").filter(Boolean));
	const localBins = localPart.split(/\s+/).filter(Boolean);
	const installed = new Set(packages.filter((_, i) => present.has(commands[i])));
	const tools = [...installed].map((p) => PACKAGE_TOOLS[p]?.[1] ?? p);
	const lines = [
		`Sandbox (Alpine Linux, musl): ${[...tools, ...localBins].join(", ")}. Install anything else with \`apk add\`.`,
		`Host credentials are available through env vars holding placeholders that are swapped for the real token on outbound HTTPS (the user approves each use; a 403 from "pi-gondolin" means it was denied — don't retry, tell the user): ${SERVICES.map((s) => `${s.label} via ${s.envVar}`).join(", ")}. CLOUDFLARE_ACCOUNT_ID is set for wrangler (\`npx wrangler ...\`). The placeholders can't sign requests, so S3-style signed APIs (e.g. R2 via aws4fetch) need real keys instead.`,
	];
	if (installed.has("chromium") && localBins.includes("playwright")) {
		lines.push(
			"Browser automation: Playwright is installed globally (CommonJS require works via NODE_PATH; for ESM/@playwright/test install it in the project with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). Never run `playwright install`; bundled browsers don't run on musl. Launch with executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (/usr/bin/chromium).",
		);
	} else if (installed.has("chromium")) {
		lines.push("Browser: system chromium at /usr/bin/chromium (use it instead of downloading browsers).");
	}
	return lines.join("\n");
}

// --- Package caches ---------------------------------------------------------
// The guest gets its own persistent npm/Deno caches on the host, separate from
// the host's ~/.npm and Deno cache. The guest can write them (so packages
// survive across VMs), but the host never executes from them, so a tampered
// cache can't escape the sandbox. Seeded once from the host caches with APFS
// clones (`cp -c`), which are near-instant and share disk blocks.
const CACHE_ROOT = process.env.PI_GONDOLIN_CACHE ?? path.join(os.homedir(), ".cache", "pi-gondolin");
const GUEST_NPM_CACHE = "/cache/npm";
const GUEST_DENO_SHARED = "/cache/deno";
// DENO_DIR lives on the guest disk: its SQLite caches (WAL/shm) don't lock
// reliably over the VFS mount. Only remote/ and npm/ are symlinked to the mount.
const GUEST_DENO_DIR = "/var/cache/deno";
const HOST_DENO_DIR =
	process.env.DENO_DIR ??
	(process.platform === "darwin"
		? path.join(os.homedir(), "Library", "Caches", "deno")
		: path.join(os.homedir(), ".cache", "deno"));
const execFileAsync = promisify(execFile);

async function cloneDir(src: string, dest: string): Promise<void> {
	if (!existsSync(src) || existsSync(dest)) return;
	mkdirSync(path.dirname(dest), { recursive: true });
	try {
		await execFileAsync("cp", ["-cR", src, dest]);
	} catch {
		await execFileAsync("cp", ["-R", src, dest]);
	}
}

async function prepareCaches(ctx?: ExtensionContext): Promise<{ npm: string; deno: string }> {
	const npm = path.join(CACHE_ROOT, "npm");
	const deno = path.join(CACHE_ROOT, "deno");
	const marker = path.join(CACHE_ROOT, ".seeded");
	if (!existsSync(marker)) {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", "Gondolin: seeding package caches"));
		try {
			await cloneDir(path.join(os.homedir(), ".npm", "_cacache"), path.join(npm, "_cacache"));
			await cloneDir(path.join(HOST_DENO_DIR, "remote"), path.join(deno, "remote"));
			await cloneDir(path.join(HOST_DENO_DIR, "npm"), path.join(deno, "npm"));
			writeFileSync(marker, new Date().toISOString());
		} catch (error) {
			ctx?.ui.notify(`Couldn't seed Gondolin package caches: ${error}`, "warning");
		}
	}
	for (const dir of [npm, path.join(deno, "remote"), path.join(deno, "npm")]) mkdirSync(dir, { recursive: true });
	return { npm, deno };
}

const CACHE_INFO = `Package caches persist across VM sessions: npm uses ${GUEST_NPM_CACHE} (npm_config_cache), Deno uses DENO_DIR=${GUEST_DENO_DIR} with remote/ and npm/ stored in ${GUEST_DENO_SHARED}. Prefer installing from cache (e.g. \`npm ci --prefer-offline\`, \`deno install\`) before hitting the network; anything you download is kept for next time. These are the VM's own caches, not the host's.`;

// Point Playwright/Puppeteer at the Alpine chromium (bundled browsers don't run on musl).
const TOOL_ENV: Record<string, string> = {
	npm_config_cache: GUEST_NPM_CACHE,
	DENO_DIR: GUEST_DENO_DIR,
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
	PUPPETEER_SKIP_DOWNLOAD: "1",
	PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
	CHROME_BIN: "/usr/bin/chromium",
	NODE_PATH: "/usr/local/lib/node_modules",
};

function hostCmd(cmd: string, args: string[]): string | undefined {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

let secretEnv: Record<string, string> = {};

// Host env vars that could carry real credentials into the guest.
const SENSITIVE_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|^AWS_|^R2_|^GOOGLE_APPLICATION/i;

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return { ...TOOL_ENV, ...secretEnv };
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string" && !SENSITIVE_ENV.test(key)) result[key] = value;
	}
	// Never leak real host tokens; always use the placeholders.
	return { ...result, ...TOOL_ENV, ...secretEnv };
}

function createGondolinBashOps(
	vm: VM,
	localCwd: string,
	shellPath: string,
	ready?: Promise<unknown>,
	credentials?: { broker: CredentialBroker; userCommand: boolean },
): BashOperations {
	const exec: BashOperations["exec"] = async (command, cwd, options) => {
		if (!credentials) return execInVm(command, cwd, options);
		const run = () => execInVm(command, cwd, options);
		return credentials.userCommand
			? credentials.broker.withUserCommand(run)
			: credentials.broker.withCommand(command, run);
	};
	const execInVm: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout, env }) => {
		if (signal?.aborted) throw new Error("aborted");
		if (ready) await ready;
		const guestCwd = toGuestPath(localCwd, cwd);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		let timedOut = false;
		const timer =
			timeout && timeout > 0
				? setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, timeout * 1000)
				: undefined;

		try {
			const proc = vm.exec([shellPath, "-lc", command], {
				cwd: guestCwd,
				env: sanitizeEnv(env),
				signal: controller.signal,
				stdout: "pipe",
				stderr: "pipe",
			});
			for await (const chunk of proc.output()) onData(chunk.data);
			const result = await proc;
			return { exitCode: result.exitCode };
		} catch (error) {
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};
	return { exec };
}

export default function (pi: ExtensionAPI) {
	// Opt-out: `pi --no-vm`, `pi --no-gondolin` or `PI_NO_GONDOLIN=1 pi` runs pi normally on the host.
	const optOutFlags = ["no-vm", "no-gondolin"];
	for (const name of optOutFlags) {
		pi.registerFlag(name, {
			description: "Run tools on the host instead of inside the Gondolin VM",
			type: "boolean",
			default: false,
		});
	}
	const envOff = ["1", "true", "yes"].includes((process.env.PI_NO_GONDOLIN ?? "").toLowerCase());
	if (envOff || optOutFlags.some((name) => process.argv.includes(`--${name}`))) return;

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";
	let toolsReady: Promise<unknown> | undefined;
	let sandboxInfo = "Sandbox (Alpine Linux, musl). Install packages with `apk add`.";
	let uiCtx: ExtensionContext | undefined;
	const broker = createCredentialBroker(() => uiCtx);

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${path.basename(localCwd)}`));
		// Same object, so CLOUDFLARE_ACCOUNT_ID shows up once it's resolved.
		secretEnv = broker.guestEnv;
		const caches = await prepareCaches(ctx);
		const vmOptions = {
			httpHooks: broker.httpHooks,
			env: { ...TOOL_ENV, ...secretEnv },
			rootfs: { mode: "cow" as const, size: GUEST_DISK },
			sessionLabel: `pi ${path.basename(localCwd)}`,
			vfs: {
				mounts: {
					[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
					[GUEST_NPM_CACHE]: new RealFSProvider(caches.npm),
					[GUEST_DENO_SHARED]: new RealFSProvider(caches.deno),
				},
			},
		};
		let created: VM;
		try {
			created = await VM.create({
				...vmOptions,
				sandbox: { imagePath: GUEST_IMAGE, memory: GUEST_MEMORY, cpus: GUEST_CPUS },
			});
		} catch (error) {
			ctx?.ui.notify(`Gondolin image ${GUEST_IMAGE} unavailable, using default image: ${error}`, "warning");
			created = await VM.create({ ...vmOptions, sandbox: { memory: GUEST_MEMORY, cpus: GUEST_CPUS } });
		}
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		shellPath = bashProbe.stdout.trim() || "/bin/sh";

		// Install git + gh in the background and wire git to use gh credentials.
		const gitName = hostCmd("git", ["config", "--global", "user.name"]);
		const gitEmail = hostCmd("git", ["config", "--global", "user.email"]);
		const setup = [
			// No-op on pi-dev image; fallback install for the default image.
			"command -v git >/dev/null && command -v gh >/dev/null || apk add --no-cache git github-cli >/dev/null 2>&1",
			// --system (/etc/gitconfig) because tool commands inherit the host $HOME.
			`git config --system credential.https://github.com.helper '!gh auth git-credential'`,
			`git config --system --add safe.directory '*'`,
			gitName ? `git config --system user.name ${shQuote(gitName)}` : "true",
			gitEmail ? `git config --system user.email ${shQuote(gitEmail)}` : "true",
			`mkdir -p ${GUEST_DENO_DIR}`,
			`ln -sfn ${GUEST_DENO_SHARED}/remote ${GUEST_DENO_DIR}/remote`,
			`ln -sfn ${GUEST_DENO_SHARED}/npm ${GUEST_DENO_DIR}/npm`,
		].join("; ");
		toolsReady = created
			.exec(["/bin/sh", "-lc", setup], { env: secretEnv })
			.then(() => undefined)
			.catch((error) => ctx?.ui.notify(`Gondolin git/gh setup failed: ${error}`, "warning"));
		try {
			sandboxInfo = await describeSandbox(created);
		} catch (error) {
			ctx?.ui.notify(`Gondolin tool discovery failed: ${error}`, "warning");
		}

		vm = created;
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${path.basename(localCwd)} · ${created.id.slice(0, 8)}`),
		);
		ctx?.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		await ensureVm(ctx);
	});

	pi.registerCommand("creds", {
		description: "Show host credentials shared with the Gondolin VM (`/creds revoke` to reset approvals)",
		handler: async (args, ctx) => {
			if (args.trim() === "revoke") {
				broker.revokeAll();
				ctx.ui.notify("Credential approvals reset", "info");
				return;
			}
			ctx.ui.notify(broker.status(), "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Shell: ${shellPath}`,
					`Package caches: ${CACHE_ROOT} -> ${GUEST_NPM_CACHE}, ${GUEST_DENO_SHARED}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath, toolsReady, {
					broker,
					userCommand: false,
				}),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		uiCtx = ctx;
		const activeVm = await ensureVm(ctx);
		return {
			operations: createGondolinBashOps(activeVm, localCwd, shellPath, toolsReady, {
				broker,
				userCommand: true,
			}),
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureVm(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = [
			`Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`,
			sandboxInfo,
			CACHE_INFO,
		].join("\n");
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
