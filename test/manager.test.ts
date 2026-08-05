import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installPiTodo } from "../src/extension.ts";
import { showTodoManager, TodoSelectDialog } from "../src/manager.ts";
import { ExtensionHarness } from "./harness.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function items(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		value: String(index + 1),
		label: `○ #${index + 1} ${"long todo text ".repeat(8)}`,
		description: "queued",
	}));
}

describe("TodoSelectDialog", () => {
	it("bounds every width and terminal height while SelectList scrolls", () => {
		let selected: string | undefined;
		const dialog = new TodoSelectDialog({
			title: "Pi todos",
			items: items(64),
			theme,
			terminalRows: 7,
			onSelect: (value) => {
				selected = value;
			},
			onCancel() {},
		});
		for (const width of [1, 8, 24, 80]) {
			const lines = dialog.render(width);
			assert.ok(lines.length <= 7);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		assert.deepEqual(
			new TodoSelectDialog({
				title: "Pi todos",
				items: items(64),
				theme,
				terminalRows: 0,
				onSelect() {},
				onCancel() {},
			}).render(20),
			[],
		);
		assert.match(
			new TodoSelectDialog({
				title: "Pi todos",
				items: items(64),
				theme,
				terminalRows: 1,
				onSelect() {},
				onCancel() {},
			}).render(20)[0] ?? "",
			/#1/,
		);

		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		assert.equal(selected, "3");
		assert.match(dialog.render(24).join("\n"), /\(3\/64\)/);
	});

	it("handles cancellation without selecting an item", () => {
		let cancelled = false;
		const dialog = new TodoSelectDialog({
			title: "Pi todos",
			items: items(2),
			theme,
			terminalRows: 8,
			onSelect() {
				throw new Error("must not select");
			},
			onCancel: () => {
				cancelled = true;
			},
		});
		dialog.handleInput("\x1b");
		assert.equal(cancelled, true);
	});
});

describe("/todos manager actions", () => {
	it("offers explicit dispatch, requeue, complete, and delete operations", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		assert.equal(runtime.add("first", harness.context).ok, true);
		assert.equal(runtime.add("second", harness.context).ok, true);

		harness.customResults.push("1", "dispatch");
		await showTodoManager(runtime, harness.context);
		assert.equal(harness.messages.length, 0);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(runtime.getItem(1)?.status, "active");

		harness.idle = false;
		harness.customResults.push("1", "requeue", undefined);
		await showTodoManager(runtime, harness.context);
		assert.equal(runtime.getItem(1)?.status, "queued");

		harness.customResults.push("2", "complete", undefined);
		await showTodoManager(runtime, harness.context);
		assert.equal(runtime.getItem(2), undefined);

		harness.customResults.push("1", "delete", undefined);
		await showTodoManager(runtime, harness.context);
		assert.equal(runtime.getItem(1), undefined);
	});

	it("honors delete cancellation and keeps the item", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		runtime.add("keep me", harness.context);
		harness.confirmResult = false;
		harness.customResults.push("1", "delete", undefined);
		await showTodoManager(runtime, harness.context);
		assert.equal(runtime.getItem(1)?.text, "keep me");
	});

	it("reports bounded counts instead of opening custom UI outside TUI mode", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		runtime.add("headless item", harness.context);
		const context = {
			...harness.context,
			mode: "json",
		} as ExtensionCommandContext;
		await showTodoManager(runtime, context);
		assert.match(
			harness.notifications.at(-1)?.message ?? "",
			/0 active · 1 queued/,
		);
		assert.equal(harness.customResults.length, 0);
	});

	it("dispatches the next queued item only after active completion settles", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		runtime.add("first", harness.context);
		runtime.add("second", harness.context);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);

		harness.idle = false;
		harness.customResults.push("1", "complete");
		await showTodoManager(runtime, harness.context);
		assert.equal(harness.messages.length, 1);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 2);
		assert.match(harness.messages[1]!.content, /#2: second/);
	});
});
