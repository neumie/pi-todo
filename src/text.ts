export const MAX_TODO_TEXT_CHARS = 256;
const MAX_RAW_TEXT_UNITS = 4_096;
const ESC = "\x1b";
const BEL = "\x07";
const C1_ST = "\x9c";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "_", "^", "X"]);
const C1_STRING_CONTROL_CODES = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

export type TodoTextResult =
	| { ok: true; text: string }
	| { ok: false; reason: "empty" | "too-long" | "invalid" };

function skipStringControl(input: string, start: number): number {
	for (let index = start; index < input.length; index += 1) {
		if (input[index] === BEL || input[index] === C1_ST) return index + 1;
		if (input[index] === ESC && input[index + 1] === "\\") return index + 2;
	}
	return input.length;
}

function skipCsi(input: string, start: number): number {
	for (let index = start; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return input.length;
}

function isBidiControl(code: number): boolean {
	return (
		code === 0x061c ||
		code === 0x200e ||
		code === 0x200f ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}

function stripHostileControls(input: string): string {
	let output = "";
	for (let index = 0; index < input.length; ) {
		const character = input[index];
		const code = input.charCodeAt(index);
		if (character === ESC) {
			const next = input[index + 1];
			if (next === "[") {
				index = skipCsi(input, index + 2);
				continue;
			}
			if (next && STRING_CONTROL_INTRODUCERS.has(next)) {
				index = skipStringControl(input, index + 2);
				continue;
			}
			index += next === undefined ? 1 : 2;
			continue;
		}
		if (code === 0x9b) {
			index = skipCsi(input, index + 1);
			continue;
		}
		if (C1_STRING_CONTROL_CODES.has(code)) {
			index = skipStringControl(input, index + 1);
			continue;
		}
		if (character === "\r" || character === "\n" || character === "\t") {
			output += " ";
			index += 1;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isBidiControl(code)) {
			index += 1;
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

export function normalizeTodoText(value: unknown): TodoTextResult {
	if (typeof value !== "string") return { ok: false, reason: "invalid" };
	if (value.length > MAX_RAW_TEXT_UNITS)
		return { ok: false, reason: "too-long" };
	const text = stripHostileControls(value).replace(/\s+/gu, " ").trim();
	if (!text) return { ok: false, reason: "empty" };
	if (Array.from(text).length > MAX_TODO_TEXT_CHARS) {
		return { ok: false, reason: "too-long" };
	}
	return { ok: true, text };
}

export function isCanonicalTodoText(value: unknown): value is string {
	const normalized = normalizeTodoText(value);
	return normalized.ok && normalized.text === value;
}
