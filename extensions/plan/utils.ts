import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { join } from "path";

export function normalizePlanFilename(filename: string): string {
    const trimmed = filename.trim();
    return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

export function plansDir(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, "plans");
}
