import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import permissionGate from "../permission-gate.ts";

let sessionNumber = 0;
function setup({ hasUI = true, select = async () => "No", signal } = {}) {
	const handlers = new Map();
	permissionGate({ on: (name, handler) => handlers.set(name, handler) });
	assert.ok(handlers.has("tool_call"), "gate must register in default Gondolin mode");
	const prompts = [];
	const sessionId = `permission-test-${++sessionNumber}`;
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		hasUI,
		signal,
		ui: { select: async (...args) => { prompts.push(args); return select(...args); } },
	};
	const call = (command, toolName = "bash") => handlers.get("tool_call")(
		{ toolName, input: { command, timeout: 10 } }, ctx,
	);
	return { call, prompts, ctx, handlers };
}

const deletions = [
	"rm -- /workspace/jira-tasks-FLXA23.md",
	"rm file", "rm -i file", "rm -rf dir", "rm --recursive dir", "rm\tfile",
	"/bin/rm -- file", "'/usr/bin/rm' file", '"rm" file', "r''m file", "r\\m file",
	"r\\\nm file", "\\rm file", "command -- rm file", "exec rm file",
	"env -i PATH=/bin rm file", "busybox rm file", "timeout 10 rm file",
	"find . -name '*.tmp' -exec rm -- {} +", "printf '%s\\0' file | xargs -0 rm --",
	"bash -lc 'rm -- file'", 'sh -c "rm -- file"',
	`bash -c 'sh -c "rm -- file"'`, "eval 'rm -- file'",
	"pwd; rm -- file", "true && rm file", "false || rm file", "pwd\nrm file",
	"(rm file)", "{ rm file; }", "echo $(rm file)", "echo `rm file`",
	"if true; then rm file; fi", "for f in a b; do rm -- \"$f\"; done",
	"rm>log file", "rm<list file", "rm file &", "ssh host 'rm file'",
];

for (const command of deletions) {
	test(`requires approval: ${JSON.stringify(command)}`, async () => {
		const { call, prompts } = setup();
		assert.equal((await call(command)).block, true);
		assert.equal(prompts.length, 1);
		assert.ok(prompts[0][0].includes(command), "show the entire original command");
		assert.deepEqual(prompts[0][1], ["No", "Yes, run it", "Allow in this session"]);
	});
}

for (const command of ["pwd", "ls -la", "git status", "rmdir empty", "echo farm", "touch rm.txt", "echo rm-helper", "python -c 'import os; os.unlink(\"file\")'", "node cleanup.js"]) {
	test(`outside rm tripwire: ${command}`, async () => {
		const { call, prompts } = setup();
		assert.equal(await call(command), undefined);
		assert.equal(prompts.length, 0);
	});
}

for (const choice of ["No", undefined, "Yes", "Yes, for this session"]) {
	test(`fails closed for choice ${choice}`, async () => {
		assert.equal((await setup({ select: async () => choice }).call("rm file")).block, true);
	});
}

test("explicit approval is once only, never inferred from user intent", async () => {
	let count = 0;
	const { call, prompts } = setup({ select: async () => ++count === 1 ? "Yes, run it" : "No" });
	assert.equal(await call("rm file"), undefined);
	assert.equal((await call("rm file")).block, true);
	assert.equal(prompts.length, 2);
});

test("no UI blocks without attempting a prompt", async () => {
	const { call, prompts } = setup({ hasUI: false });
	assert.equal((await call("rm file")).block, true);
	assert.equal(prompts.length, 0);
});

test("UI failure and aborted approval fail closed", async () => {
	assert.equal((await setup({ select: async () => { throw Error("disconnected"); } }).call("rm file")).block, true);
	assert.equal((await setup({ select: async () => "Yes, run it", signal: AbortSignal.abort() }).call("rm file")).block, true);
});

