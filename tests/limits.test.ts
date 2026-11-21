import { describe, expect, it } from "vitest";
import { clientKey, createLimiter } from "@/lib/limits";

describe("createLimiter", () => {
    it("allows a set number of starts per rolling hour for each visitor", () => {
        let now = 0;
        const limit = createLimiter(2, 10, () => now);
        const a = limit.acquire("a");
        const b = limit.acquire("a");
        expect(a.ok && b.ok).toBe(true);
        if (a.ok) a.release();
        if (b.ok) b.release();
        const c = limit.acquire("a");
        expect(c.ok).toBe(false);
        if (!c.ok) expect(c.retryAfterS).toBeGreaterThan(0);
        // someone else is not affected
        expect(limit.acquire("b").ok).toBe(true);
        now += 3600001;
        expect(limit.acquire("a").ok).toBe(true);
    });

    it("caps how many run at once, and a release frees the slot only once", () => {
        const limit = createLimiter(100, 1);
        const first = limit.acquire("a");
        expect(limit.acquire("b").ok).toBe(false);
        if (first.ok) {
            first.release();
            first.release();
        }
        const second = limit.acquire("b");
        expect(second.ok).toBe(true);
        expect(limit.acquire("c").ok).toBe(false);
    });
});

describe("clientKey", () => {
    it("uses the first forwarded address", () => {
        expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
        expect(clientKey(new Request("http://x"))).toBe("local");
    });
});
