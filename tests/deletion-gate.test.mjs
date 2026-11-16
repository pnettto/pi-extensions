import assert from "node:assert/strict";
import test from "node:test";
import { MemoryProvider, FsRpcService } from "../gondolin/node_modules/@earendil-works/gondolin/dist/src/index.js";
import { RemovalApprovalProvider, createRemovalApprover } from "../gondolin/deletion-gate.ts";
import permissionGate from "../permission-gate.ts";
import { resetRemovalSession } from "../shared/removal-session.ts";

let sessionNumber = 0;
function setup(select = async () => "No", hasUI = true) {
	const prompts = [];
	const sessionId = `filesystem-test-${++sessionNumber}`;
	let ctx = { sessionManager: { getSessionId: () => sessionId }, hasUI, ui: { select: async (...args) => { prompts.push(args); return select(...args); } } };
	const approve = createRemovalApprover(() => ctx);
	const backend = new MemoryProvider();
	const provider = new RemovalApprovalProvider(backend, "/workspace", approve);
	return { backend, provider, prompts, approve, context: () => ctx, replaceContext: value => { ctx = value; } };
}

for (const op of ["unlink", "rmdir", "rename"]) {
	for (const choice of ["No", undefined, "Yes, this operation"]) {
		test(`${op}: ${choice}`, async () => {
			const { backend, provider, prompts } = setup(async () => choice);
			if (op === "rmdir") await backend.mkdir("/source");
			else await backend.writeFile("/source", "original");
			if (op === "rename") await backend.writeFile("/destination", "retained");
			const operation = provider[op]("/source", "/destination");
			if (choice === "Yes, this operation") {
				await operation;
				await assert.rejects(backend.lstat("/source"));
				if (op === "rename") assert.equal(await backend.readFile("/destination", "utf8"), "original");
			} else {
				await assert.rejects(operation, { code: "EACCES" });
				await backend.lstat("/source");
				if (op === "rename") assert.equal(await backend.readFile("/destination", "utf8"), "retained");
			}
			assert.equal(prompts.length, 1);
			assert.ok(prompts[0][0].includes('"/workspace/source"'));
			if (op === "rename") assert.ok(prompts[0][0].includes('"/workspace/destination"'));
		});
	}
}

test("no UI or failed UI cannot remove files", async () => {
	for (const state of [setup(undefined, false), setup(async () => { throw Error("disconnected"); })]) {
		await state.backend.writeFile("/file", "retained");
		await assert.rejects(state.provider.unlink("/file"), { code: "EACCES" });
		assert.equal(await state.backend.readFile("/file", "utf8"), "retained");
	}
});

test("sync host entry points fail closed without starting an approval dialog", async () => {
	const { backend, provider, prompts } = setup(async () => "Yes, this operation");
	await backend.writeFile("/file", "retained");
	for (const op of ["unlinkSync", "rmdirSync", "renameSync"]) assert.throws(() => provider[op]("/file", "/other"), { code: "EACCES" });
	assert.equal(prompts.length, 0);
	assert.equal(await backend.readFile("/file", "utf8"), "retained");
});

test("approval is not cached and cancellation or session shutdown invalidates it", async () => {
	for (const invalidate of [state => state.context().signal = AbortSignal.abort(), state => state.replaceContext(undefined)]) {
		let release;
		const state = setup(() => new Promise(resolve => { release = resolve; }));
		await state.backend.writeFile("/file", "retained");
		const pending = state.provider.unlink("/file");
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(await state.backend.readFile("/file", "utf8"), "retained");
		invalidate(state);
		release("Yes, this operation");
		await assert.rejects(pending, { code: "EACCES" });
		await state.backend.lstat("/file");
	}
	let count = 0;
	const state = setup(async () => ++count === 1 ? "Yes, this operation" : "No");
	await state.backend.writeFile("/file", "one");
	await state.provider.unlink("/file");
	await state.backend.writeFile("/file", "two");
	await assert.rejects(state.provider.unlink("/file"), { code: "EACCES" });
	assert.equal(count, 2);
});

test("concurrent removals across mounts serialize dialogs, with no inherited approval", async () => {
	const releases = [];
	const state = setup(() => new Promise(resolve => releases.push(resolve)));
	const otherBackend = new MemoryProvider();
	const other = new RemovalApprovalProvider(otherBackend, "/cache/npm", state.approve);
	await state.backend.writeFile("/one", "one");
	await otherBackend.writeFile("/two", "two");
	const first = state.provider.unlink("/one");
	const second = other.unlink("/two");
	const secondRejected = assert.rejects(second, { code: "EACCES" });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(releases.length, 1);
	releases[0]("Yes, this operation");
	await first;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(releases.length, 2);
	assert.ok(state.prompts[1][0].includes('"/cache/npm/two"'));
	releases[1]("No");
	await secondRejected;
	await otherBackend.lstat("/two");
});

