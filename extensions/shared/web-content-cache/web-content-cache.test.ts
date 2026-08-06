import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { WebContentCache } from "./index";

interface CacheFile {
    version: number;
    entries: Array<{ url: string; markdown: string; cachedAt: number }>;
}

describe("WebContentCache", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "pi-web-content-cache-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function makeCache(overrides: { ttlMs?: number; maxEntries?: number } = {}): WebContentCache {
        return new WebContentCache({ filePath: join(dir, "cache.json"), ...overrides });
    }

    test("stores and retrieves content by URL", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/page", "# Hello\n\nworld");
        expect(await cache.get("https://example.com/page")).toBe("# Hello\n\nworld");
        expect(await cache.size()).toBe(1);
    });

    test("returns undefined for missing URLs", async () => {
        const cache = makeCache();
        expect(await cache.get("https://example.com/missing")).toBeUndefined();
    });

    test("overwrites existing entry for the same URL", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/", "old");
        await cache.set("https://example.com/", "new");
        expect(await cache.get("https://example.com/")).toBe("new");
        expect(await cache.size()).toBe(1);
    });

    test("normalizes http to https", async () => {
        const cache = makeCache();
        await cache.set("http://example.com/", "content");
        expect(await cache.get("https://example.com/")).toBe("content");
    });

    test("drops URL fragments", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/page#section", "content");
        expect(await cache.get("https://example.com/page#Other")).toBe("content");
        expect(await cache.get("https://example.com/page")).toBe("content");
    });

    test("treats trailing slash variants as the same URL", async () => {
        const cache = makeCache();
        await cache.set("https://example.com", "content");
        expect(await cache.get("https://example.com/")).toBe("content");
    });

    test("returns undefined for unparseable URLs", async () => {
        const cache = makeCache();
        expect(await cache.set("not a url", "content")).toBeUndefined();
        expect(await cache.get("not a url")).toBeUndefined();
    });

    test("does not cache empty content", async () => {
        const cache = makeCache();
        expect(await cache.set("https://example.com/", "")).toBeUndefined();
        expect(await cache.get("https://example.com/")).toBeUndefined();
    });

    test("expires entries after the TTL", async () => {
        const cache = makeCache({ ttlMs: 50 });
        await cache.set("https://example.com/", "content");
        expect(await cache.get("https://example.com/")).toBe("content");

        await new Promise(resolve => setTimeout(resolve, 100));
        expect(await cache.get("https://example.com/")).toBeUndefined();
        expect(await cache.size()).toBe(0);
    });

    test("evicts the oldest entry when at capacity", async () => {
        const cache = makeCache({ maxEntries: 2 });
        await cache.set("https://a.com", "A");
        await cache.set("https://b.com", "B");
        await cache.set("https://c.com", "C");
        // A is oldest and should be evicted.
        expect(await cache.get("https://a.com")).toBeUndefined();
        expect(await cache.get("https://b.com")).toBe("B");
        expect(await cache.get("https://c.com")).toBe("C");
    });

    test("clear removes all entries", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/", "content");
        await cache.set("https://example.org/", "other");
        await cache.clear();
        expect(await cache.size()).toBe(0);
        expect(await cache.get("https://example.com/")).toBeUndefined();
    });

    test("shares entries across separate instances via the file", async () => {
        const cacheA = makeCache();
        const cacheB = makeCache();
        await cacheA.set("https://example.com/", "shared content");
        expect(await cacheB.get("https://example.com/")).toBe("shared content");
    });

    test("persists entries across cache restarts (new instance after writes)", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/", "persisted");
        const restarted = makeCache();
        expect(await restarted.get("https://example.com/")).toBe("persisted");
    });

    test("survives a corrupt cache file", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/", "content");
        // Corrupt the file on disk.
        await writeFile(join(dir, "cache.json"), "{not json", "utf8");
        // Reads treat it as empty and writes recover cleanly.
        expect(await cache.get("https://example.com/")).toBeUndefined();
        await cache.set("https://example.org/", "other");
        expect(await cache.get("https://example.org/")).toBe("other");
        expect(await cache.size()).toBe(1);
    });

    test("writes an atomic cache file with the expected shape", async () => {
        const cache = makeCache();
        await cache.set("https://example.com/", "content");
        const raw = await readFile(join(dir, "cache.json"), "utf8");
        const file = JSON.parse(raw) as CacheFile;
        expect(file.version).toBe(1);
        expect(file.entries).toHaveLength(1);
        expect(file.entries[0]).toMatchObject({ url: "https://example.com/", markdown: "content" });
        expect(typeof file.entries[0]?.cachedAt).toBe("number");
    });
});