test("gate registers regardless of host/VM opt-out flags and environment", async () => {
	const previousArgv = process.argv;
	const previousEnv = process.env.PI_NO_GONDOLIN;
	try {
		for (const [env, flags] of [[undefined, []], ["1", []], ["true", []], ["yes", []], [undefined, ["--no-vm"]], [undefined, ["--no-gondolin"]]]) {
			process.argv = previousArgv.slice(0, 2).concat(flags);
			if (env === undefined) delete process.env.PI_NO_GONDOLIN;
			else process.env.PI_NO_GONDOLIN = env;
			assert.equal((await setup({ hasUI: false }).call("rm -- file")).block, true);
		}
	} finally {
		process.argv = previousArgv;
		if (previousEnv === undefined) delete process.env.PI_NO_GONDOLIN;
		else process.env.PI_NO_GONDOLIN = previousEnv;
	}
});

test("non-bash tools are unchanged", async () => {
	const { call, prompts } = setup();
	assert.equal(await call("rm file", "read"), undefined);
	assert.equal(prompts.length, 0);
});

test("existing non-rm dangerous rules also apply in Gondolin", async () => {
	for (const command of ["sudo ls", "git reset --hard", "git clean -fd", "git push --force", "chmod 777 file"]) {
		assert.equal((await setup().call(command)).block, true, command);
	}
});

test("session grant does not authorize unrelated dangerous commands", async () => {
	let count = 0;
	const state = setup({ select: async () => ++count === 1 ? "Allow in this session" : "No" });
	assert.equal(await state.call("rm first"), undefined);
	assert.equal(await state.call("rm second"), undefined);
	for (const command of ["sudo rm file", "git push --force", "git reset --hard"]) {
		assert.equal((await state.call(command)).block, true);
		assert.deepEqual(state.prompts.at(-1)[1], ["No", "Yes, run it"]);
	}
	assert.equal(state.prompts.length, 4);
});

test("mixed-danger commands cannot grant a removal session allowance", async () => {
	const state = setup({ select: async () => "Allow in this session" });
	assert.equal((await state.call("sudo rm file")).block, true);
	assert.deepEqual(state.prompts[0][1], ["No", "Yes, run it"]);
});

test("session reset or cancellation during shell dialog cannot grant allowance", async () => {
	for (const invalidate of [state => state.handlers.get("session_start")({}, state.ctx), state => { state.ctx.signal = AbortSignal.abort(); }]) {
		let release;
		const state = setup({ select: () => new Promise(resolve => { release = resolve; }) });
		const pending = state.call("rm file");
		await new Promise(resolve => setImmediate(resolve));
		await invalidate(state);
		release("Allow in this session");
		assert.equal((await pending).block, true);
	}
});

test("conservative inspection also gates rm appearing as data", async () => {
	assert.equal((await setup().call("echo 'rm file'")).block, true);
});

// Exercise Pi's actual execution preflight without a model, VM or destructive
// command. Both local bash and Gondolin's registered override use this path.
const install = process.env.PI_TEST_INSTALL ?? path.join(os.homedir(), ".pi/agent/install");
const version = (await readFile(path.join(install, "current-version"), "utf8")).trim();
const { runToolCall } = await import(pathToFileURL(path.join(install, "releases", version,
	"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js")).href);

test("Pi execution preflight cannot reach bash backend until approved", async () => {
	for (const choice of ["No", undefined, "Yes, run it"]) {
		let release;
		let executions = 0;
		const { call } = setup({ select: () => new Promise(resolve => { release = resolve; }) });
		const pending = runToolCall({ type: "toolCall", id: "regression", name: "bash", arguments: { command: deletions[0], timeout: 10 } }, {
			context: { messages: [] },
			assistantMessage: { role: "assistant", content: [] },
			tools: [{ name: "bash", description: "mock shell backend", parameters: {
				type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"],
			}, execute: async () => { executions++; return { content: [{ type: "text", text: "mock execution" }], details: {} }; } }],
			beforeToolCall: ({ toolCall, args }) => call(args.command, toolCall.name),
		});
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(executions, 0, "must wait for UI approval before invoking backend");
		assert.equal(typeof release, "function");
		release(choice);
		const result = await pending;
		assert.equal(executions, choice === "Yes, run it" ? 1 : 0);
		assert.equal(result.isError, choice !== "Yes, run it");
	}
});
