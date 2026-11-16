import path from "node:path";
import { SandboxVfsProvider, type VirtualProvider } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { removalSession } from "../shared/removal-session.ts";

type Removal = { op: "unlink" | "rmdir" | "rename"; mount: string; source: string; destination?: string };
type ApproveRemoval = (request: Removal) => Promise<void>;

function denied(): NodeJS.ErrnoException {
	return Object.assign(new Error("Host filesystem removal requires explicit approval"), { code: "EACCES", errno: -13 });
}

// One queue shared by all mounts: concurrent guest processes must not create
// overlapping dialogs. One-operation approvals are never cached; session grants
// are shared with command preflight and checked after queued requests reach UI.
export function createRemovalApprover(getContext: () => ExtensionContext | undefined): ApproveRemoval {
	let queue = Promise.resolve();
	return (request) => {
		const requestedContext = getContext();
		const state = requestedContext && removalSession(requestedContext);
		const decision = queue.then(async () => {
			const ctx = getContext();
			if (!ctx || ctx !== requestedContext || !ctx.hasUI || ctx.signal?.aborted || removalSession(ctx) !== state) throw denied();
			if (state.allowed) return;
			const source = path.posix.join(request.mount, request.source);
			const destination = request.destination === undefined ? undefined : path.posix.join(request.mount, request.destination);
			let choice: string | undefined;
			try {
				choice = await ctx.ui.select(
					`Host filesystem ${request.op}\n\n${JSON.stringify(source)}${destination === undefined ? "" : `\n→ ${JSON.stringify(destination)}`}\n\nAllow this operation?\nSession approval covers removals on all host-backed mounts.`,
					["No", "Yes, this operation", "Allow in this session"],
				);
			} catch {
				throw denied();
			}
			if ((choice !== "Yes, this operation" && choice !== "Allow in this session") || getContext() !== ctx || ctx.signal?.aborted || removalSession(ctx) !== state) throw denied();
			if (choice === "Allow in this session") state.allowed = true;
		});
		queue = decision.catch(() => {});
		return decision;
	};
}

// The guest's unlink/rmdir/rename RPCs converge here regardless of executable,
// shell syntax or language. Gate every rename, not a racy destination-exists
// check: renaming removes the source name and may replace the destination.
export class RemovalApprovalProvider extends SandboxVfsProvider {
	private readonly mount: string;
	private readonly approve: ApproveRemoval;

	constructor(backend: VirtualProvider, mount: string, approve: ApproveRemoval) {
		super(backend);
		this.mount = mount;
		this.approve = approve;
	}

	override async unlink(source: string): Promise<void> {
		await this.approve({ op: "unlink", mount: this.mount, source });
		await super.unlink(source);
	}

	override async rmdir(source: string): Promise<void> {
		await this.approve({ op: "rmdir", mount: this.mount, source });
		await super.rmdir(source);
	}

	override async rename(source: string, destination: string): Promise<void> {
		await this.approve({ op: "rename", mount: this.mount, source, destination });
		await super.rename(source, destination);
	}

	// Host-side synchronous entry points cannot wait for UI. Guest synchronous
	// syscalls still arrive over the asynchronous RPC path above.
	override unlinkSync(_source: string): never { throw denied(); }
	override rmdirSync(_source: string): never { throw denied(); }
	override renameSync(_source: string, _destination: string): never { throw denied(); }
}
