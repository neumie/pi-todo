import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TodoSnapshotPublisher } from "./protocol.ts";
import {
	MAX_LIVE_TODOS,
	MAX_TODO_ID,
	TODO_ENTRY_TYPE,
	applyTodoMutation,
	emptyTodoState,
	orderedTodos,
	reconstructTodoState,
	type TodoItem,
	type TodoMutation,
	type TodoState,
} from "./state.ts";
import { MAX_TODO_TEXT_CHARS, normalizeTodoText } from "./text.ts";

export type TodoRuntimeError =
	| "empty"
	| "too-long"
	| "capacity"
	| "id-exhausted"
	| "not-found"
	| "not-queued"
	| "not-active"
	| "active-exists"
	| "persist-failed";

export type TodoRuntimeResult<T = TodoItem> =
	| { ok: true; value: T }
	| { ok: false; error: TodoRuntimeError };

export interface TodoListResult {
	items: TodoItem[];
	queued: number;
	active: number;
	total: number;
	omitted: number;
}

export const MAX_TOOL_LIST_ITEMS = 16;

function copyItem(item: TodoItem): TodoItem {
	return { ...item };
}

function buildTodoDispatchMessage(item: TodoItem): string {
	return [
		`[pi-todo follow-up #${item.id}]`,
		"This is one small related change captured while you were working:",
		`#${item.id}: ${item.text}`,
		"",
		"Preserve any existing work, then implement this item as the sole active follow-up. Handle it sequentially. You may use already-installed subagent tools only when the item is substantial and genuinely separable, while preserving one-writer-per-worktree safety.",
		`After the item is actually finished, call pi_todo with {\"action\":\"complete\",\"id\":${item.id}}. If you cannot finish it, leave it active and explain why.`,
	].join("\n");
}

