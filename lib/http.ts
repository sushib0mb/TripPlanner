import fs from "fs";
import path from "path";
import crypto from "crypto";

// public apis ask apps to identify themselves
export const USER_AGENT = "trip-planner-prototype/0.1 (CS598 class project, non-commercial)";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const lastCall: Record<string, number> = {};
const queues: Record<string, Promise<unknown>> = {};

function cacheFile(key: string) {
    return path.join(CACHE_DIR, crypto.createHash("sha1").update(key).digest("hex") + ".json");
}

function readCache(key: string): unknown | undefined {
    const file = cacheFile(key);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeCache(key: string, value: unknown) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify(value));
}

// one request at a time per host, spaced by gapMs
function throttled<T>(host: string, gapMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = queues[host] ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
        const wait = (lastCall[host] ?? 0) + gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall[host] = Date.now();
        return fn();
    });
    queues[host] = next;
    return next;
}

export async function cachedJson<T>(
    url: string,
    opts: { method?: "GET" | "POST"; body?: string; gapMs?: number; timeoutMs?: number } = {},
): Promise<T> {
    const key = (opts.method ?? "GET") + " " + url + " " + (opts.body ?? "");
    const hit = readCache(key);
    if (hit !== undefined) return hit as T;
    const host = new URL(url).host;
    const data = await throttled(host, opts.gapMs ?? 1100, async () => {
        const res = await fetch(url, {
            method: opts.method ?? "GET",
            body: opts.body,
            headers: {
                "User-Agent": USER_AGENT,
                ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
        });
        if (!res.ok) throw new Error(`${host} returned ${res.status}`);
        return (await res.json()) as T;
    });
    writeCache(key, data);
    return data;
}
