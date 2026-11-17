import { cachedJson } from "./http";

type LatLon = { lat: number; lon: number };

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

interface MotisLeg {
    mode: string;
    startTime: string;
    endTime: string;
    distance?: number;
    routeShortName?: string;
    tripShortName?: string;
    displayName?: string;
    legGeometry?: { points: string; precision: number };
}

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
    });
    const data = await cachedJson<MotisPlan>("https://api.transitous.org/api/v6/plan?" + params, { gapMs: 1200, timeoutMs: 60000 });
    const it = data.itineraries?.[0];
    if (!it) return null;
    const vehicle = it.legs.filter((l) => !["WALK", "BIKE", "CAR"].includes(l.mode));
    if (vehicle.length === 0) return null;
    const geometry: [number, number][] = [];
    let km = 0;
    for (const leg of it.legs) {
        if (leg.legGeometry) geometry.push(...decodePolyline(leg.legGeometry.points, leg.legGeometry.precision));
        km += (leg.distance ?? 0) / 1000;
    }
    const arriveUtc = Date.parse(it.endTime);
    return {
        departUtc: Date.parse(it.startTime),
        arriveUtc,
        minutes: (arriveUtc - departUtc) / 60000,
        km,
        geometry,
        lines: vehicle.map((l) => `${l.mode.toLowerCase()} ${l.routeShortName || l.tripShortName || l.displayName || ""}`.trim()),
        vehicleLegs: vehicle.length,
    };
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
