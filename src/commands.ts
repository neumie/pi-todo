import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showTodoManager } from "./manager.ts";
import { type TodoRuntime, todoRuntimeErrorMessage } from "./runtime.ts";
import { MAX_TODO_TEXT_CHARS } from "./text.ts";

export function registerTodoCommands(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.registerCommand("todo", {
		description: "Queue one small related change without steering the active run",
		handler: (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(`Usage: /todo <text> (maximum ${MAX_TODO_TEXT_CHARS} characters)`, "warning");
				return Promise.resolve();
			}
			const result = runtime.add(args, ctx);
			if (!result.ok) {
				ctx.ui.notify(todoRuntimeErrorMessage(result.error), "warning");
				return Promise.resolve();
			}
			ctx.ui.notify(`Queued #${result.value.id} for after current work`, "info");
			runtime.scheduleDispatch(ctx);
			return Promise.resolve();
		},
	});

	pi.registerCommand("todos", {
		description: "View and manage queued or active Pi todos",
		handler: async (_args, ctx) => showTodoManager(runtime, ctx),
	});
}
