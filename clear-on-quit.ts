import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Clear the terminal (screen + scrollback) after pi exits via /quit, Ctrl+C, Ctrl+D, etc.
export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		const options = (pi.getSettings() as any).extensionPreferences?.["clear-on-quit"] ?? {};
		// Defer to process exit so it runs after the TUI has restored the terminal.
		process.once("exit", () => {
			if (process.stdout.isTTY) process.stdout.write((options.scrollback !== false ? "\x1b[3J" : "") + (options.screen !== false ? "\x1b[2J\x1b[H" : ""));
		});
	});
}
