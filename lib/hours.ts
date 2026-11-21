import OpeningHours from "opening_hours";

// opening_hours reads a Date's local fields (weekday, hour, minute), so times are passed as dates whose local
// fields spell the destination's wall-clock time. the server's own timezone then only matters if we do
// arithmetic on timestamps, which jumps an hour across the server's daylight saving changes; so minutes are
// always read back from the fields, never from timestamp differences

function at(date: string, minute: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d, 0, minute);
}

// minutes after midnight of `date` from a date's local fields, counting whole days past it
function minutesOf(base: string, d: Date) {
    const [y, m, day] = base.split("-").map(Number);
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(y, m - 1, day)) / 86400000);
    return days * 1440 + d.getHours() * 60 + d.getMinutes();
}

function parse(oh: string | undefined) {
    if (!oh) return null;
    try {
        return new OpeningHours(oh, null);
    } catch {
        return null;
    }
}

export function hoursState(oh: string | undefined, date: string, minute: number): "open" | "closed" | "unknown" {
    const parsed = parse(oh);
    if (!parsed) return "unknown";
    try {
        const when = at(date, minute);
        // the library marks any rule with a comment, e.g. Fr 17:00-22:30 "Dinner", as unknown and getState then
        // answers closed, which wrongly flagged those places as closed
        if (parsed.getUnknown(when)) return "unknown";
        return parsed.getState(when) ? "open" : "closed";
    } catch {
        return "unknown";
    }
}

// open stretches between two times on a date, null when the hours are unknown or unreadable
export function openIntervals(oh: string | undefined, date: string, from: number, to: number): [number, number][] | null {
    const parsed = parse(oh);
    if (!parsed) return null;
    try {
        return parsed.getOpenIntervals(at(date, from), at(date, to)).map(([s, e]) => [minutesOf(date, s), minutesOf(date, e)]);
    } catch {
        return null;
    }
}

// earliest start at or after `earliest` with `length` minutes open, null when no opening fits
export function fitOpen(oh: string | undefined, date: string, earliest: number, length: number, latest = 24 * 60): number | null {
    const spans = openIntervals(oh, date, Math.max(0, earliest), latest);
    if (spans === null) return earliest;
    for (const [s, e] of spans) {
        const start = Math.max(s, earliest);
        if (start + length <= e) return start;
    }
    return null;
}
