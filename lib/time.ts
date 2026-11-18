// pure helpers, safe to import from client components

export function hhmmToMin(s: string) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + (m || 0);
}

export function minToHhmm(min: number) {
    // round first, rounding only the minutes part gave times like 10:60
    const total = Math.round(min);
    const day = Math.floor(total / 1440);
    const r = ((total % 1440) + 1440) % 1440;
    const s = `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
    return day > 0 ? `${s}+${day}d` : s;
}

export function addDays(date: string, n: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
