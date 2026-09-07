import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { installPiTodo } from "../src/extension.ts";
import { TODO_ENTRY_TYPE } from "../src/state.ts";
import { ExtensionHarness } from "./harness.ts";

function mutation(entry: unknown): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	return (entry as { data?: Record<string, unknown> }).data;
}

describe("sequential todo dispatch", () => {
	it("captures /todo while busy and waits for agent_settled, not agent_end", async () => {
		const harness = new ExtensionHarness();
		installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		const command = harness.commands.get("todo");
		assert.ok(command);
		await command.handler("add a regression test", harness.context);
		await tick();
		assert.equal(harness.messages.length, 0);
		assert.deepEqual(mutation(harness.entries[0]), {
			version: 1,
			op: "add",
			id: 1,
			text: "add a regression test",
		});
		assert.match(harness.notifications.at(-1)?.message ?? "", /Queued #1/);

		await harness.emitLifecycle("agent_end");
		assert.equal(harness.messages.length, 0);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);
		assert.match(harness.messages[0]!.content, /#1: add a regression test/);
		assert.deepEqual(harness.messages[0]!.options, { deliverAs: "followUp" });
		assert.equal(mutation(harness.entries[1])?.op, "activate");
	});

	it("dispatches an idle /todo only after the command call unwinds", async () => {
		const harness = new ExtensionHarness();
		installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		const command = harness.commands.get("todo");
		assert.ok(command);
		const handling = command.handler("idle follow-up", harness.context);
		assert.equal(harness.messages.length, 0);
		await handling;
		await tick();
		assert.equal(harness.messages.length, 1);
	});

	it("keeps an explicit next-item selection when more work arrives", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		const command = harness.commands.get("todo");
		assert.ok(command);
		await command.handler("first", harness.context);
		await command.handler("second", harness.context);
		assert.equal(runtime.requestDispatch(2, harness.context).ok, true);
		await command.handler("third", harness.context);
		await tick();
		assert.equal(harness.messages.length, 0);

		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);
		assert.match(harness.messages[0]!.content, /#2: second/);

		harness.idle = false;
		assert.equal(runtime.completeActive(2, harness.context).ok, true);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 2);
		assert.match(harness.messages[1]!.content, /#1: first/);
		assert.equal(runtime.getItem(3)?.status, "queued");
	});

	it("resumes FIFO when the explicitly selected item is removed", async () => {
		for (const op of ["complete", "delete"] as const) {
			const harness = new ExtensionHarness();
			const runtime = installPiTodo(harness.pi);
			await harness.emitLifecycle("session_start", { reason: "startup" });
			harness.idle = false;
			assert.equal(runtime.add("first", harness.context).ok, true);
			assert.equal(runtime.add("second", harness.context).ok, true);
			assert.equal(runtime.requestDispatch(2, harness.context).ok, true);
			const removed = op === "complete"
				? runtime.completeAny(2, harness.context)
				: runtime.delete(2, harness.context);
			assert.equal(removed.ok, true);
			assert.equal(runtime.add("third", harness.context).ok, true);

			harness.idle = true;
			await harness.emitLifecycle("agent_settled");
			assert.equal(harness.messages.length, 1);
			assert.match(harness.messages[0]!.content, /#1: first/);
			assert.equal(runtime.getItem(2), undefined);
			assert.equal(runtime.getItem(3)?.status, "queued");
		}
	});

	it("sends one item at a time and never redispatches an active item", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		assert.equal(runtime.add("first", harness.context).ok, true);
		assert.equal(runtime.add("second", harness.context).ok, true);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);
		assert.match(harness.messages[0]!.content, /#1: first/);
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);

		harness.idle = false;
		assert.equal(
			runtime.add("third during active run", harness.context).ok,
			true,
		);
		assert.equal(runtime.completeActive(1, harness.context).ok, true);
		assert.equal(harness.messages.length, 1);
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 2);
		assert.match(harness.messages[1]!.content, /#2: second/);
		assert.deepEqual(
			runtime.getState().items.map(({ id, status }) => ({ id, status })),
			[
				{ id: 2, status: "active" },
				{ id: 3, status: "queued" },
			],
		);
	});

	it("does not auto-dispatch historical work until new work arms the queue", async () => {
		const historical = {
			type: "custom",
			customType: TODO_ENTRY_TYPE,
			data: { version: 1, op: "add", id: 1, text: "historical" },
		};
		const harness = new ExtensionHarness();
		harness.seed([historical]);
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "resume" });
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);

		assert.equal(runtime.add("new work", harness.context).ok, true);
		runtime.scheduleDispatch(harness.context);
		await tick();
		assert.equal(harness.messages.length, 1);
		assert.match(harness.messages[0]!.content, /#1: historical/);
	});

	it("reconstructs a new branch and disarms historical work", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		assert.equal(runtime.add("old branch", harness.context).ok, true);
		harness.branchEntries = [];
		await harness.emitLifecycle("session_tree", { newLeafId: "root" });
		assert.deepEqual(runtime.getState(), { items: [], nextId: 2 });
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
	});

	it("requeues a synchronous send failure and prevents a retry loop", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		assert.equal(runtime.add("retry safely", harness.context).ok, true);
		harness.sendThrows = true;
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
		assert.equal(runtime.getItem(1)?.status, "queued");
		assert.deepEqual(
			harness.entries.slice(-2).map((entry) => mutation(entry)?.op),
			["activate", "requeue"],
		);

		harness.sendThrows = false;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
		assert.equal(runtime.requestDispatch(1, harness.context).ok, true);
		runtime.scheduleDispatch(harness.context);
		await tick();
		assert.equal(harness.messages.length, 1);
	});

	it("does not expose an append failure that occurs before insertion", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.appendThrows = true;
		assert.deepEqual(runtime.add("cannot persist", harness.context), {
			ok: false,
			error: "persist-failed",
		});
		assert.deepEqual(runtime.getState(), { items: [], nextId: 1 });
		assert.equal(harness.messages.length, 0);
	});

	it("reconstructs and latches when Pi inserts an add before append throws", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.appendFailureMode = "after";
		assert.deepEqual(runtime.add("uncertain persistence", harness.context), {
			ok: false,
			error: "persist-failed",
		});
		assert.deepEqual(runtime.getState(), {
			items: [{ id: 1, text: "uncertain persistence", status: "queued" }],
			nextId: 2,
		});
		harness.appendFailureMode = "none";
		assert.deepEqual(runtime.add("must stay latched", harness.context), {
			ok: false,
			error: "persist-failed",
		});
		assert.equal(harness.entries.length, 1);

		await harness.emitLifecycle("session_tree", { newLeafId: "same-session" });
		assert.equal(
			runtime.add("tree does not clear fault", harness.context).ok,
			false,
		);
		await harness.emitLifecycle("session_start", { reason: "reload" });
		const accepted = runtime.add("next stable item", harness.context);
		assert.equal(accepted.ok, true);
		assert.equal(accepted.ok && accepted.value.id, 2);
	});

	it("fails closed when activation is inserted before append throws", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		assert.equal(runtime.add("activation fault", harness.context).ok, true);
		harness.appendFailureMode = "after";
		harness.idle = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
		assert.equal(runtime.getItem(1)?.status, "active");
		assert.match(
			harness.notifications.at(-1)?.message ?? "",
			/automatic dispatch stopped/,
		);
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
		assert.deepEqual(runtime.requestDispatch(1, harness.context), {
			ok: false,
			error: "persist-failed",
		});
	});

	it("reconstructs and latches failed requeue, complete, and delete mutations", async () => {
		const createActive = async () => {
			const harness = new ExtensionHarness();
			const runtime = installPiTodo(harness.pi);
			await harness.emitLifecycle("session_start", { reason: "startup" });
			harness.idle = false;
			runtime.add("active item", harness.context);
			harness.idle = true;
			await harness.emitLifecycle("agent_settled");
			return { harness, runtime };
		};

		const requeueCase = await createActive();
		requeueCase.harness.appendFailureMode = "after";
		assert.equal(
			requeueCase.runtime.requeue(1, requeueCase.harness.context).ok,
			false,
		);
		assert.equal(requeueCase.runtime.getItem(1)?.status, "queued");

		const completeCase = await createActive();
		completeCase.harness.appendFailureMode = "after";
		assert.equal(
			completeCase.runtime.completeActive(1, completeCase.harness.context).ok,
			false,
		);
		assert.equal(completeCase.runtime.getItem(1), undefined);

		const deleteHarness = new ExtensionHarness();
		const deleteRuntime = installPiTodo(deleteHarness.pi);
		await deleteHarness.emitLifecycle("session_start", { reason: "startup" });
		deleteHarness.idle = false;
		deleteRuntime.add("queued item", deleteHarness.context);
		deleteHarness.appendFailureMode = "after";
		assert.equal(deleteRuntime.delete(1, deleteHarness.context).ok, false);
		assert.equal(deleteRuntime.getItem(1), undefined);
	});

	it("waits while Pi still reports native pending messages", async () => {
		const harness = new ExtensionHarness();
		const runtime = installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		harness.idle = false;
		runtime.add("after native follow-ups", harness.context);
		harness.idle = true;
		harness.pendingMessages = true;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 0);
		harness.pendingMessages = false;
		await harness.emitLifecycle("agent_settled");
		assert.equal(harness.messages.length, 1);
	});
});
