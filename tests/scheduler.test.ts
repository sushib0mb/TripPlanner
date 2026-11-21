import { describe, expect, it, vi } from "vitest";

// no network: walking times fall back to straight-line estimates
vi.mock("@/lib/routing", () => ({ walkMatrix: vi.fn(async () => null), osrmRoute: vi.fn(async () => null), transitRoute: vi.fn(async () => null), nearbyStop: vi.fn(async () => null) }));

const { schedule, legKey, slotKey, shortlistFromDraft } = await import("@/lib/scheduler");
const { LUNCH_LATEST } = await import("@/lib/rules");
const { hhmmToMin } = await import("@/lib/time");
const { intake, registry, shortlist, CONSTITUTION, DINER, HOTEL, MFA, GARDNER } = await import("./fixtures");

// start minute of a stop from the scheduler's report, e.g. "  10:25-13:25 Museum of Fine Arts"
const startIn = (report: string, name: string) => {
    const line = report.split("\n").find((l) => l.includes(name) && /^\s+\d\d:\d\d-/.test(l));
    return line ? hhmmToMin(line.trim().slice(0, 5)) : null;
};

describe("schedule", () => {
    it("never changes the caller's shortlist", async () => {
        const list = shortlist();
        list.items[0].day = "2030-01-01";
        const before = JSON.stringify(list);
        const result = await schedule(intake(), list, registry());
        expect(JSON.stringify(list)).toBe(before);
        expect(result.problems.some((p) => p.includes("outside the trip"))).toBe(true);
    });

    it("marks only a booked start as fixed; meals and waits are not-before holds", async () => {
        const list = shortlist();
        const uss = list.items.find((i) => i.place_id === CONSTITUTION.id)!;
        uss.start_after = "14:00";
        const { draft } = await schedule(intake(), list, registry());
        const stops = draft.days.flatMap((d) => d.stops);
        expect(stops.find((s) => s.place_id === CONSTITUTION.id)?.start_kind).toBe("fixed");
        for (const s of stops.filter((s) => s.meal && s.start_after)) expect(s.start_kind).toBe("not_before");
        // a pinned start carries over when the plan is turned back into a shortlist
        expect(shortlistFromDraft(draft).items.find((i) => i.place_id === CONSTITUTION.id)?.start_after).toBe("14:00");
    });

    it("keeps lunch inside lunchtime by ordering the day around it", async () => {
        const list = shortlist({
            items: [
                { place_id: MFA.id, priority: "must", duration_min: 240, cost_per_person: 0 },
                { place_id: GARDNER.id, priority: "must", duration_min: 105, cost_per_person: 0 },
            ],
        });
        const result = await schedule(intake({ nights: 0, pace: "packed" }), list, registry());
        const lunch = result.report.split("\n").find((l) => l.includes("(lunch)"));
        expect(lunch).toBeDefined();
        expect(hhmmToMin(lunch!.trim().slice(0, 5))).toBeLessThanOrEqual(LUNCH_LATEST);
    });

    it("checks a restaurant chosen earlier again and drops it when the slot no longer fits", async () => {
        // the dinner place does not open until 17:00, so it cannot serve lunch
        const fixedMeals = new Map([[slotKey("2027-01-15", "lunch"), { place_id: DINER.id, priority: "nice" as const, duration_min: 60, cost_per_person: 40, meal: "lunch" as const }]]);
        const result = await schedule(intake(), shortlist(), registry(), { fixedMeals });
        expect(result.problems.some((p) => p.includes("2027-01-15 lunch") && p.includes("choose again"))).toBe(true);
        const day1 = result.draft.days[0].stops;
        expect(day1.some((s) => s.meal === "lunch" && s.place_id === DINER.id)).toBe(false);
    });

    it("plans with real travel times when they are fed back", async () => {
        const list = shortlist({ items: [{ place_id: MFA.id, priority: "must", duration_min: 60, cost_per_person: 0 }] });
        const plain = await schedule(intake({ nights: 0 }), list, registry());
        const slow = await schedule(intake({ nights: 0 }), list, registry(), {
            feedback: { legs: new Map([[legKey(HOTEL.id, MFA.id), { minutes: 150, walk: false }]]), transitFactor: 1 },
        });
        const a = startIn(plain.report, MFA.name);
        const b = startIn(slow.report, MFA.name);
        expect(a).not.toBeNull();
        expect(b!).toBeGreaterThan(a!);
    });
});
