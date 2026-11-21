import { describe, expect, it } from "vitest";
import { buildMapData, daySteps, fanOut, stepOfStop, type MarkerSpec } from "@/lib/mapData";
import type { TimedDay, TimedStop } from "@/lib/types";
import { AIRPORT, evaluation, HOTEL, leg, LIBRARY, MFA, registry } from "./fixtures";

const stop = (index: number, placeId: string, meal?: "lunch"): TimedStop => ({ index, placeId, name: placeId, arriveMin: 0, startMin: 0, endMin: 0, cost: 0, hours: "open", meal });

// arrival, a sight, lunch held at the same sight, a second sight, back to the hotel
const day: TimedDay = {
    date: "2027-01-15",
    stops: [stop(0, MFA.id), stop(1, MFA.id, "lunch"), stop(2, LIBRARY.id)],
    legs: [leg("ARR", HOTEL.id, 600, 40), leg(HOTEL.id, MFA.id, 660, 20), leg(MFA.id, MFA.id, 800, 0, "walk", "routed"), leg(MFA.id, LIBRARY.id, 900, 15), leg(LIBRARY.id, HOTEL.id, 1000, 10)],
};

describe("daySteps", () => {
    it("pairs each move with the stop it reaches", () => {
        expect(daySteps(day)).toEqual([
            { leg: 0, stop: null },
            { leg: 1, stop: 0 },
            { leg: 2, stop: 1 },
            { leg: 3, stop: 2 },
            { leg: 4, stop: null },
        ]);
        expect(stepOfStop(day, 1)).toBe(2);
        expect(stepOfStop(day, 9)).toBe(-1);
    });
});

describe("buildMapData", () => {
    it("numbers stops per day and shows a shared airport once", () => {
        const reg = { ...registry(), ARR: { ...AIRPORT, id: "ARR" }, DEP: AIRPORT };
        const { markers } = buildMapData(evaluation([day]), reg, HOTEL.id, null);
        const stops = markers.filter((m) => m.day === 0);
        expect(stops.map((m) => m.label)).toEqual(["1", "2", "3"]);
        expect(stops.map((m) => m.kind)).toEqual(["stop", "meal", "stop"]);
        expect(markers.filter((m) => m.kind === "airport")).toHaveLength(1);
        expect(markers.filter((m) => m.kind === "hotel")).toHaveLength(1);
    });

    it("draws only the selected day", () => {
        const other: TimedDay = { ...day, date: "2027-01-16" };
        const { lines, markers } = buildMapData(evaluation([day, other]), registry(), HOTEL.id, 1);
        expect(markers.filter((m) => m.day >= 0).every((m) => m.day === 1)).toBe(true);
        expect(lines.features.every((f) => f.properties?.day === 1)).toBe(true);
    });
});

describe("fanOut", () => {
    it("spreads markers on the same spot and leaves lone markers alone", () => {
        const m = (key: string, lat: number): MarkerSpec => ({ key, kind: "stop", day: 0, stop: 0, label: "", lat, lon: -71, color: "#000000", title: "", offset: [0, 0] });
        const markers = [m("a", 42), m("b", 42.0001), m("c", 42.5)];
        fanOut(markers);
        expect(markers[0].offset).not.toEqual(markers[1].offset);
        expect(markers[2].offset).toEqual([0, 0]);
    });
});
