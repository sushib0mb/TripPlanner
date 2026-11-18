import { cachedJson } from "./http";
import type { Segment } from "./types";

type LatLon = { lat: number; lon: number };

// segment times stay in utc here, the checker turns them into local minutes
export type RawSegment = Omit<Segment, "departMin" | "arriveMin"> & { departUtc: number; arriveUtc: number };

export interface RouteResult {
    minutes: number;
    km: number;
    geometry: [number, number][];
}

export interface TransitResult extends RouteResult {
    departUtc: number;
    arriveUtc: number;
    lines: string[];
    vehicleLegs: number;
    segments: RawSegment[];
}

const OSRM: Record<"foot" | "car", string> = {
    foot: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/",
    car: "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
};

const r5 = (n: number) => n.toFixed(5);

export async function osrmRoute(profile: "foot" | "car", a: LatLon, b: LatLon): Promise<RouteResult | null> {
    const url = `${OSRM[profile]}${r5(a.lon)},${r5(a.lat)};${r5(b.lon)},${r5(b.lat)}?overview=simplified&geometries=geojson`;
    const data = await cachedJson<{ code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] }>(url);
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route) return null;
    return {
        minutes: route.duration / 60,
        km: route.distance / 1000,
        geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    };
}

interface MotisPlace {
    name: string;
    lat: number;
    lon: number;
}

interface MotisLeg {
    mode: string;
    startTime: string;
    endTime: string;
    distance?: number;
    from: MotisPlace;
    to: MotisPlace;
    routeShortName?: string;
    routeLongName?: string;
    routeColor?: string;
    routeTextColor?: string;
    agencyName?: string;
    headsign?: string;
    tripShortName?: string;
    displayName?: string;
    intermediateStops?: MotisPlace[];
    legGeometry?: { points: string; precision: number };
}

// fullwidth digits and letters in feed text, e.g. bus 上２６ becomes 上26
const nfkc = (s?: string) => s?.normalize("NFKC");

// gtfs colors come as bare hex and are often blank
const hex = (c?: string) => (c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : undefined);

interface MotisPlan {
    itineraries?: { startTime: string; endTime: string; transfers: number; legs: MotisLeg[] }[];
}

// round the departure up to 10 minutes so repeated plans hit the cache
export async function transitRoute(a: LatLon, b: LatLon, departUtc: number): Promise<TransitResult | null> {
    const rounded = Math.ceil(departUtc / 600000) * 600000;
    const params = new URLSearchParams({
        fromPlace: `${r5(a.lat)},${r5(a.lon)}`,
        toPlace: `${r5(b.lat)},${r5(b.lon)}`,
        time: new Date(rounded).toISOString(),
        numItineraries: "1",
        // feeds with translations then return english line, stop and direction names
        language: "en",
    });
    const data = await cachedJson<MotisPlan>("https://api.transitous.org/api/v6/plan?" + params, { gapMs: 1200, timeoutMs: 60000 });
    const it = data.itineraries?.[0];
    if (!it) return null;
    const vehicle = it.legs.filter((l) => !["WALK", "BIKE", "CAR"].includes(l.mode));
    if (vehicle.length === 0) return null;
    const geometry: [number, number][] = [];
    const segments: RawSegment[] = [];
    let km = 0;
    for (const leg of it.legs) {
        const walk = ["WALK", "BIKE", "CAR"].includes(leg.mode);
        const raw = leg.legGeometry ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision) : [];
        const path = walk ? raw : followStops(raw, [leg.from, ...(leg.intermediateStops ?? []), leg.to]);
        geometry.push(...path);
        // transitous only gives distances for walks, so measure rides along their path
        km += leg.distance !== undefined ? leg.distance / 1000 : pathKm(path);
        segments.push({
            mode: leg.mode.toLowerCase(),
            line: walk ? undefined : nfkc(leg.routeLongName || leg.routeShortName || leg.displayName),
            short: walk ? undefined : nfkc(leg.routeShortName || leg.displayName),
            color: walk ? undefined : hex(leg.routeColor),
            textColor: walk ? undefined : hex(leg.routeTextColor),
            agency: leg.agencyName,
            headsign: nfkc(leg.headsign),
            from: nfkc(leg.from.name)!,
            to: nfkc(leg.to.name)!,
            fromPos: [leg.from.lat, leg.from.lon],
            toPos: [leg.to.lat, leg.to.lon],
            departUtc: Date.parse(leg.startTime),
            arriveUtc: Date.parse(leg.endTime),
            stops: leg.intermediateStops?.length ?? 0,
            geometry: path,
        });
    }
    const arriveUtc = Date.parse(it.endTime);
    return {
        departUtc: Date.parse(it.startTime),
        arriveUtc,
        minutes: (arriveUtc - departUtc) / 60000,
        km,
        geometry,
        lines: vehicle.map((l) => nfkc(`${l.mode.toLowerCase()} ${l.routeShortName || l.tripShortName || l.displayName || ""}`.trim())!),
        vehicleLegs: vehicle.length,
        segments,
    };
}

