import tzlookup from "tz-lookup";
import { cachedJson } from "./http";
import { nearbyStop } from "./routing";
import type { Place } from "./types";

interface NominatimHit {
    osm_type: string;
    osm_id: number;
    lat: string;
    lon: string;
    name: string;
    display_name: string;
    category: string;
    type: string;
    extratags?: Record<string, string> | null;
}

type LatLon = { lat: number; lon: number };

function toPlace(h: NominatimHit): Place {
    return {
        id: h.osm_type[0] + h.osm_id,
        name: h.name || h.display_name.split(",")[0],
        lat: Number(h.lat),
        lon: Number(h.lon),
        kind: `${h.category}=${h.type}`,
        openingHours: h.extratags?.opening_hours,
        source: "nominatim",
    };
}

function viewbox(c: LatLon, km: number) {
    const dLat = km / 111;
    const dLon = km / (111 * Math.cos((c.lat * Math.PI) / 180));
    return `${(c.lon - dLon).toFixed(5)},${(c.lat + dLat).toFixed(5)},${(c.lon + dLon).toFixed(5)},${(c.lat - dLat).toFixed(5)}`;
}

async function nominatim(params: Record<string, string>): Promise<Place[]> {
    const q = new URLSearchParams({ format: "jsonv2", extratags: "1", "accept-language": "en", ...params });
    const hits = await cachedJson<NominatimHit[]>("https://nominatim.openstreetmap.org/search?" + q);
    return hits.map(toPlace);
}

// named place or address, biased toward the destination
export function geocode(query: string, near?: LatLon): Promise<Place[]> {
    return nominatim({ q: query, limit: "5", ...(near ? { viewbox: viewbox(near, 60) } : {}) });
}

// places matching a keyword (museum, temple, ramen, park) inside a box around a point
export async function searchPlaces(center: LatLon, keyword: string, radiusM: number): Promise<Place[]> {
    const hits = await nominatim({ q: keyword, limit: "30", bounded: "1", viewbox: viewbox(center, radiusM / 1000) });
    return hits
        .filter((p) => p.name)
        .sort((a, b) => haversineKm(center, a) - haversineKm(center, b))
        .slice(0, 20);
}

export async function findAirport(query: string, near: LatLon): Promise<Place | undefined> {
    const hits = [...(await geocode(`${query} airport`, near)), ...(await geocode(query, near))];
    const airport = hits
        .filter((h) => h.kind === "aeroway=aerodrome")
        .sort((a, b) => haversineKm(near, a) - haversineKm(near, b))[0];
    if (!airport) return undefined;
    // the airport's map point is mid-airfield; route from its terminal stop instead
    let stop = null;
    for (const text of [`${query} Airport`, airport.name, "Airport"]) {
        stop = await nearbyStop(text, airport, 6).catch(() => null);
        if (stop) break;
    }
    return stop ? { ...airport, name: `${airport.name} (${stop.name})`, lat: stop.lat, lon: stop.lon } : airport;
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
    const r = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(x));
}

export function timezoneAt(p: { lat: number; lon: number }): string {
    return tzlookup(p.lat, p.lon);
}

// offset of tz from utc at a given instant, in ms
function tzOffsetMs(ts: number, tz: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ts;
}

// local date + minutes after midnight in tz -> utc timestamp
export function localToUtc(date: string, minutes: number, tz: string) {
    const [y, m, d] = date.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, minutes);
    let utc = guess - tzOffsetMs(guess, tz);
    const second = tzOffsetMs(utc, tz);
    if (guess - second !== utc) utc = guess - second;
    return utc;
}
