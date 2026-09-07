import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run check:package");
const reports = JSON.parse(execFileSync(process.execPath, [
	npmCli, "pack", "--dry-run", "--ignore-scripts", "--json",
], { cwd: root, encoding: "utf8", timeout: 30_000 }));
assert.equal(reports.length, 1);
const report = reports[0];
assert.equal(report.name, "@neumie/pi-todo");
const paths = new Set(report.files.map((file) => file.path));
for (const required of ["LICENSE", "README.md", "package.json", "extensions/pi-todo.ts", "src/index.ts", "src/extension.ts"]) {
	assert.ok(paths.has(required), `Missing package file: ${required}`);
}
for (const path of paths) {
	assert.ok(
		["LICENSE", "README.md", "package.json"].includes(path) || /^(src|extensions)\/[\w-]+\.ts$/.test(path),
		`Unexpected package file: ${path}`,
	);
}
console.log(`Package contents verified: ${paths.size} source, license and metadata files.`);