export class TodoRuntime {
	private state: TodoState = emptyTodoState();
	private sessionId: string | undefined;
	private generation = 0;
	private automaticDispatch = false;
	private preferredDispatchId: number | undefined;
	private dispatching = false;
	private dispatchScheduled = false;
	private persistenceFault = false;
	private disposed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		readonly publisher = new TodoSnapshotPublisher(pi),
	) {}

	restore(context: ExtensionContext): void {
		if (this.disposed) return;
		this.restoreState(context);
		this.persistenceFault = false;
	}

	restoreTree(context: ExtensionContext): void {
		if (this.disposed) return;
		this.restoreState(context);
	}

	private restoreState(context: ExtensionContext): void {
		this.generation += 1;
		this.sessionId = context.sessionManager.getSessionId();
		this.state = reconstructTodoState(
			context.sessionManager.getBranch(),
			context.sessionManager.getEntries(),
		);
		this.automaticDispatch = false;
		this.preferredDispatchId = undefined;
		this.dispatching = false;
		this.dispatchScheduled = false;
		this.publisher.bind(this.sessionId, this.state);
	}

	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.sessionId = undefined;
		this.automaticDispatch = false;
		this.preferredDispatchId = undefined;
		this.dispatching = false;
		this.dispatchScheduled = false;
	}

	getState(): TodoState {
		return {
			items: this.state.items.map(copyItem),
			nextId: this.state.nextId,
		};
	}

	getItem(id: number): TodoItem | undefined {
		const item = this.state.items.find((candidate) => candidate.id === id);
		return item ? copyItem(item) : undefined;
	}

	allItems(): TodoItem[] {
		return orderedTodos(this.state).map(copyItem);
	}

	list(limit = MAX_TOOL_LIST_ITEMS): TodoListResult {
		const boundedLimit = Number.isSafeInteger(limit)
			? Math.max(1, Math.min(MAX_TOOL_LIST_ITEMS, limit))
			: MAX_TOOL_LIST_ITEMS;
		const ordered = this.allItems();
		const active = ordered.some((item) => item.status === "active") ? 1 : 0;
		return {
			items: ordered.slice(0, boundedLimit),
			queued: ordered.length - active,
			active,
			total: ordered.length,
			omitted: Math.max(0, ordered.length - boundedLimit),
		};
	}

	add(value: unknown, context: ExtensionContext): TodoRuntimeResult {
		this.ensureContext(context);
		if (this.persistenceFault) return { ok: false, error: "persist-failed" };
		const normalized = normalizeTodoText(value);
		if (!normalized.ok) {
			return {
				ok: false,
				error: normalized.reason === "too-long" ? "too-long" : "empty",
			};
		}
		if (this.state.items.length >= MAX_LIVE_TODOS)
			return { ok: false, error: "capacity" };
		if (this.state.nextId > MAX_TODO_ID)
			return { ok: false, error: "id-exhausted" };
		const mutation: TodoMutation = {
			version: 1,
			op: "add",
			id: this.state.nextId,
			text: normalized.text,
		};
		const committed = this.commit(mutation, context);
		if (!committed) return { ok: false, error: "persist-failed" };
		this.automaticDispatch = true;
		this.preferredDispatchId = undefined;
		return {
			ok: true,
			value: { id: mutation.id, text: mutation.text, status: "queued" },
		};
	}

	requestDispatch(id: number, context: ExtensionContext): TodoRuntimeResult {
		this.ensureContext(context);
		if (this.persistenceFault) return { ok: false, error: "persist-failed" };
		const item = this.state.items.find((candidate) => candidate.id === id);
		if (!item) return { ok: false, error: "not-found" };
		if (item.status !== "queued") return { ok: false, error: "not-queued" };
		if (this.state.items.some((candidate) => candidate.status === "active")) {
			return { ok: false, error: "active-exists" };
		}
		this.preferredDispatchId = id;
		this.automaticDispatch = true;
		return { ok: true, value: copyItem(item) };
	}

	requeue(id: number, context: ExtensionContext): TodoRuntimeResult {
		this.ensureContext(context);
		if (this.persistenceFault) return { ok: false, error: "persist-failed" };
		const item = this.state.items.find((candidate) => candidate.id === id);
		if (!item) return { ok: false, error: "not-found" };
		if (item.status !== "active") return { ok: false, error: "not-active" };
		if (!this.commit({ version: 1, op: "requeue", id }, context)) {
			return { ok: false, error: "persist-failed" };
		}
		this.automaticDispatch = false;
		this.preferredDispatchId = undefined;
		return { ok: true, value: { ...item, status: "queued" } };
	}

	completeActive(id: number, context: ExtensionContext): TodoRuntimeResult {
		const item = this.getItemAfterEnsure(id, context);
		if (!item) return { ok: false, error: "not-found" };
		if (item.status !== "active") return { ok: false, error: "not-active" };
		return this.remove(item, "complete", true, context);
	}

	completeAny(id: number, context: ExtensionContext): TodoRuntimeResult {
		const item = this.getItemAfterEnsure(id, context);
		if (!item) return { ok: false, error: "not-found" };
		return this.remove(item, "complete", item.status === "active", context);
	}

	delete(id: number, context: ExtensionContext): TodoRuntimeResult {
		const item = this.getItemAfterEnsure(id, context);
		if (!item) return { ok: false, error: "not-found" };
		return this.remove(item, "delete", item.status === "active", context);
	}

	scheduleDispatch(context: ExtensionContext): void {
		if (this.disposed || this.dispatchScheduled) return;
		this.ensureContext(context);
		this.dispatchScheduled = true;
		const generation = this.generation;
		const sessionId = this.sessionId;
		queueMicrotask(() => {
			if (generation !== this.generation || sessionId !== this.sessionId)
				return;
			this.dispatchScheduled = false;
			this.tryDispatch(context);
		});
	}

	onAgentSettled(context: ExtensionContext): void {
		if (this.disposed) return;
		this.ensureContext(context);
		this.tryDispatch(context);
	}

	private getItemAfterEnsure(
		id: number,
		context: ExtensionContext,
	): TodoItem | undefined {
		this.ensureContext(context);
		const item = this.state.items.find((candidate) => candidate.id === id);
		return item ? copyItem(item) : undefined;
	}

	private remove(
		item: TodoItem,
		op: "complete" | "delete",
		continueChain: boolean,
		context: ExtensionContext,
	): TodoRuntimeResult {
		if (this.persistenceFault) return { ok: false, error: "persist-failed" };
		if (!this.commit({ version: 1, op, id: item.id }, context)) {
			return { ok: false, error: "persist-failed" };
		}
		if (continueChain) {
			this.automaticDispatch = this.state.items.some(
				(candidate) => candidate.status === "queued",
			);
			this.preferredDispatchId = undefined;
		}
		return { ok: true, value: item };
	}

	private ensureContext(context: ExtensionContext): void {
		const sessionId = context.sessionManager.getSessionId();
		if (this.sessionId !== sessionId) this.restore(context);
	}

	private commit(mutation: TodoMutation, context: ExtensionContext): boolean {
		if (this.disposed || this.persistenceFault) return false;
		const next = applyTodoMutation(this.state, mutation);
		if (next === this.state) return false;
		try {
			this.pi.appendEntry(TODO_ENTRY_TYPE, mutation);
		} catch {
			this.recoverAfterAppendFailure(context);
			return false;
		}
		this.state = next;
		this.publisher.update(this.state);
		return true;
	}

	private recoverAfterAppendFailure(context: ExtensionContext): void {
		this.persistenceFault = true;
		this.automaticDispatch = false;
		this.preferredDispatchId = undefined;
		this.dispatchScheduled = false;
		try {
			this.state = reconstructTodoState(
				context.sessionManager.getBranch(),
				context.sessionManager.getEntries(),
			);
			this.publisher.update(this.state);
		} catch {
			// Keep the last known state and remain mutation-disabled until a fresh load.
		}
	}

	private tryDispatch(context: ExtensionContext): void {
		if (
			this.disposed ||
			this.persistenceFault ||
			this.dispatching ||
			!this.automaticDispatch
		)
			return;
		if (!context.isIdle() || context.hasPendingMessages()) return;
		if (this.state.items.some((item) => item.status === "active")) return;
		const item =
			this.preferredDispatchId === undefined
				? this.state.items.find((candidate) => candidate.status === "queued")
				: this.state.items.find(
						(candidate) =>
							candidate.id === this.preferredDispatchId &&
							candidate.status === "queued",
					);
		if (!item) {
			this.automaticDispatch = false;
			this.preferredDispatchId = undefined;
			return;
		}

		this.dispatching = true;
		this.preferredDispatchId = undefined;
		if (!this.commit({ version: 1, op: "activate", id: item.id }, context)) {
			this.dispatching = false;
			this.automaticDispatch = false;
			this.notify(
				context,
				`Could not persist activation for todo #${item.id}; automatic dispatch stopped. Reload before using /todos to recover.`,
				"warning",
			);
			return;
		}
		try {
			this.pi.sendUserMessage(buildTodoDispatchMessage(item), {
				deliverAs: "followUp",
			});
		} catch {
			const requeued = this.commit(
				{ version: 1, op: "requeue", id: item.id },
				context,
			);
			this.automaticDispatch = false;
			const recoveredStatus = this.state.items.find(
				(candidate) => candidate.id === item.id,
			)?.status;
			let failureMessage = `Could not dispatch todo #${item.id}; it remains ${recoveredStatus ?? "preserved"}. Use /todos to recover.`;
			if (requeued) {
				failureMessage = `Could not dispatch todo #${item.id}; it remains queued. Use /todos to retry.`;
			} else if (this.persistenceFault) {
				failureMessage = `Could not reconcile todo #${item.id} after dispatch failure; automatic dispatch stopped. Reload before using /todos to recover.`;
			}
			this.notify(context, failureMessage, "warning");
		} finally {
			this.dispatching = false;
		}
	}

	private notify(
		context: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error",
	): void {
		try {
			context.ui.notify(message, level);
		} catch {
			// A stale or non-interactive UI cannot affect persisted queue state.
		}
	}
}

export function todoRuntimeErrorMessage(error: TodoRuntimeError): string {
	const messages: Record<TodoRuntimeError, string> = {
		empty: "Todo text is required.",
		"too-long": `Todo text must be at most ${MAX_TODO_TEXT_CHARS} characters.`,
		capacity: `Todo queue is full (${MAX_LIVE_TODOS} actionable items).`,
		"id-exhausted": "Todo ID limit reached for this session.",
		"not-found": "Todo ID was not found on the active branch.",
		"not-queued": "Only queued todos can be dispatched.",
		"not-active":
			"Only the active todo can be completed or requeued by the agent.",
		"active-exists":
			"Finish, requeue, complete, or delete the active todo first.",
		"persist-failed": "Todo state could not be persisted.",
	};
	return messages[error];
}
