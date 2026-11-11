import { writeFile } from "fs/promises";
import { homedir } from "os";
import { normalize } from "path";

const homeDir = homedir();
const LOG_PATH = normalize(`${homeDir}/pi/agent/tool-permission-bash.jsonl`);

/**
 * Append a JSON line entry to the bash permission log. Failures are silently
 * ignored — logging must never affect the permission decision.
 */
export async function appendLog(entry: Record<string, unknown>) {
    try {
        const line = JSON.stringify(entry);
        await writeFile(LOG_PATH, line + "\n", { flag: "a" });
    }
    catch { /* silently ignore log failures */ }
}
