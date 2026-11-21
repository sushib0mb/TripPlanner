import crypto from "crypto";
import fs from "fs";
import path from "path";

// public apis ask apps to identify themselves
export const USER_AGENT = "trip-planner-prototype/0.1 (CS598 class project, non-commercial)";

const DAY_MS = 86400000;
export const TTL = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS };

// ---- cache store ------------------------------------------------------------------------------------------
// responses are kept on disk (CACHE_DIR, default .cache) so repeated plans are fast and the public apis are
// spared. where the disk is read-only, as on serverless hosts, the store falls back to a bounded in-memory map
// for the life of the process instead of failing every request

interface Entry {
    at: number;
    data: unknown;
}

interface CacheStore {
    get(key: string): Entry | undefined;
    set(key: string, entry: Entry): void;
}

const MEMORY_LIMIT = 2000;

class MemoryStore implements CacheStore {
    private map = new Map<string, Entry>();
    get(key: string) {
        const hit = this.map.get(key);
        if (hit) {
            // refresh its place so the least recently used entry is evicted first
            this.map.delete(key);
            this.map.set(key, hit);
        }
        return hit;
    }
    set(key: string, entry: Entry) {
        this.map.delete(key);
        this.map.set(key, entry);
        while (this.map.size > MEMORY_LIMIT) this.map.delete(this.map.keys().next().value!);
    }
}

class FileStore implements CacheStore {
    constructor(private dir: string) {}
    private file(key: string) {
        return path.join(this.dir, crypto.createHash("sha1").update(key).digest("hex") + ".json");
    }
    get(key: string): Entry | undefined {
        const file = this.file(key);
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return undefined;
        }
        try {
            const parsed = JSON.parse(text) as { v?: unknown; at?: unknown; data?: unknown } | null;
            if (parsed && typeof parsed === "object" && parsed.v === 1 && typeof parsed.at === "number") return { at: parsed.at, data: parsed.data };
            // files from before entries carried a time: use the file's age
            return { at: fs.statSync(file).mtimeMs, data: parsed };
        } catch {
            // a torn or corrupt file is a miss; it is overwritten on the next successful fetch
            return undefined;
        }
    }
    set(key: string, entry: Entry) {
        fs.mkdirSync(this.dir, { recursive: true });
        const file = this.file(key);
        // write then rename, so a reader never sees half a file
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: entry.at, data: entry.data }));
        fs.renameSync(tmp, file);
    }
}

const memory = new MemoryStore();
let disk: FileStore | null = new FileStore(process.env.CACHE_DIR || path.join(process.cwd(), ".cache"));

function readEntry(key: string): Entry | undefined {
    return memory.get(key) ?? disk?.get(key);
}

function writeEntry(key: string, entry: Entry) {
    memory.set(key, entry);
    if (!disk) return;
    try {
        disk.set(key, entry);
    } catch (e) {
        console.warn(`response cache is memory-only from now on, the disk cache failed: ${e instanceof Error ? e.message : e}`);
        disk = null;
    }
}

// ---- requests ---------------------------------------------------------------------------------------------

const lastCall: Record<string, number> = {};
const queues: Record<string, Promise<unknown>> = {};
// identical requests already on their way, so two plans asking at once share one call
const inFlight = new Map<string, Promise<unknown>>();

// one request at a time per host, spaced by gapMs, as the public apis' usage policies ask
function throttled<T>(host: string, gapMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = queues[host] ?? Promise.resolve();
    const next = prev
        .catch(() => undefined)
        .then(async () => {
            const wait = (lastCall[host] ?? 0) + gapMs - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            lastCall[host] = Date.now();
            return fn();
        });
    queues[host] = next;
    return next;
}

export interface FetchOptions {
    method?: "GET" | "POST";
    body?: string;
    gapMs?: number;
    timeoutMs?: number;
    // how long a cached response stays good, a month by default
    ttlMs?: number;
}

export async function cachedJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    const key = (opts.method ?? "GET") + " " + url + " " + (opts.body ?? "");
    const hit = readEntry(key);
    if (hit && Date.now() - hit.at < (opts.ttlMs ?? TTL.month)) return hit.data as T;
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const host = new URL(url).host;
    const request = throttled(host, opts.gapMs ?? 1100, async () => {
        const res = await fetch(url, {
            method: opts.method ?? "GET",
            body: opts.body,
            headers: {
                "User-Agent": USER_AGENT,
                ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
        });
        if (!res.ok) throw new HttpError(host, res.status);
        return (await res.json()) as T;
    })
        .then(
            (data) => {
                writeEntry(key, { at: Date.now(), data });
                return data;
            },
            (e: unknown) => {
                // an expired answer beats no answer when the api is down
                if (hit) return hit.data as T;
                throw e;
            },
        )
        .finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
}

export class HttpError extends Error {
    constructor(
        public host: string,
        public status: number,
    ) {
        super(`${host} returned ${status}`);
    }
}
