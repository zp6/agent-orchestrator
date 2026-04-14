import { mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("../src/reviewer/schema-contract.json", import.meta.url);
const targetPath = new URL("../dist/reviewer/schema-contract.json", import.meta.url);

const targetFile = fileURLToPath(targetPath);
mkdirSync(dirname(targetFile), { recursive: true });
copyFileSync(fileURLToPath(source), targetFile);
