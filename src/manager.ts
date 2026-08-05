import type {
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	Text,
	truncateToWidth,
	type Component,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { type TodoRuntime, todoRuntimeErrorMessage } from "./runtime.ts";
import type { TodoItem } from "./state.ts";

const MAX_MANAGER_ROWS = 16;

type ManagerAction = "dispatch" | "requeue" | "complete" | "delete";

export interface TodoSelectDialogOptions {
	title: string;
	items: SelectItem[];
	theme: Theme;
	terminalRows: number;
	onSelect(value: string): void;
	onCancel(): void;
	onRender?(): void;
}

function normalizedSize(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export class TodoSelectDialog implements Component {
	private readonly container = new Container();
	private readonly selectList: SelectList;
	private readonly maxRows: number;

	constructor(options: TodoSelectDialogOptions) {
		this.maxRows = Math.min(
			MAX_MANAGER_ROWS,
			normalizedSize(options.terminalRows),
		);
		const maxVisible = Math.max(
			1,
			Math.min(options.items.length, this.maxRows - 5),
		);
		this.container.addChild(
			new DynamicBorder((text: string) => options.theme.fg("accent", text)),
		);
		this.container.addChild(
			new Text(
				options.theme.fg("accent", options.theme.bold(options.title)),
				1,
				0,
			),
		);
		this.selectList = new SelectList(options.items, maxVisible, {
			selectedPrefix: (text) => options.theme.fg("accent", text),
			selectedText: (text) => options.theme.fg("accent", text),
			description: (text) => options.theme.fg("muted", text),
			scrollInfo: (text) => options.theme.fg("dim", text),
			noMatch: (text) => options.theme.fg("warning", text),
		});
		this.selectList.onSelect = (item) => options.onSelect(item.value);
		this.selectList.onCancel = options.onCancel;
		this.selectList.onSelectionChange = () => options.onRender?.();
		this.container.addChild(this.selectList);
		this.container.addChild(
			new Text(
				options.theme.fg("dim", "↑↓ navigate · enter select · esc close"),
				1,
				0,
			),
		);
		this.container.addChild(
			new DynamicBorder((text: string) => options.theme.fg("accent", text)),
		);
	}

	render(width: number): string[] {
		const fittedWidth = normalizedSize(width);
		if (fittedWidth === 0 || this.maxRows === 0) return [];
		const lines =
			this.maxRows <= 2
				? this.selectList.render(fittedWidth)
				: this.container.render(fittedWidth);
		return lines
			.slice(0, this.maxRows)
			.map((line) => truncateToWidth(line, fittedWidth, ""));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.container.invalidate();
	}
}

async function select(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) =>
			new TodoSelectDialog({
				title,
				items,
				theme,
				terminalRows: tui.terminal.rows,
				onSelect: done,
				onCancel: () => done(undefined),
				onRender: () => tui.requestRender(),
			}),
	);
}

function todoChoice(item: TodoItem): SelectItem {
	const marker = item.status === "active" ? "◆" : "○";
	return {
		value: String(item.id),
		label: `${marker} #${item.id} ${item.text}`,
		description: item.status,
	};
}

function actionChoices(item: TodoItem): SelectItem[] {
	return item.status === "active"
		? [
				{
					value: "requeue",
					label: "Requeue",
					description: "Move back to the queue without dispatching",
				},
				{
					value: "complete",
					label: "Complete",
					description: "Remove from actionable work",
				},
				{ value: "delete", label: "Delete", description: "Remove this item" },
			]
		: [
				{
					value: "dispatch",
					label: "Dispatch",
					description: "Send at the next safe idle boundary",
				},
				{
					value: "complete",
					label: "Complete",
					description: "Remove from actionable work",
				},
				{ value: "delete", label: "Delete", description: "Remove this item" },
			];
}

function notifyResult(
	ctx: ExtensionCommandContext,
	result: ReturnType<TodoRuntime["requestDispatch"]>,
	success: string,
): boolean {
	if (result.ok) {
		ctx.ui.notify(success, "info");
		return true;
	}
	ctx.ui.notify(todoRuntimeErrorMessage(result.error), "warning");
	return false;
}

export async function showTodoManager(
	runtime: TodoRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const summary = runtime.list(1);
		ctx.ui.notify(
			summary.total === 0
				? "No actionable todos on the active branch."
				: `${summary.active} active · ${summary.queued} queued. Use /todos in interactive mode to manage them.`,
			"info",
		);
		return;
	}

	while (true) {
		const items = runtime.allItems();
		if (items.length === 0) {
			ctx.ui.notify("No actionable todos on the active branch.", "info");
			return;
		}
		const selectedId = await select(ctx, "Pi todos", items.map(todoChoice));
		if (!selectedId) return;
		const id = Number(selectedId);
		const item = runtime.getItem(id);
		if (!item) continue;
		const selectedAction = await select(
			ctx,
			`Todo #${id}`,
			actionChoices(item),
		);
		if (!selectedAction) continue;
		const action = selectedAction as ManagerAction;

		if (action === "dispatch") {
			if (
				notifyResult(
					ctx,
					runtime.requestDispatch(id, ctx),
					`Todo #${id} will dispatch at the next safe boundary.`,
				)
			) {
				runtime.scheduleDispatch(ctx);
				return;
			}
			continue;
		}
		if (action === "requeue") {
			notifyResult(ctx, runtime.requeue(id, ctx), `Requeued todo #${id}.`);
			continue;
		}
		if (action === "complete") {
			const wasActive = item.status === "active";
			if (
				notifyResult(
					ctx,
					runtime.completeAny(id, ctx),
					`Completed todo #${id}.`,
				) &&
				wasActive
			) {
				runtime.scheduleDispatch(ctx);
				return;
			}
			continue;
		}
		const confirmed = await ctx.ui.confirm(
			"Delete todo?",
			`Delete #${id}: ${item.text}`,
		);
		if (!confirmed) continue;
		const wasActive = item.status === "active";
		if (
			notifyResult(ctx, runtime.delete(id, ctx), `Deleted todo #${id}.`) &&
			wasActive
		) {
			runtime.scheduleDispatch(ctx);
			return;
		}
	}
}
