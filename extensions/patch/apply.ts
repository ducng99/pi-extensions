/**
 * Minimal unified-diff applier for a single file.
 */

interface Hunk {
    /** 1-based start line in the original file (as declared by the header). */
    oldStart: number;
    oldLines: string[];
    newLines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): Hunk[] {
    const lines = patch.replace(/\r\n/g, "\n").split("\n");
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;

    for (const line of lines) {
        const header = HUNK_HEADER.exec(line);
        if (header) {
            current = { oldStart: parseInt(header[1]!, 10), oldLines: [], newLines: [] };
            hunks.push(current);
            continue;
        }
        // Ignore file headers / preamble before the first hunk.
        if (!current) continue;

        if (line.startsWith("\\")) continue; // "\ No newline at end of file"
        const marker = line[0];
        const text = line.slice(1);
        if (marker === " ") {
            current.oldLines.push(text);
            current.newLines.push(text);
        }
        else if (marker === "-") {
            current.oldLines.push(text);
        }
        else if (marker === "+") {
            current.newLines.push(text);
        }
        else if (line === "") {
            // Blank line: treat as empty context (editors often strip the space).
            current.oldLines.push("");
            current.newLines.push("");
        }
    }

    // Trailing empty context line produced by the final newline of the patch.
    const last = hunks[hunks.length - 1];
    if (last && patch.endsWith("\n")) {
        const lastLine = patch.replace(/\r\n/g, "\n").split("\n").slice(-2, -1)[0];
        if (lastLine !== "" && last.oldLines.at(-1) === "" && last.newLines.at(-1) === "") {
            last.oldLines.pop();
            last.newLines.pop();
        }
    }

    if (hunks.length === 0) throw new Error("Patch contains no hunks (expected '@@ -a,b +c,d @@' headers)");
    return hunks;
}

function matchesAt(file: string[], at: number, needle: string[], loose: boolean): boolean {
    if (at < 0 || at + needle.length > file.length) return false;
    for (let i = 0; i < needle.length; i++) {
        const a = file[at + i]!;
        const b = needle[i]!;
        if (loose ? a.trimEnd() !== b.trimEnd() : a !== b) return false;
    }
    return true;
}

/** Find the match closest to `expected`. */
function findHunk(file: string[], needle: string[], expected: number, minPos: number): number {
    for (const loose of [false, true]) {
        for (let d = 0; d <= file.length; d++) {
            for (const at of d === 0 ? [expected] : [expected - d, expected + d]) {
                if (at >= minPos && matchesAt(file, at, needle, loose)) return at;
            }
        }
    }
    return -1;
}

export function applyPatch(original: string, patch: string): string {
    const crlf = original.includes("\r\n");
    const text = original.replace(/\r\n/g, "\n");
    const hunks = parsePatch(patch);

    const endsWithNewline = text.endsWith("\n");
    const file = text === "" ? [] : (endsWithNewline ? text.slice(0, -1) : text).split("\n");

    let delta = 0;
    let minPos = 0;
    for (const [i, hunk] of hunks.entries()) {
        const expected = Math.max(0, hunk.oldStart - 1 + delta);
        // A pure insertion (no old lines) is placed at the declared position;
        // a hunk with oldLines === [] and oldStart 0 means "start of file".
        let at: number;
        if (hunk.oldLines.length === 0) {
            at = hunk.oldStart === 0 ? 0 : Math.min(hunk.oldStart + delta, file.length);
        }
        else {
            at = findHunk(file, hunk.oldLines, expected, minPos);
            if (at === -1) {
                throw new Error(`Hunk #${i + 1} failed: context/removed lines not found in file (near line ${hunk.oldStart})`);
            }
        }
        file.splice(at, hunk.oldLines.length, ...hunk.newLines);
        delta += hunk.newLines.length - hunk.oldLines.length;
        minPos = at + hunk.newLines.length;
    }

    let result = file.join("\n");
    if (file.length > 0 && (endsWithNewline || text === "")) result += "\n";
    return crlf ? result.replace(/\n/g, "\r\n") : result;
}
