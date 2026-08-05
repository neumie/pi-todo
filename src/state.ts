import { isCanonicalTodoText } from "./text.ts";

export const TODO_ENTRY_TYPE = "@neumie/pi-todo:v1:mutation";
const TODO_MUTATION_VERSION = 1 as const;
export const MAX_LIVE_TODOS = 64;
export const MAX_TODO_ID = 999_999_999;

export type TodoStatus = "queued" | "active";

export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

export type TodoMutation =
	| { version: 1; op: "add"; id: number; text: string }
	| {
			version: 1;
			op: "activate" | "requeue" | "complete" | "delete";
			id: number;
	  };

function record(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

function validId(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= 1 &&
		(value as number) <= MAX_TODO_ID
	);
}

function hasExactKeys(
	input: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const compare = (left: string, right: string) => left.localeCompare(right);
	const keys = Object.keys(input).sort(compare);
	const expectedKeys = [...expected].sort(compare);
	return (
		keys.length === expectedKeys.length &&
		keys.every((key, index) => key === expectedKeys[index])
	);
}

export function parseTodoMutation(value: unknown): TodoMutation | undefined {
	try {
		const input = record(value);
		if (!input || input.version !== TODO_MUTATION_VERSION || !validId(input.id))
			return undefined;
		if (input.op === "add") {
			if (!hasExactKeys(input, ["id", "op", "text", "version"]))
				return undefined;
			if (!isCanonicalTodoText(input.text)) return undefined;
			return { version: 1, op: "add", id: input.id, text: input.text };
		}
		if (
			input.op !== "activate" &&
			input.op !== "requeue" &&
			input.op !== "complete" &&
			input.op !== "delete"
		)
			return undefined;
		if (!hasExactKeys(input, ["id", "op", "version"])) return undefined;
		return { version: 1, op: input.op, id: input.id };
	} catch {
		return undefined;
	}
}

function mutationFromEntry(value: unknown): TodoMutation | undefined {
	try {
		const entry = record(value);
		if (entry?.type !== "custom" || entry.customType !== TODO_ENTRY_TYPE)
			return undefined;
		return parseTodoMutation(entry.data);
	} catch {
		return undefined;
	}
}

export function emptyTodoState(): TodoState {
	return { items: [], nextId: 1 };
}

export function applyTodoMutation(
	state: TodoState,
	mutation: TodoMutation,
): TodoState {
	if (mutation.op === "add") {
		const nextId = Math.max(state.nextId, mutation.id + 1);
		if (
			state.items.some((item) => item.id === mutation.id) ||
			state.items.length >= MAX_LIVE_TODOS
		) {
			return nextId === state.nextId ? state : { ...state, nextId };
		}
		return {
			items: [
				...state.items,
				{ id: mutation.id, text: mutation.text, status: "queued" },
			],
			nextId,
		};
	}

	const index = state.items.findIndex((item) => item.id === mutation.id);
	if (index < 0) return state;
	const item = state.items[index];
	if (!item) return state;
	if (mutation.op === "activate") {
		if (
			item.status !== "queued" ||
			state.items.some((candidate) => candidate.status === "active")
		) {
			return state;
		}
		const items = [...state.items];
		items[index] = { ...item, status: "active" };
		return { ...state, items };
	}
	if (mutation.op === "requeue") {
		if (item.status !== "active") return state;
		const items = [...state.items];
		items[index] = { ...item, status: "queued" };
		return { ...state, items };
	}
	return {
		...state,
		items: state.items.filter((candidate) => candidate.id !== mutation.id),
	};
}

export function reconstructTodoState(
	branchEntries: readonly unknown[],
	allEntries: readonly unknown[] = branchEntries,
): TodoState {
	let state = emptyTodoState();
	for (const entry of branchEntries) {
		const mutation = mutationFromEntry(entry);
		if (mutation) state = applyTodoMutation(state, mutation);
	}
	let nextId = state.nextId;
	for (const entry of allEntries) {
		const mutation = mutationFromEntry(entry);
		if (mutation?.op === "add") nextId = Math.max(nextId, mutation.id + 1);
	}
	return nextId === state.nextId ? state : { ...state, nextId };
}

export function orderedTodos(state: TodoState): TodoItem[] {
	return [
		...state.items.filter((item) => item.status === "active"),
		...state.items.filter((item) => item.status === "queued"),
	];
}
