/**
 * File-backed web content cache for associated web tools.
 *
 * Ollama's web search returns the *full* markdown content of each result page.
 * websearch stores that content in this cache; when webfetch is later called
 * with the same URL, it reads the cached markdown and skips both the network
 * `fetch` and the HTML→markdown conversion.
 *
 * The cache is stored on disk (under the OS temp dir) rather than as an
 * in-memory singleton because pi loads each extension entry point via jiti
 * with `moduleCache: false` — separately-loaded extensions get their own
 * module instances, so a module-level object is never shared between them.
 * Every `WebContentCache` instance points at the same file, so all extensions
 * see the same entries. Writes are atomic (temp file + rename) and serialized
 * through a per-instance queue.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;
const CACHE_FILE_VERSION = 1;

interface CacheEntry {
    url: string;
    markdown: string;
    cachedAt: number;
}

interface CacheFile {
    version: number;
    entries: CacheEntry[];
}

export interface WebContentCacheOptions {
    /** Path of the cache file. Defaults to `$TMPDIR/pi/web-content-cache/cache.json`. */
    filePath?: string;
    /** Entry lifetime in milliseconds. Defaults to 15 minutes. */
    ttlMs?: number;
    /** Maximum number of entries before the oldest are evicted. Defaults to 200. */
    maxEntries?: number;
}

/** Default cache file location, shared by all extensions on the same host. */
export function getDefaultWebContentCachePath(): string {
    return join(tmpdir(), "pi", "web-content-cache", "cache.json");
}

export class WebContentCache {
    private readonly filePath: string;
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    /** Serializes file reads/writes so concurrent calls see consistent data. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(options: WebContentCacheOptions = {}) {
        this.filePath = options.filePath ?? getDefaultWebContentCachePath();
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    }

    /**
     * Retrieve the cached markdown for `url` if present and not expired.
     */
    get(url: string): Promise<string | undefined> {
        return this.enqueue(async () => {
            const key = normalizeUrl(url);
            if (!key) return undefined;

            const entries = await this.readEntries();
            const entry = entries.find(e => e.url === key);
            if (!entry) return undefined;
            if (Date.now() - entry.cachedAt > this.ttlMs) return undefined;
            return entry.markdown;
        });
    }

    /**
     * Store the markdown content for a URL, replacing any existing entry.
     *
     * @returns the key under which the entry was stored, or `undefined` if the
     * URL could not be parsed/normalized.
     */
    set(url: string, markdown: string): Promise<string | undefined> {
        return this.enqueue(async () => {
            const key = normalizeUrl(url);
            if (!key || !markdown) return undefined;

            const now = Date.now();
            const entries = await this.readEntries();
            const fresh = entries.filter(
                e => e.url !== key && now - e.cachedAt <= this.ttlMs,
            );
            fresh.push({ url: key, markdown, cachedAt: now });

            // Entries are kept in insertion order, so the oldest are first.
            while (fresh.length > this.maxEntries) fresh.shift();

            await this.writeEntries(fresh);
            return key;
        });
    }

    /** Remove all entries (including the cache file itself). */
    async clear(): Promise<void> {
        await this.enqueue(async () => {
            await this.writeEntries([]);
        });
    }

    /** Number of currently stored (non-expired) entries. */
    size(): Promise<number> {
        return this.enqueue(async () => {
            const entries = await this.readEntries();
            const now = Date.now();
            return entries.filter(e => now - e.cachedAt <= this.ttlMs).length;
        });
    }

    private async readEntries(): Promise<CacheEntry[]> {
        try {
            const raw = await readFile(this.filePath, "utf8");
            const file = JSON.parse(raw) as CacheFile;
            if (!file || file.version !== CACHE_FILE_VERSION || !Array.isArray(file.entries)) {
                return [];
            }
            return file.entries;
        }
        catch (err) {
            // Missing file, or corrupt content: treat as an empty cache.
            if (!isMissingFileError(err)) {
                console.error(`web-content-cache: ignoring unreadable cache file ${this.filePath}`);
            }
            return [];
        }
    }

    private async writeEntries(entries: CacheEntry[]): Promise<void> {
        const file: CacheFile = { version: CACHE_FILE_VERSION, entries };
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(file), "utf8");
        await rename(tmpPath, this.filePath);
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = this.queue.then(() => task());
        // Keep the chain alive even if a task rejects.
        this.queue = result.catch(() => undefined);
        return result;
    }
}

function isMissingFileError(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Normalize a URL so that equivalent URLs collapse onto the same cache key:
 * HTTP is upgraded to HTTPS (webfetch upgrades automatically) and the URL
 * fragment is dropped. Returns `undefined` for unparseable URLs.
 */
function normalizeUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:") parsed.protocol = "https:";
        parsed.hash = "";
        return parsed.href;
    }
    catch {
        return undefined;
    }
}
