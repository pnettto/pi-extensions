import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Exercise the real extension with a fake terminal, clock and Git process runner.
const source = stripTypeScriptTypes(fs.readFileSync(new URL("../file-explorer.ts", import.meta.url), "utf8"))
	.replace(/^import .*;\n/gm, "")
	.replace("export default function fileExplorer", "function fileExplorer");

function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-explorer-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "folder"));
	fs.writeFileSync(path.join(root, "b.txt"), "b");
	const handlers = new Map(), commands = new Map(), timers = new Set(), calls = [], reads = [];
	let component, hidden = false, focused = false, renders = 0;
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender: () => renders++ };
	const theme = { fg: (_c, s) => s, bg: (_c, s) => s, underline: (s) => `<selected>${s}</selected>` };
	const ctx = { cwd: root, hasUI: true, mode: "tui", ui: {
		custom(factory, options) {
			component = factory(tui, theme, {}, () => component.dispose());
			options.onHandle({ isHidden: () => hidden, setHidden: (v) => hidden = v,
				isFocused: () => focused, focus: () => focused = true, unfocus: () => focused = false });
			return Promise.resolve();
		},
		getEditorText: () => "",
	} };
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {}, events: { on() {}, emit() {} },
	};
	const factory = vm.runInNewContext(source + "\nfileExplorer;", {
		fs: { ...fs, readdirSync: (...args) => { reads.push(args[0]); return fs.readdirSync(...args); } },
		os, path, process, AbortController,
		matchesKey: (data, key) => data === key,
		truncateToWidth: (s, width) => s.slice(0, width), visibleWidth: (s) => s.length,
		execFile: (cmd, args, options, callback) => calls.push({ cmd, args, options, callback }),
		setInterval: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.add(timer); return timer; },
		clearInterval: (timer) => timers.delete(timer),
	});
	factory(pi);
	const open = () => commands.get("explorer").handler("", ctx);
	const tick = () => { for (const timer of timers) timer.callback(); };
	const finishGit = (out = "") => {
		calls.at(-1).callback(null, root + "\n");
		calls.at(-1).callback(null, out);
	};
	return { root, handlers, commands, timers, calls, reads, open, tick, finishGit, tui,
		component: () => component, render: () => component.render(200).join("\n"),
		hide: (v) => hidden = v, renders: () => renders };
}

test("polls every 3s only while open, scans expanded directories, preserves selected path", async (t) => {
	const h = setup(t);
	assert.equal(h.timers.size, 0);
	await h.open();
	assert.equal(h.timers.size, 1);
	assert.equal([...h.timers][0].ms, 3000);
	h.finishGit();
	h.render();
	h.component().handleInput("down"); // b.txt, after folder
	h.component().handleInput("escape"); // expose selected path via underline
	fs.writeFileSync(path.join(h.root, "a.txt"), "a");
	h.reads.length = 0;
	h.tick();
	assert.deepEqual(h.reads, [h.root]);
	assert.ok(h.render().includes("<selected>b.txt</selected>"));
	assert.ok(h.render().includes("a.txt"));
	h.finishGit();
	h.component().handleInput("home");
	h.component().handleInput("right");
	h.render();
	fs.writeFileSync(path.join(h.root, "folder", "nested.txt"), "nested");
	h.reads.length = 0;
	h.tick();
	assert.deepEqual(h.reads, [h.root, path.join(h.root, "folder")]);
	assert.ok(h.render().includes("nested.txt"));
	await h.commands.get("explorer").handler("close", { mode: "tui" });
	assert.equal(h.timers.size, 0);
	assert.equal(h.calls.at(-1).options.signal.aborted, true);
});

test("Git refreshes cannot overlap; hidden/narrow panels skip polling; r is removed", async (t) => {
	const h = setup(t);
	await h.open();
	h.tick(); h.tick();
	await h.handlers.get("tool_execution_end")({ toolCallId: "test" });
	assert.equal(h.calls.length, 1); // initial rev-parse still pending
	h.finishGit(" M b.txt\n");
	assert.match(h.render(), /b.txt.*M/);
	const count = h.calls.length;
	h.component().handleInput("r");
	assert.equal(h.calls.length, count);
	assert.ok(!h.render().includes("o r ."));
	h.hide(true); h.tick();
	assert.equal(h.calls.length, count);
	h.hide(false); h.tui.terminal.columns = 80; h.tick();
	assert.equal(h.calls.length, count);
	h.tui.terminal.columns = 120; h.tick();
	assert.equal(h.calls.length, count + 1);
	await h.handlers.get("session_shutdown")();
	assert.equal(h.timers.size, 0);
	const renders = h.renders();
	h.calls.at(-1).callback(null, h.root + "\n"); // stale completion must not start status
	assert.equal(h.calls.length, count + 1);
	assert.equal(h.renders(), renders);
});

test("direct disposal clears polling, and reopening does not duplicate timers", async (t) => {
	const h = setup(t);
	await h.open(); h.finishGit();
	await h.open();
	assert.equal(h.timers.size, 1);
	h.component().dispose();
	assert.equal(h.timers.size, 0);
	await h.open();
	assert.equal(h.timers.size, 1);
	await h.handlers.get("session_shutdown")();
	assert.equal(h.timers.size, 0);
});
