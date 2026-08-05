import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { installPiTodo } from "../src/extension.ts";
import { MAX_LIVE_TODOS } from "../src/state.ts";
import { MAX_TODO_TEXT_CHARS } from "../src/text.ts";
import { ExtensionHarness } from "./harness.ts";

describe("commands and pi_todo tool", () => {
	it("preserves native steering by registering no input hook or /steer command", () => {
		const harness = new ExtensionHarness();
		installPiTodo(harness.pi);
		assert.equal(harness.lifecycle.has("input"), false);
		assert.equal(harness.commands.has("steer"), false);
		assert.equal(harness.commands.has("todo"), true);
		assert.equal(harness.commands.has("todos"), true);
	});

	it("rejects empty and oversized /todo text with bounded feedback", async () => {
		const harness = new ExtensionHarness();
		installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		const command = harness.commands.get("todo");
		assert.ok(command);
		await command.handler("   ", harness.context);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/todo/);
		await command.handler("x".repeat(MAX_TODO_TEXT_CHARS + 1), harness.context);
		assert.match(harness.notifications.at(-1)?.message ?? "", /at most 256/);
		assert.equal(harness.entries.length, 0);
	});

	it("adds, lists, and completes only the active ID with bounded results", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		const tool = harness.tools.get("pi_todo");
		assert.ok(tool);
		assert.match(
			tool.promptGuidelines?.join("\n") ?? "",
			/clearly additive.*genuine corrections/s,
		);
		assert.match(
			tool.promptGuidelines?.join("\n") ?? "",
			/avoid speculative backlog/,
		);

		const added = await tool.execute(
			"add",
			{ action: "add", text: "agent-added item" },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(added.content[0]?.text ?? "", /Queued todo #1/);
		await tool.execute(
			"add",
			{ action: "add", text: "second item" },
			undefined,
			undefined,
			harness.context,
		);
		const refused = await tool.execute(
			"complete",
			{ action: "complete", id: 1 },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(refused.content[0]?.text ?? "", /Only the active todo/);

		const listed = await tool.execute(
			"list",
			{ action: "list", limit: 1 },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(
			listed.content[0]?.text ?? "",
			/\[queued\] #1: agent-added item/,
		);
		assert.match(listed.content[0]?.text ?? "", /\.\.\. 1 more/);
		assert.equal((listed.details as { omitted?: number }).omitted, 1);
		assert.ok((listed.content[0]?.text.length ?? 0) < 5_000);

		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(runtime.getItem(1)?.status, "active");
		harness.idle = false;
		const completed = await tool.execute(
			"complete",
			{ action: "complete", id: 1 },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(completed.content[0]?.text ?? "", /Completed active todo #1/);
		assert.equal(runtime.getItem(1), undefined);
	});

	it("bounds agent-added work at the same live capacity", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		const tool = harness.tools.get("pi_todo");
		assert.ok(tool);
		for (let index = 0; index < MAX_LIVE_TODOS; index += 1) {
			const result = await tool.execute(
				"add",
				{ action: "add", text: `agent item ${index}` },
				undefined,
				undefined,
				harness.context,
			);
			assert.match(result.content[0]?.text ?? "", /Queued todo/);
		}
		const overflow = await tool.execute(
			"add",
			{ action: "add", text: "one too many" },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(overflow.content[0]?.text ?? "", /queue is full/i);
		const list = await tool.execute(
			"list",
			{ action: "list", limit: 16 },
			undefined,
			undefined,
			harness.context,
		);
		assert.match(list.content[0]?.text ?? "", /\.\.\. 48 more/);
		assert.equal(runtime.allItems().length, MAX_LIVE_TODOS);
		assert.ok((list.content[0]?.text.length ?? 0) < 6_000);
		await tick();
		assert.equal(harness.messages.length, 0);
	});
});
