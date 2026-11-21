import type { Draft, Evaluation, Intake, Leg, Place, Registry, Shortlist, TimedDay } from "@/lib/types";

// a small made-up boston trip; coordinates are real so distances and timezones behave

export const intake = (over: Partial<Intake> = {}): Intake => ({
    destination: "Boston",
    startDate: "2027-01-15",
    nights: 1,
    arrivalAirport: "",
    arrivalTime: "",
    departureAirport: "",
    departureTime: "",
    hotel: "Back Bay",
    adults: 2,
    kids: 0,
    budget: 1000,
    currency: "USD",
    getAround: "transit",
    maxWalkMin: 15,
    carDailyRate: 60,
    pace: "normal",
    interests: "",
    ...over,
});

const place = (id: string, name: string, kind: string, lat: number, lon: number, openingHours?: string): Place => ({ id, name, kind, lat, lon, openingHours, source: "nominatim" });

export const HOTEL = place("hotel", "Back Bay Hotel", "tourism=hotel", 42.3503, -71.0753);
export const MFA = place("mfa", "Museum of Fine Arts", "tourism=museum", 42.3394, -71.0942, "Mo-Su 10:00-17:00");
export const GARDNER = place("gardner", "Isabella Stewart Gardner Museum", "tourism=museum", 42.3382, -71.0991, "Mo-Su 11:00-17:00");
export const LIBRARY = place("library", "Boston Public Library", "amenity=library", 42.3493, -71.0782, "Mo-Su 09:00-20:00");
export const OLD_STATE = place("oldstate", "Old State House", "tourism=museum", 42.3587, -71.0575, "Mo-Su 10:00-17:00");
export const CONSTITUTION = place("uss", "USS Constitution", "tourism=attraction", 42.3725, -71.0566, "Mo-Su 10:00-16:00");
export const CAFE = place("cafe", "Cafe Near MFA", "amenity=restaurant", 42.3398, -71.0935, "Mo-Su 11:00-15:00");
export const DINER = place("diner", "Dinner Spot", "amenity=restaurant", 42.3497, -71.0772, "Mo-Su 17:00-23:00");
export const AIRPORT = place("DEP", "Logan Airport", "aeroway=aerodrome", 42.3656, -71.0096);

export const registry = (...extra: Place[]): Registry =>
    Object.fromEntries([HOTEL, MFA, GARDNER, LIBRARY, OLD_STATE, CONSTITUTION, CAFE, DINER, ...extra].map((p) => [p.id, p]));

export const costs = { transit_fare: 2.4, taxi_base: 3, taxi_per_km: 2, fuel_per_km: 0.2, parking_per_stop: 10 };

export const shortlist = (over: Partial<Shortlist> = {}): Shortlist => ({
    hotel_place_id: HOTEL.id,
    local_costs: costs,
    summary: "test trip",
    items: [
        { place_id: MFA.id, priority: "must", duration_min: 180, cost_per_person: 30 },
        { place_id: GARDNER.id, priority: "nice", duration_min: 90, cost_per_person: 20 },
        { place_id: LIBRARY.id, priority: "nice", duration_min: 60, cost_per_person: 0 },
        { place_id: OLD_STATE.id, priority: "nice", duration_min: 60, cost_per_person: 15 },
        { place_id: CONSTITUTION.id, priority: "must", duration_min: 90, cost_per_person: 0 },
        { place_id: CAFE.id, priority: "nice", duration_min: 60, cost_per_person: 20, meal: "lunch" },
        { place_id: DINER.id, priority: "nice", duration_min: 90, cost_per_person: 40, meal: "dinner" },
    ],
    ...over,
});

export const draft = (days: Draft["days"]): Draft => ({ hotel_place_id: HOTEL.id, local_costs: costs, days, summary: "" });

export const leg = (fromId: string, toId: string, departMin: number, minutes: number, mode: Leg["mode"] = "transit", timeSource: Leg["timeSource"] = "timetable"): Leg => ({
    fromId,
    toId,
    mode,
    departMin,
    arriveMin: departMin + minutes,
    minutes,
    km: 1,
    cost: 0,
    costSource: "none",
    timeSource,
    lines: [],
    geometry: [],
});

export const evaluation = (days: TimedDay[], issues: Evaluation["issues"] = []): Evaluation => ({
    days,
    issues,
    totals: { activities: 0, transport: 0, car: 0, total: 0, budget: 1000 },
    timezone: "America/New_York",
    transitCalls: 0,
});
