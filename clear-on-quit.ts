import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Clear the terminal (screen + scrollback) after pi exits via /quit, Ctrl+C, Ctrl+D, etc.
export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		// Defer to process exit so it runs after the TUI has restored the terminal.
		process.once("exit", () => {
			if (process.stdout.isTTY) process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
		});
	});
}
