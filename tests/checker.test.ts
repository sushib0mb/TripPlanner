import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransitResult } from "@/lib/routing";

vi.mock("@/lib/routing", () => ({
    osrmRoute: vi.fn(async () => null),
    transitRoute: vi.fn(),
    walkMatrix: vi.fn(async () => null),
    nearbyStop: vi.fn(async () => null),
}));

const routing = await import("@/lib/routing");
const { evaluatePlan } = await import("@/lib/checker");
const { draft, intake, registry, GARDNER, LIBRARY, MFA, DINER, CAFE } = await import("./fixtures");

const ride = (minutes: number) => async (_a: unknown, _b: unknown, departUtc: number): Promise<TransitResult> => ({
    departUtc,
    arriveUtc: departUtc + minutes * 60000,
    minutes,
    km: 3,
    geometry: [],
    lines: ["bus 1"],
    vehicleLegs: 1,
    segments: [],
});

const codes = (ev: { issues: { code: string; level: string }[] }) => ev.issues.map((i) => `${i.level}:${i.code}`);

beforeEach(() => {
    vi.mocked(routing.transitRoute).mockReset();
    vi.mocked(routing.osrmRoute).mockResolvedValue(null);
});

describe("evaluatePlan", () => {
    it("reports a failed timetable lookup as a warning and estimates the leg, never as an infeasible plan", async () => {
        vi.mocked(routing.transitRoute).mockRejectedValue(new Error("api.transitous.org returned 503"));
        const plan = draft([{ date: "2027-01-15", stops: [{ place_id: MFA.id, duration_min: 120, cost_per_person: 0 }] }]);
        const ev = await evaluatePlan(intake({ nights: 0 }), plan, registry());
        expect(codes(ev)).toContain("warning:lookup_failed");
        expect(codes(ev)).not.toContain("error:no_transit");
        expect(ev.days[0].legs[0].timeSource).toBe("estimate");
        expect(ev.issues.find((i) => i.code === "lookup_failed")?.placeId).toBe(MFA.id);
    });

    it("still makes a long walk an error when transit truly has no route", async () => {
        vi.mocked(routing.transitRoute).mockResolvedValue(null);
        const far = { ...MFA, id: "far", lat: MFA.lat + 0.1 };
        const plan = draft([{ date: "2027-01-15", stops: [{ place_id: far.id, duration_min: 60, cost_per_person: 0 }] }]);
        const ev = await evaluatePlan(intake({ nights: 0 }), plan, registry(far));
        expect(codes(ev)).toContain("error:no_transit");
    });

    it("misses only fixed starts; a not-before hold may be passed", async () => {
        vi.mocked(routing.transitRoute).mockImplementation(ride(60));
        // the day starts 09:00 and the first ride takes an hour, so both stops are reached after their times
        const stop = (start_kind?: "fixed" | "not_before") => ({ place_id: GARDNER.id, start_after: "09:15", start_kind, duration_min: 60, cost_per_person: 0 });
        const fixed = await evaluatePlan(intake({ nights: 0 }), draft([{ date: "2027-01-15", stops: [stop("fixed")] }]), registry());
        const unset = await evaluatePlan(intake({ nights: 0 }), draft([{ date: "2027-01-15", stops: [stop()] }]), registry());
        const hold = await evaluatePlan(intake({ nights: 0 }), draft([{ date: "2027-01-15", stops: [stop("not_before")] }]), registry());
        expect(fixed.issues.find((i) => i.code === "missed_start")?.placeId).toBe(GARDNER.id);
        expect(codes(unset)).toContain("error:missed_start");
        expect(codes(hold)).not.toContain("error:missed_start");
    });

    it("keeps each stop's position in its draft day, even when a meal shares the sight's place", async () => {
        vi.mocked(routing.transitRoute).mockImplementation(ride(20));
        const plan = draft([
            {
                date: "2027-01-15",
                stops: [
                    { place_id: LIBRARY.id, duration_min: 60, cost_per_person: 0 },
                    { place_id: LIBRARY.id, duration_min: 60, cost_per_person: 20, meal: "lunch" },
                    { place_id: DINER.id, start_after: "18:00", start_kind: "not_before", duration_min: 90, cost_per_person: 40, meal: "dinner" },
                ],
            },
        ]);
        const ev = await evaluatePlan(intake({ nights: 0 }), plan, registry());
        expect(ev.days[0].stops.map((s) => s.index)).toEqual([0, 1, 2]);
    });

    it("warns about a lunch far outside lunchtime", async () => {
        vi.mocked(routing.transitRoute).mockImplementation(ride(20));
        const plan = draft([
            {
                date: "2027-01-15",
                stops: [
                    { place_id: MFA.id, duration_min: 300, cost_per_person: 0 },
                    { place_id: CAFE.id, duration_min: 60, cost_per_person: 20, meal: "lunch" },
                ],
            },
        ]);
        const ev = await evaluatePlan(intake({ nights: 0 }), plan, registry());
        expect(codes(ev)).toContain("warning:lunch_time");
    });

    it("stops when the request is cancelled", async () => {
        vi.mocked(routing.transitRoute).mockImplementation(ride(20));
        const abort = new AbortController();
        abort.abort();
        const plan = draft([{ date: "2027-01-15", stops: [{ place_id: MFA.id, duration_min: 60, cost_per_person: 0 }] }]);
        await expect(evaluatePlan(intake({ nights: 0 }), plan, registry(), { signal: abort.signal })).rejects.toThrow();
    });
});
