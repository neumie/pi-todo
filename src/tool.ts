import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	MAX_TOOL_LIST_ITEMS,
	type TodoRuntime,
	todoRuntimeErrorMessage,
} from "./runtime.ts";
import { MAX_TODO_ID } from "./state.ts";

const TodoToolParams = Type.Object(
	{
		action: StringEnum(["add", "list", "complete"] as const),
		text: Type.Optional(
			Type.String({
				description:
					"One small related todo to queue (256 sanitized characters maximum)",
				maxLength: 4_096,
			}),
		),
		id: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TODO_ID })),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_TOOL_LIST_ITEMS }),
		),
	},
	{ additionalProperties: false },
);

interface TodoToolDetails {
	version: 1;
	action: "add" | "list" | "complete";
	ok: boolean;
	queued: number;
	active: number;
	total: number;
	omitted: number;
	id?: number;
	error?: string;
}

function details(
	runtime: TodoRuntime,
	action: TodoToolDetails["action"],
	ok: boolean,
	options: Pick<TodoToolDetails, "id" | "error"> & { limit?: number } = {},
): TodoToolDetails {
	const list = runtime.list(options.limit ?? MAX_TOOL_LIST_ITEMS);
	return {
		version: 1,
		action,
		ok,
		queued: list.queued,
		active: list.active,
		total: list.total,
		omitted: list.omitted,
		...(options.id !== undefined ? { id: options.id } : {}),
		...(options.error !== undefined ? { error: options.error } : {}),
	};
}

export function registerTodoTool(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.registerTool({
		name: "pi_todo",
		label: "Pi Todo",
		description:
			"Add one bounded small related follow-up, list actionable todos, or complete the current active todo after actually finishing it.",
		promptSnippet: "Queue or complete small related follow-up work",
		promptGuidelines: [
			"Use pi_todo add only for a clearly additive small related request during ongoing work; keep pursuing the current objective, avoid speculative backlog creation, and act immediately on genuine corrections, stops, or priority changes.",
			"After actually finishing a pi-todo follow-up, use pi_todo complete with its active ID; if blocked, leave it active and explain why.",
		],
		parameters: TodoToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const list = runtime.list(params.limit ?? MAX_TOOL_LIST_ITEMS);
				const lines = list.items.map(
					(item) => `[${item.status}] #${item.id}: ${item.text}`,
				);
				if (list.omitted > 0) lines.push(`... ${list.omitted} more`);
				return {
					content: [
						{
							type: "text" as const,
							text:
								lines.length > 0
									? `${list.active} active · ${list.queued} queued\n${lines.join("\n")}`
									: "No actionable todos.",
						},
					],
					details: details(runtime, "list", true, { limit: params.limit }),
				};
			}

			if (params.action === "add") {
				if (params.text === undefined) {
					const error = "Text is required for pi_todo add.";
					return {
						content: [{ type: "text" as const, text: error }],
						details: details(runtime, "add", false, { error }),
					};
				}
				const result = runtime.add(params.text, ctx);
				if (!result.ok) {
					const error = todoRuntimeErrorMessage(result.error);
					return {
						content: [{ type: "text" as const, text: error }],
						details: details(runtime, "add", false, { error }),
					};
				}
				runtime.scheduleDispatch(ctx);
				return {
					content: [
						{ type: "text" as const, text: `Queued todo #${result.value.id}.` },
					],
					details: details(runtime, "add", true, { id: result.value.id }),
				};
			}

			if (params.id === undefined) {
				const error = "ID is required for pi_todo complete.";
				return {
					content: [{ type: "text" as const, text: error }],
					details: details(runtime, "complete", false, { error }),
				};
			}
			const result = runtime.completeActive(params.id, ctx);
			if (!result.ok) {
				const error = todoRuntimeErrorMessage(result.error);
				return {
					content: [{ type: "text" as const, text: error }],
					details: details(runtime, "complete", false, {
						id: params.id,
						error,
					}),
				};
			}
			runtime.scheduleDispatch(ctx);
			return {
				content: [
					{
						type: "text" as const,
						text: `Completed active todo #${params.id}.`,
					},
				],
				details: details(runtime, "complete", true, { id: params.id }),
			};
		},
	});
}
