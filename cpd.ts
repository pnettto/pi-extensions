/**
 * /cpd — Commit, Push, Deploy.
 * Hands the agent a prompt to commit all current changes with a descriptive
 * message, push to the upstream branch, then find and run the project's deploy
 * command. Optional args are passed along as extra notes
 * (e.g. `/cpd deploy to staging`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const buildPrompt = (notes: string) => `Commit, push, and deploy the current project:

1. Commit: review \`git status\` / \`git diff\`, stage the relevant changes, and commit with a concise, descriptive message.
2. Push: push the current branch to its upstream (set upstream on origin if none exists).
3. Deploy: figure out how this project deploys (check package.json scripts, Makefile, justfile, fly.toml, vercel.json, netlify.toml, Dockerfile/compose, deploy scripts, README, CI config) and run the deploy command. If it's long-running or can't be awaited, at least send/kick off the command and report what you ran. If no deploy mechanism is apparent, say so instead of guessing.

Stop and report if any step fails.${notes ? `\n\nExtra notes from me: ${notes}` : ""}`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cpd", {
		description: "Commit, push and deploy the current project (optional notes as args)",
		handler: async (args, ctx) => {
			const prompt = buildPrompt((args ?? "").trim());
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("/cpd queued after the current run", "info");
			}
		},
	});
}
