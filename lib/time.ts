// pure helpers, safe to import from client components

export function hhmmToMin(s: string) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + (m || 0);
}

export function minToHhmm(min: number) {
    const day = Math.floor(min / 1440);
    const r = ((min % 1440) + 1440) % 1440;
    const s = `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(Math.round(r % 60)).padStart(2, "0")}`;
    return day > 0 ? `${s}+${day}d` : s;
}

export function addDays(date: string, n: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
