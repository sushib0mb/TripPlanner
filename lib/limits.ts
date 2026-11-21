// in-memory request limits, per server process. enough to stop one visitor from running up the Claude bill
// or hammering the public map apis; a deployment with several instances should move this to a shared store

const HOUR_MS = 3600000;

function envInt(name: string, fallback: number) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface Limiter {
    // a release function when the request may run, or the reason it may not
    acquire(key: string): { ok: true; release: () => void } | { ok: false; reason: string; retryAfterS: number };
}

// at most `perHour` starts per key in any rolling hour, and at most `concurrent` running at once overall
export function createLimiter(perHour: number, concurrent: number, now = () => Date.now()): Limiter {
    const starts = new Map<string, number[]>();
    let running = 0;
    return {
        acquire(key) {
            const t = now();
            const recent = (starts.get(key) ?? []).filter((s) => t - s < HOUR_MS);
            if (recent.length >= perHour) {
                starts.set(key, recent);
                return { ok: false, reason: `limit of ${perHour} per hour reached`, retryAfterS: Math.ceil((recent[0] + HOUR_MS - t) / 1000) };
            }
            if (running >= concurrent) return { ok: false, reason: "too many plans running right now", retryAfterS: 30 };
            recent.push(t);
            starts.set(key, recent);
            running++;
            let released = false;
            return {
                ok: true,
                release: () => {
                    if (released) return;
                    released = true;
                    running--;
                },
            };
        },
    };
}

// the visitor's address as the proxy reports it, the first hop of x-forwarded-for
export function clientKey(req: Request) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || req.headers.get("x-real-ip") || "local";
}

export function limitedResponse(reason: string, retryAfterS: number) {
    return Response.json({ error: reason }, { status: 429, headers: { "Retry-After": String(retryAfterS) } });
}

// plans call Claude, checks only call the free map apis
export const planLimiter = createLimiter(envInt("PLAN_RUNS_PER_HOUR", 10), envInt("PLAN_MAX_CONCURRENT", 3));
export const checkLimiter = createLimiter(envInt("CHECK_RUNS_PER_HOUR", 120), envInt("CHECK_MAX_CONCURRENT", 6));
