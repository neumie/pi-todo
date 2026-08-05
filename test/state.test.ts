import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_LIVE_TODOS,
	TODO_ENTRY_TYPE,
	applyTodoMutation,
	emptyTodoState,
	parseTodoMutation,
	reconstructTodoState,
	type TodoMutation,
} from "../src/state.ts";
import {
	MAX_TODO_TEXT_CHARS,
	isCanonicalTodoText,
	normalizeTodoText,
} from "../src/text.ts";

function entry(data: unknown, customType = TODO_ENTRY_TYPE): unknown {
	return { type: "custom", customType, data };
}

function add(id: number, text = `todo ${id}`): TodoMutation {
	return { version: 1, op: "add", id, text };
}

describe("todo text", () => {
	it("sanitizes terminal controls while preserving one intent", () => {
		assert.deepEqual(
			normalizeTodoText("  add tests\nthen docs\x1b[2J\x1b]0;hostile\x07  "),
			{ ok: true, text: "add tests then docs" },
		);
		assert.deepEqual(normalizeTodoText("\u202E safe"), { ok: true, text: "safe" });
		assert.deepEqual(normalizeTodoText("\0\n"), { ok: false, reason: "empty" });
		assert.equal(isCanonicalTodoText("one bounded item"), true);
		assert.equal(isCanonicalTodoText(" one bounded item "), false);
	});

	it("rejects text over the documented character limit", () => {
		assert.deepEqual(
			normalizeTodoText("x".repeat(MAX_TODO_TEXT_CHARS + 1)),
			{ ok: false, reason: "too-long" },
		);
		assert.equal(normalizeTodoText("😀".repeat(MAX_TODO_TEXT_CHARS)).ok, true);
	});
});

describe("todo state deltas", () => {
	it("applies legal transitions and enforces one active item", () => {
		let state = emptyTodoState();
		state = applyTodoMutation(state, add(1));
		state = applyTodoMutation(state, add(2));
		state = applyTodoMutation(state, { version: 1, op: "activate", id: 1 });
		const unchanged = applyTodoMutation(state, { version: 1, op: "activate", id: 2 });
		assert.equal(unchanged, state);
		assert.deepEqual(state.items.map(({ id, status }) => ({ id, status })), [
			{ id: 1, status: "active" },
			{ id: 2, status: "queued" },
		]);
		state = applyTodoMutation(state, { version: 1, op: "requeue", id: 1 });
		state = applyTodoMutation(state, { version: 1, op: "activate", id: 2 });
		state = applyTodoMutation(state, { version: 1, op: "complete", id: 2 });
		assert.deepEqual(state.items, [{ id: 1, text: "todo 1", status: "queued" }]);
	});

	it("strictly rejects malformed, old, foreign, oversized, and hostile entries", () => {
		const hostile = new Proxy({}, { get() { throw new Error("hostile"); } });
		assert.doesNotThrow(() => parseTodoMutation(hostile));
		assert.equal(parseTodoMutation(hostile), undefined);
		assert.equal(parseTodoMutation({ version: 2, op: "add", id: 1, text: "x" }), undefined);
		assert.equal(parseTodoMutation({ version: 1, op: "add", id: 1, text: "x", extra: true }), undefined);
		assert.equal(parseTodoMutation({ version: 1, op: "add", id: 0, text: "x" }), undefined);
		assert.equal(parseTodoMutation({ version: 1, op: "add", id: 1, text: "x\n" }), undefined);
		assert.equal(
			parseTodoMutation({ version: 1, op: "add", id: 1, text: "x".repeat(MAX_TODO_TEXT_CHARS + 1) }),
			undefined,
		);
		const state = reconstructTodoState([
			entry(add(1, "valid")),
			entry(add(2, "foreign"), "some-other-extension"),
			{ type: "message", message: { role: "user", content: "not state" } },
			entry({ version: 1, op: "activate", id: 99 }),
		]);
		assert.deepEqual(state.items, [{ id: 1, text: "valid", status: "queued" }]);
	});

	it("bounds live reconstruction while keeping IDs monotonic", () => {
		const entries = Array.from({ length: MAX_LIVE_TODOS + 2 }, (_, index) =>
			entry(add(index + 1))
		);
		const state = reconstructTodoState(entries);
		assert.equal(state.items.length, MAX_LIVE_TODOS);
		assert.equal(state.nextId, MAX_LIVE_TODOS + 3);
	});

	it("uses the active branch for membership and all entries for the ID high-water mark", () => {
		const first = entry(add(1, "shared"));
		const abandoned = entry(add(8, "abandoned branch"));
		const current = entry(add(2, "current branch"));
		const state = reconstructTodoState([first, current], [first, abandoned, current]);
		assert.deepEqual(state.items.map((item) => item.id), [1, 2]);
		assert.equal(state.nextId, 9);
	});
});
