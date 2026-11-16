/**
 * Play a chime when pi finishes and is waiting for input (no banner),
 * and when an extension asks for permission mid-run (select/confirm/input dialog).
 * macOS: plays ~/.pi/agent/sounds/Kalimba.mp3 via afplay. Elsewhere: terminal bell.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOUND = join(homedir(), ".pi", "agent", "sounds", "Kalimba.mp3");
const VOLUME = "0.23";
const LOG = join(homedir(), ".pi", "agent", "notify.log");

function chime(): void {
	if (process.platform === "darwin") {
		execFile("/usr/bin/afplay", ["-v", VOLUME, SOUND], (err) => {
			if (err) appendFileSync(LOG, `${new Date().toISOString()} afplay failed: ${err.message}\n`);
		});
	} else {
		process.stdout.write("\x07");
	}
}

export default function (pi: ExtensionAPI) {
	// Only chime for prompts raised while the agent is working (e.g. permission gates),
	// not for user-opened UIs like file explorer or /fork restore pickers.
	let running = false;
	pi.on("agent_start", async () => {
		running = true;
	});
	pi.on("agent_settled", async () => {
		running = false;
		chime();
	});
	// Prompts raised during a tool call (questionnaire tool, permission/commit gates) are the
	// agent asking something — chime for any kind, including custom UIs like the questionnaire.
	let activeTools = 0;
	pi.on("tool_execution_start", async () => {
		activeTools++;
	});
	pi.on("tool_execution_end", async () => {
		activeTools = Math.max(0, activeTools - 1);
	});
	pi.on("agent_end", async () => {
		activeTools = 0;
	});
	pi.on("ui_prompt_start", async (event) => {
		if (!running) return;
		if (activeTools > 0 || ["select", "confirm", "input"].includes(event.kind)) chime();
	});
}
