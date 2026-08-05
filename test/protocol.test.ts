import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPiTodo } from "../src/extension.ts";
import {
	MAX_SNAPSHOT_ITEMS,
	TODO_READY_EVENT,
	TODO_REQUEST_EVENT,
	TODO_SNAPSHOT_EVENT,
	TodoSnapshotPublisher,
	createTodoSnapshot,
} from "../src/protocol.ts";
import { applyTodoMutation, emptyTodoState } from "../src/state.ts";
import { ExtensionHarness } from "./harness.ts";

class EventBus {
	readonly emitted: Array<{ event: string; payload: unknown }> = [];
	on(): () => void { return () => undefined; }
	emit(event: string, payload: unknown): void { this.emitted.push({ event, payload }); }
}

function fakePi(events: EventBus): ExtensionAPI {
	return { events } as unknown as ExtensionAPI;
}

describe("todo sidebar provider", () => {
	it("publishes a bounded private-ID-free snapshot", () => {
		let state = emptyTodoState();
		for (let id = 1; id <= 20; id += 1) {
			state = applyTodoMutation(state, { version: 1, op: "add", id, text: `item ${id}` });
		}
		state = applyTodoMutation(state, { version: 1, op: "activate", id: 1 });
		const snapshot = createTodoSnapshot(state, "provider", 7, "session");
		assert.equal(snapshot.items.length, MAX_SNAPSHOT_ITEMS);
		assert.equal(snapshot.items[0]?.status, "active");
		assert.equal(snapshot.itemsOmitted, 4);
		assert.deepEqual(
			{ queued: snapshot.queued, active: snapshot.active, total: snapshot.total },
			{ queued: 19, active: 1, total: 20 },
		);
		assert.equal("id" in (snapshot.items[0] as object), false);
		assert.doesNotMatch(JSON.stringify(snapshot), /sessionFile|entry|message|error/);
	});

	it("emits ready and monotonic snapshots, replaying only exact-session requests", () => {
		const events = new EventBus();
		const publisher = new TodoSnapshotPublisher(fakePi(events), "provider-instance");
		publisher.bind("session-1", emptyTodoState());
		assert.equal(events.emitted[0]?.event, TODO_READY_EVENT);
		assert.equal(events.emitted[1]?.event, TODO_SNAPSHOT_EVENT);
		assert.equal((events.emitted[1]?.payload as { sequence: number }).sequence, 1);

		publisher.request({ version: 1, sessionId: "foreign" });
		assert.equal(events.emitted.length, 2);
		publisher.request({ version: 1, sessionId: "session-1" });
		assert.equal(events.emitted.length, 3);
		assert.equal((events.emitted[2]?.payload as { sequence: number }).sequence, 2);
		assert.doesNotThrow(() => publisher.request(new Proxy({}, { get() { throw new Error("hostile"); } })));
	});

	it("isolates throwing optional event consumers", () => {
		const events = new EventBus();
		events.emit = () => { throw new Error("consumer failed"); };
		const publisher = new TodoSnapshotPublisher(fakePi(events), "provider-instance");
		assert.doesNotThrow(() => publisher.bind("session", emptyTodoState()));
	});

	it("unsubscribes request replay on session shutdown", async () => {
		const harness = new ExtensionHarness();
		installPiTodo(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" });
		const snapshots = () => harness.events.emitted.filter((entry) => entry.event === TODO_SNAPSHOT_EVENT).length;
		const beforeShutdown = snapshots();
		await harness.emitLifecycle("session_shutdown", { reason: "quit" });
		harness.events.emit(TODO_REQUEST_EVENT, { version: 1, sessionId: harness.sessionId });
		assert.equal(snapshots(), beforeShutdown);
	});
});
