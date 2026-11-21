import { describe, expect, it } from "vitest";
import { fitOpen, hoursState, openIntervals } from "@/lib/hours";

describe("opening hours", () => {
    it("fits a visit inside the opening hours", () => {
        expect(fitOpen("Mo-Su 10:00-17:00", "2027-01-15", 9 * 60, 60)).toBe(10 * 60);
        expect(fitOpen("Mo-Su 10:00-17:00", "2027-01-15", 16 * 60 + 30, 60)).toBeNull();
    });

    it("treats unknown or unreadable hours as open from the earliest time", () => {
        expect(fitOpen(undefined, "2027-01-15", 8 * 60, 60)).toBe(8 * 60);
        expect(fitOpen("not a rule", "2027-01-15", 8 * 60, 60)).toBe(8 * 60);
        expect(hoursState(undefined, "2027-01-15", 600)).toBe("unknown");
    });

    it("answers unknown, not closed, for rules with a comment", () => {
        expect(hoursState('Fr 17:00-22:30 "Dinner"', "2027-01-15", 18 * 60)).toBe("unknown");
    });

    // the tests run in America/New_York, where 2027-03-14 skips 02:00-03:00. minutes used to be read from
    // timestamp differences, which came out an hour early after the jump
    it("reads wall-clock minutes on a day the server's clock jumps", () => {
        expect(openIntervals("Mo-Su 09:00-17:00", "2027-03-14", 0, 24 * 60)).toEqual([[540, 1020]]);
        expect(openIntervals("Mo-Su 09:00-17:00", "2027-11-07", 0, 24 * 60)).toEqual([[540, 1020]]);
        expect(fitOpen("Mo-Su 09:00-17:00", "2027-03-14", 8 * 60, 60)).toBe(540);
    });
});
