import type { TimedDay } from "./types";

// display name per place from the stops, which carry english names; a meal break held at a sight
// shares its place id, so the sight's own name wins
export function stopNames(days: TimedDay[]) {
    const names = new Map<string, string>();
    for (const d of days) for (const s of d.stops) if (!s.meal) names.set(s.placeId, s.name);
    for (const d of days) for (const s of d.stops) if (!names.has(s.placeId)) names.set(s.placeId, s.name);
    return names;
}
