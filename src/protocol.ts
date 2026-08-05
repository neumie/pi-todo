import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { orderedTodos, type TodoState } from "./state.ts";

export const TODO_PROTOCOL_VERSION = 1 as const;
export const TODO_READY_EVENT = "@neumie/pi-todo:v1:ready";
export const TODO_REQUEST_EVENT = "@neumie/pi-todo:v1:request";
export const TODO_SNAPSHOT_EVENT = "@neumie/pi-todo:v1:snapshot";
export const MAX_SNAPSHOT_ITEMS = 16;

export interface TodoReadyV1 {
	version: 1;
	providerId: string;
	sessionId: string;
}

export interface TodoRequestV1 {
	version: 1;
	sessionId: string;
}

export interface TodoDisplayItemV1 {
	status: "queued" | "active";
	text: string;
}

export interface TodoSnapshotV1 {
	version: 1;
	providerId: string;
	sequence: number;
	sessionId: string;
	queued: number;
	active: number;
	total: number;
	items: TodoDisplayItemV1[];
	itemsOmitted: number;
}

export function createTodoSnapshot(
	state: TodoState,
	providerId: string,
	sequence: number,
	sessionId: string,
): TodoSnapshotV1 {
	const ordered = orderedTodos(state);
	const items = ordered.slice(0, MAX_SNAPSHOT_ITEMS).map(({ status, text }) => ({ status, text }));
	const active = state.items.some((item) => item.status === "active") ? 1 : 0;
	const queued = state.items.length - active;
	return {
		version: TODO_PROTOCOL_VERSION,
		providerId,
		sequence,
		sessionId,
		queued,
		active,
		total: state.items.length,
		items,
		itemsOmitted: state.items.length - items.length,
	};
}

export class TodoSnapshotPublisher {
	readonly providerId: string;
	private sequence = 0;
	private sessionId: string | undefined;
	private state: TodoState | undefined;

	private emit(event: string, payload: unknown): void {
		try {
			this.pi.events.emit(event, payload);
		} catch {
			// The optional sidebar consumer cannot affect queue persistence or dispatch.
		}
	}

	constructor(
		private readonly pi: ExtensionAPI,
		providerId: string = randomUUID(),
	) {
		this.providerId = providerId;
	}

	bind(sessionId: string, state: TodoState): void {
		this.sessionId = sessionId;
		this.state = state;
		this.ready();
		this.publish();
	}

	update(state: TodoState): void {
		this.state = state;
		this.publish();
	}

	ready(): void {
		if (!this.sessionId) return;
		const payload: TodoReadyV1 = {
			version: TODO_PROTOCOL_VERSION,
			providerId: this.providerId,
			sessionId: this.sessionId,
		};
		this.emit(TODO_READY_EVENT, payload);
	}

	request(value: unknown): void {
		try {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const request = value as Record<string, unknown>;
			if (request.version !== TODO_PROTOCOL_VERSION || request.sessionId !== this.sessionId) return;
			this.publish();
		} catch {
			// A malformed optional consumer request cannot affect todo state.
		}
	}

	publish(): void {
		if (!this.sessionId || !this.state) return;
		this.sequence += 1;
		this.emit(
			TODO_SNAPSHOT_EVENT,
			createTodoSnapshot(this.state, this.providerId, this.sequence, this.sessionId),
		);
	}
}
