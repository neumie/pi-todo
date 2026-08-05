import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands.ts";
import { TODO_REQUEST_EVENT } from "./protocol.ts";
import { TodoRuntime } from "./runtime.ts";
import { registerTodoTool } from "./tool.ts";

export function installPiTodo(pi: ExtensionAPI): TodoRuntime {
	const runtime = new TodoRuntime(pi);
	const unsubscribeRequest = pi.events.on(TODO_REQUEST_EVENT, (payload) =>
		runtime.publisher.request(payload),
	);

	pi.on("session_start", (_event, ctx) => runtime.restore(ctx));
	pi.on("session_tree", (_event, ctx) => runtime.restoreTree(ctx));
	pi.on("agent_settled", (_event, ctx) => runtime.onAgentSettled(ctx));
	pi.on("session_shutdown", () => {
		unsubscribeRequest();
		runtime.dispose();
	});

	registerTodoCommands(pi, runtime);
	registerTodoTool(pi, runtime);
	return runtime;
}