// rough km, plenty for matching points a few hundred metres apart
const flatKm = (p: [number, number], q: LatLon) => Math.hypot(p[0] - q.lat, (p[1] - q.lon) * Math.cos((q.lat * Math.PI) / 180)) * 111;

const pathKm = (p: [number, number][]) => p.slice(1).reduce((a, q, i) => a + flatKm(q, { lat: p[i][0], lon: p[i][1] }), 0);

// some feeds give a ride a broken shape, e.g. paris metro 6 bir-hakeim to etoile came back as a 25 km loop
// round the city, metro 5 from gare de l'est first doubled back to gare du nord, and jr kanda to akihabara
// ran 750 m past akihabara and back. the ride's own stop list is reliable, so walk the shape stop by stop,
// keeping the stretch from the last pass of each stop to the first pass of the next
export function followStops(path: [number, number][], stops: LatLon[], nearKm = 0.3): [number, number][] {
    const straight = stops.map((s) => [s.lat, s.lon] as [number, number]);
    if (path.length < 2 || stops.length < 2) return path.length >= 2 ? path : straight;
    const d = (i: number, s: LatLon) => flatKm(path[i], s);
    // first point from lo on that comes near s, slid to the nearest point of that pass, else the closest point
    const firstPass = (s: LatLon, lo: number) => {
        let i = lo;
        while (i < path.length && d(i, s) > nearKm) i++;
        if (i === path.length) {
            let best = lo;
            for (let j = lo; j < path.length; j++) if (d(j, s) < d(best, s)) best = j;
            return best;
        }
        while (i + 1 < path.length && d(i + 1, s) < d(i, s)) i++;
        return i;
    };
    // last point between lo and hi that comes near s, slid back to the nearest point of that pass
    const lastPass = (s: LatLon, lo: number, hi: number) => {
        let i = hi;
        while (i > lo && d(i, s) > nearKm) i--;
        if (d(i, s) > nearKm) return lo;
        while (i > lo && d(i - 1, s) < d(i, s)) i--;
        return i;
    };
    const out: [number, number][] = [];
    let prev = 0;
    for (let k = 1; k < stops.length && prev < path.length - 1; k++) {
        const end = firstPass(stops[k], prev + 1);
        const start = lastPass(stops[k - 1], prev, end - 1);
        out.push(...path.slice(out.length ? start + 1 : start, end + 1));
        prev = end;
    }
    // if the shape still wanders far beyond the stop to stop distance, straight lines between stops are safer
    const viaStops = pathKm(straight);
    return out.length >= 2 && pathKm(out) <= viaStops * 1.6 + 0.5 ? out : straight;
}

export function decodePolyline(str: string, precision = 5): [number, number][] {
    const factor = 10 ** precision;
    const out: [number, number][] = [];
    let index = 0;
    let lat = 0;
    let lon = 0;
    while (index < str.length) {
        for (const which of [0, 1]) {
            let result = 0;
            let shift = 0;
            let byte: number;
            do {
                byte = str.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            const delta = result & 1 ? ~(result >> 1) : result >> 1;
            if (which === 0) lat += delta;
            else lon += delta;
        }
        out.push([lat / factor, lon / factor]);
    }
    return out;
}

// transit stop matching a name near a point, for snapping airports to a terminal stop
export async function nearbyStop(text: string, near: LatLon, maxKm: number): Promise<{ name: string; lat: number; lon: number } | null> {
    const params = new URLSearchParams({ text, type: "STOP", place: `${r5(near.lat)},${r5(near.lon)}`, placeBias: "5", numResults: "5", language: "en" });
    const hits = await cachedJson<{ name: string; lat: number; lon: number }[]>("https://api.transitous.org/api/v1/geocode?" + params);
    const km = (p: LatLon) => Math.hypot(p.lat - near.lat, (p.lon - near.lon) * Math.cos((near.lat * Math.PI) / 180)) * 111;
    return hits.filter((h) => km(h) <= maxKm).sort((a, b) => km(a) - km(b))[0] ?? null;
}
