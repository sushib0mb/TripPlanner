import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Evaluation } from "@/lib/types";

vi.mock("@/lib/routing", () => ({ walkMatrix: vi.fn(async () => null), osrmRoute: vi.fn(async () => null), transitRoute: vi.fn(async () => null), nearbyStop: vi.fn(async () => null) }));
// the real check is scripted: each call returns the next evaluation
vi.mock("@/lib/checker", () => ({ evaluatePlan: vi.fn() }));

const { evaluatePlan } = await import("@/lib/checker");
const { dropCandidate, feedbackFrom, verify } = await import("@/lib/verify");
const { schedule } = await import("@/lib/scheduler");
const { evaluation, intake, leg, registry, shortlist, GARDNER, HOTEL, LIBRARY, MFA, OLD_STATE } = await import("./fixtures");

const ok = () => evaluation([]);
const failing = (day: string): Evaluation => evaluation([], [{ level: "error", code: "day_too_long", day, message: "back at the hotel at 23:40" }]);

beforeEach(() => vi.mocked(evaluatePlan).mockReset());

describe("verify", () => {
    it("checks once and changes nothing when the plan works", async () => {
        vi.mocked(evaluatePlan).mockResolvedValueOnce(ok());
        const list = shortlist();
        const { draft } = await schedule(intake(), list, registry());
        const v = await verify(intake(), list, draft, registry());
        expect(evaluatePlan).toHaveBeenCalledTimes(1);
        expect(v.adjustments).toEqual([]);
        expect(v.draft).toBe(draft);
    });

    it("re-arranges with the real times when the first check fails, and keeps the better plan", async () => {
        vi.mocked(evaluatePlan).mockResolvedValueOnce(failing("2027-01-15")).mockResolvedValueOnce(ok());
        const list = shortlist();
        const { draft } = await schedule(intake(), list, registry());
        const v = await verify(intake(), list, draft, registry());
        expect(evaluatePlan).toHaveBeenCalledTimes(2);
        expect(v.adjustments[0]).toMatch(/re-arranged the days with real transit times/);
        expect(v.unresolved).toEqual([]);
    });

    it("drops a nice-to-have from a day that still fails, and reports what it could not fix", async () => {
        vi.mocked(evaluatePlan).mockResolvedValueOnce(failing("2027-01-15")).mockResolvedValueOnce(failing("2027-01-15")).mockResolvedValueOnce(failing("2027-01-15"));
        const list = shortlist();
        const { draft } = await schedule(intake(), list, registry());
        const v = await verify(intake(), list, draft, registry());
        expect(evaluatePlan).toHaveBeenCalledTimes(3);
        expect(v.adjustments.some((a) => a.startsWith("2027-01-15: dropped"))).toBe(true);
        expect(v.adjustments.some((a) => a.startsWith("could not fix automatically"))).toBe(true);
        // must-sees are never dropped by the automatic fix
        const kept = new Set(v.draft.days.flatMap((d) => d.stops.map((s) => s.place_id)));
        for (const item of list.items.filter((i) => i.priority === "must" && !i.meal)) {
            if (draft.days.some((d) => d.stops.some((s) => s.place_id === item.place_id))) expect(kept.has(item.place_id)).toBe(true);
        }
    });

    it("leaves problems a smaller day cannot fix to the report", async () => {
        const noDinner: Evaluation = evaluation([], [{ level: "error", code: "no_dinner", day: "2027-01-15", message: "no dinner stop" }]);
        vi.mocked(evaluatePlan).mockResolvedValueOnce(noDinner).mockResolvedValueOnce(noDinner);
        const list = shortlist();
        const { draft } = await schedule(intake(), list, registry());
        const v = await verify(intake(), list, draft, registry());
        expect(evaluatePlan).toHaveBeenCalledTimes(2);
        expect(v.unresolved.map((i) => i.code)).toEqual(["no_dinner"]);
    });
});

describe("feedbackFrom", () => {
    it("keeps real leg times and learns how slow transit runs against the estimate", () => {
        const day = {
            date: "2027-01-15",
            stops: [],
            legs: [leg(HOTEL.id, MFA.id, 540, 60), leg(MFA.id, GARDNER.id, 700, 5, "walk", "routed"), leg(GARDNER.id, OLD_STATE.id, 800, 90), leg(OLD_STATE.id, HOTEL.id, 900, 80), leg("x", "y", 0, 10, "transit", "estimate")],
        };
        const fb = feedbackFrom(evaluation([day]), registry());
        expect(fb.legs.get(`${HOTEL.id}>${MFA.id}`)).toEqual({ minutes: 60, walk: false });
        expect(fb.legs.get(`${MFA.id}>${GARDNER.id}`)?.walk).toBe(true);
        // estimates are not observations
        expect(fb.legs.has("x>y")).toBe(false);
        expect(fb.transitFactor).toBeGreaterThan(1);
        expect(fb.transitFactor).toBeLessThanOrEqual(1.8);
    });

    it("does not guess a factor from too few legs", () => {
        const day = { date: "2027-01-15", stops: [], legs: [leg(HOTEL.id, MFA.id, 540, 200)] };
        expect(feedbackFrom(evaluation([day]), registry()).transitFactor).toBe(1);
    });
});

describe("dropCandidate", () => {
    const stop = (place_id: string, duration_min: number) => ({ place_id, duration_min, cost_per_person: 0 });
    // library and gardner are nice-to-haves; old state house is far from the rest of the day
    const stops = [stop(LIBRARY.id, 60), stop(GARDNER.id, 60), stop(OLD_STATE.id, 60), stop(MFA.id, 120)];
    const candidates = [0, 1, 2].map((index) => ({ stop: stops[index], index }));

    it("drops the stop that frees the most time, counting the travel it adds", () => {
        const long = [{ level: "error" as const, code: "day_too_long" as const, day: "2027-01-15", message: "" }];
        expect(dropCandidate(candidates, long, stops, registry())).toBe(2);
    });

    it("for a missed start, drops something before the stop that was reached late", () => {
        const missed = [{ level: "error" as const, code: "missed_start" as const, day: "2027-01-15", placeId: GARDNER.id, message: "" }];
        expect(dropCandidate(candidates, missed, stops, registry())).toBe(0);
    });

    it("drops nothing when nothing may be dropped", () => {
        expect(dropCandidate([], [], stops, registry())).toBe(-1);
    });
});