test("ordinary reads, writes and creation remain available without approval", async () => {
	const { provider, prompts } = setup();
	await provider.mkdir("/dir");
	const file = await provider.open("/dir/file", "w");
	await file.writeFile("content");
	await file.close();
	assert.equal((await provider.stat("/dir/file")).size, 7);
	assert.equal(prompts.length, 0);
});

test("guest filesystem RPC denies unlink/rmdir/rename independently of shell or language", async () => {
	const { backend, provider, prompts } = setup();
	await backend.writeFile("/file", "retained");
	await backend.mkdir("/empty");
	const rpc = new FsRpcService(provider);
	for (const [op, req] of [
		["unlink", { parent_ino: 1, name: "file" }],
		["rmdir", { parent_ino: 1, name: "empty" }],
		["rename", { old_parent_ino: 1, old_name: "file", new_parent_ino: 1, new_name: "replacement" }],
	]) {
		const result = await rpc.handleRequest({ v: 1, t: "fs_request", id: 1, p: { op, req } });
		assert.equal(result.p.err, 13, JSON.stringify(result));
	}
	assert.equal(prompts.length, 3);
	assert.equal(await backend.readFile("/file", "utf8"), "retained");
	await backend.lstat("/empty");
	await rpc.close();
});

test("session choice covers all operations and mounts, but not another session", async () => {
	const state = setup(async () => "Allow in this session");
	await state.backend.writeFile("/one", "one");
	await state.provider.unlink("/one");
	assert.deepEqual(state.prompts[0][1], ["No", "Yes, this operation", "Allow in this session"]);
	await state.backend.mkdir("/dir");
	await state.provider.rmdir("/dir");
	await state.backend.writeFile("/old", "old");
	await state.provider.rename("/old", "/new");
	const otherMount = new MemoryProvider();
	const cache = new RemovalApprovalProvider(otherMount, "/cache/npm", state.approve);
	await otherMount.writeFile("/cache-file", "cache");
	await cache.unlink("/cache-file");
	assert.equal(state.prompts.length, 1);
	const another = setup();
	await another.backend.writeFile("/file", "retained");
	await assert.rejects(another.provider.unlink("/file"), { code: "EACCES" });
});

test("session grant is shared between shell and filesystem gates in both directions", async () => {
	for (const shellFirst of [true, false]) {
		const state = setup(async () => "Allow in this session");
		const handlers = new Map();
		permissionGate({ on: (name, handler) => handlers.set(name, handler) });
		const call = () => handlers.get("tool_call")({ toolName: "bash", input: { command: "rm file" } }, state.context());
		await state.backend.writeFile("/file", "content");
		if (shellFirst) { assert.equal(await call(), undefined); await state.provider.unlink("/file"); }
		else { await state.provider.unlink("/file"); assert.equal(await call(), undefined); }
		assert.equal(state.prompts.length, 1);
		for (const event of ["session_shutdown", "session_start"]) {
			await handlers.get(event)({}, state.context());
			await call();
		}
		assert.equal(state.prompts.length, 3, "lifecycle resets must require fresh approval");
	}
});

test("reset while dialog is pending rejects a session grant", async () => {
	let release;
	const state = setup(() => new Promise(resolve => { release = resolve; }));
	await state.backend.writeFile("/file", "retained");
	const pending = state.provider.unlink("/file");
	await new Promise(resolve => setImmediate(resolve));
	resetRemovalSession(state.context());
	release("Allow in this session");
	await assert.rejects(pending, { code: "EACCES" });
	await state.backend.lstat("/file");
});

test("queued removals reuse an explicitly granted session allowance", async () => {
	let release;
	const state = setup(() => new Promise(resolve => { release = resolve; }));
	await state.backend.writeFile("/one", "one");
	await state.backend.writeFile("/two", "two");
	const first = state.provider.unlink("/one");
	const second = state.provider.unlink("/two");
	await new Promise(resolve => setImmediate(resolve));
	release("Allow in this session");
	await Promise.all([first, second]);
	assert.equal(state.prompts.length, 1);
});

test("separately loaded helper modules share the session grant", async () => {
	const copy = await import("../shared/removal-session.ts?separate-loader");
	const state = setup(async () => "Allow in this session");
	await state.backend.writeFile("/file", "content");
	await state.provider.unlink("/file");
	assert.equal(copy.removalSession(state.context()).allowed, true);
	copy.resetRemovalSession(state.context());
	await state.backend.writeFile("/next", "content");
	await state.provider.unlink("/next");
	assert.equal(state.prompts.length, 2);
});
