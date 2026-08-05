import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export class TestEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly emitted: Array<{ event: string; payload: unknown }> = [];

	on(event: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

export interface TestCommand {
	description?: string;
	handler(args: string, context: ExtensionCommandContext): Promise<void>;
}

export interface TestTool {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
	}>;
}

export class ExtensionHarness {
	readonly events = new TestEventBus();
	readonly lifecycle = new Map<
		string,
		Array<(event: unknown, context: ExtensionContext) => unknown>
	>();
	readonly commands = new Map<string, TestCommand>();
	readonly tools = new Map<string, TestTool>();
	readonly entries: unknown[] = [];
	branchEntries: unknown[] = this.entries;
	readonly messages: Array<{ content: string; options: unknown }> = [];
	readonly notifications: Array<{ message: string; level?: string }> = [];
	idle = true;
	pendingMessages = false;
	appendThrows = false;
	appendFailureMode: "none" | "before" | "after" = "none";
	sendThrows = false;
	sessionId = "todo-test-session";
	mode: "tui" | "rpc" | "json" | "print" = "tui";
	customResults: Array<string | undefined> = [];
	confirmResult = true;

	readonly context = {
		mode: this.mode,
		hasUI: true,
		cwd: "/tmp/pi-todo-test",
		ui: {
			notify: (message: string, level?: string) => {
				this.notifications.push({ message, level });
			},
			custom: async () => this.customResults.shift(),
			confirm: async () => this.confirmResult,
		},
		sessionManager: {
			getSessionId: () => this.sessionId,
			getBranch: () => this.branchEntries,
			getEntries: () => this.entries,
		},
		isIdle: () => this.idle,
		hasPendingMessages: () => this.pendingMessages,
	} as unknown as ExtensionCommandContext;

	readonly pi = {
		events: this.events,
		on: (
			event: string,
			handler: (event: unknown, context: ExtensionContext) => unknown,
		) => {
			const handlers = this.lifecycle.get(event) ?? [];
			handlers.push(handler);
			this.lifecycle.set(event, handlers);
		},
		registerCommand: (name: string, command: TestCommand) => {
			this.commands.set(name, command);
		},
		registerTool: (tool: TestTool) => {
			this.tools.set(tool.name, tool);
		},
		appendEntry: (customType: string, data: unknown) => {
			if (this.appendThrows || this.appendFailureMode === "before") {
				throw new Error("append failed before insertion");
			}
			const entry = { type: "custom", customType, data };
			this.entries.push(entry);
			if (this.branchEntries !== this.entries) this.branchEntries.push(entry);
			if (this.appendFailureMode === "after") {
				throw new Error("append failed after insertion");
			}
		},
		sendUserMessage: (content: string, options: unknown) => {
			if (this.sendThrows) throw new Error("send failed");
			this.messages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	seed(entries: unknown[], branchEntries: unknown[] = entries): void {
		this.entries.splice(0, this.entries.length, ...entries);
		this.branchEntries =
			branchEntries === entries ? this.entries : [...branchEntries];
	}

	async emitLifecycle(event: string, payload: unknown = {}): Promise<void> {
		for (const handler of this.lifecycle.get(event) ?? []) {
			await handler(payload, this.context);
		}
	}
}
