import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPiTodo } from "../src/extension.ts";

export default function piTodo(pi: ExtensionAPI): void {
	installPiTodo(pi);
}
