import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let http: typeof import("@/lib/http");
const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-cache-"));
    vi.stubEnv("CACHE_DIR", dir);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    // a fresh module per test, so each starts with an empty memory cache and the new CACHE_DIR
    vi.resetModules();
    http = await import("@/lib/http");
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("cachedJson", () => {
    it("answers repeats from the cache and keeps it on disk", async () => {
        fetchMock.mockImplementation(async () => json({ n: 1 }));
        expect(await http.cachedJson("https://api.test/a", { gapMs: 0 })).toEqual({ n: 1 });
        expect(await http.cachedJson("https://api.test/a", { gapMs: 0 })).toEqual({ n: 1 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    });

    it("shares one request between identical calls made at the same time", async () => {
        fetchMock.mockImplementation(async () => json({ n: 2 }));
        const [a, b] = await Promise.all([http.cachedJson("https://api.test/b", { gapMs: 0 }), http.cachedJson("https://api.test/b", { gapMs: 0 })]);
        expect(a).toEqual(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fetches again once an entry is older than its time to live", async () => {
        fetchMock.mockResolvedValueOnce(json({ v: "old" })).mockResolvedValueOnce(json({ v: "new" }));
        expect(await http.cachedJson("https://api.test/c", { gapMs: 0, ttlMs: 1000 })).toEqual({ v: "old" });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 5000);
        expect(await http.cachedJson("https://api.test/c", { gapMs: 0, ttlMs: 1000 })).toEqual({ v: "new" });
    });

    it("falls back to an expired answer when the api is down", async () => {
        fetchMock.mockResolvedValueOnce(json({ v: "kept" })).mockResolvedValueOnce(json({}, 503));
        await http.cachedJson("https://api.test/d", { gapMs: 0, ttlMs: 1000 });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 5000);
        expect(await http.cachedJson("https://api.test/d", { gapMs: 0, ttlMs: 1000 })).toEqual({ v: "kept" });
    });

    it("treats a corrupt cache file as a miss", async () => {
        fetchMock.mockImplementation(async () => json({ v: 1 }));
        await http.cachedJson("https://api.test/e", { gapMs: 0 });
        const file = fs.readdirSync(dir).find((f) => f.endsWith(".json"))!;
        fs.writeFileSync(path.join(dir, file), "{ not json");
        vi.resetModules();
        http = await import("@/lib/http");
        expect(await http.cachedJson("https://api.test/e", { gapMs: 0 })).toEqual({ v: 1 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports an http error with its status", async () => {
        fetchMock.mockImplementation(async () => json({}, 429));
        await expect(http.cachedJson("https://api.test/f", { gapMs: 0 })).rejects.toMatchObject({ status: 429 });
    });

    it("keeps working from memory when the disk cannot be written", async () => {
        const blocked = path.join(dir, "file-not-dir");
        fs.writeFileSync(blocked, "");
        vi.stubEnv("CACHE_DIR", path.join(blocked, "cache"));
        vi.resetModules();
        http = await import("@/lib/http");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        fetchMock.mockImplementation(async () => json({ v: 3 }));
        expect(await http.cachedJson("https://api.test/g", { gapMs: 0 })).toEqual({ v: 3 });
        expect(await http.cachedJson("https://api.test/g", { gapMs: 0 })).toEqual({ v: 3 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledOnce();
    });
});
