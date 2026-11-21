import { dayColor, readableText, shade } from "./colors";
import { haversineKm } from "./distance";
import { stopNames } from "./names";
import { minToHhmm } from "./time";
import type { Evaluation, Leg, Place, Registry, Segment, TimedDay } from "./types";

// turns an evaluated plan into what the map draws: route lines, stop markers and the steps of a day.
// pure functions, so the map component only renders and the shapes can be tested without a browser

type Pos = [number, number];
export type Collection = GeoJSON.FeatureCollection;

// one step of a day is one move and where it arrives: the leg's index, and the stop it reaches if any
// (the last leg of a day reaches the hotel or the airport). step k always means leg k
export interface Step {
    leg: number;
    stop: number | null;
}

export function daySteps(day: TimedDay): Step[] {
    let next = 0;
    return day.legs.map((leg, li) => {
        const s = day.stops[next];
        if (s && s.placeId === leg.toId) return { leg: li, stop: next++ };
        return { leg: li, stop: null };
    });
}

// the step that arrives at a stop, the way a click on a stop turns into a step
export function stepOfStop(day: TimedDay, stop: number): number {
    const step = daySteps(day).find((s) => s.stop === stop);
    return step ? step.leg : -1;
}

export interface MarkerSpec {
    key: string;
    kind: "stop" | "meal" | "hotel" | "airport";
    day: number;
    // the stop's position in its evaluated day, and the number shown on it (position + 1)
    stop: number;
    label: string;
    lat: number;
    lon: number;
    color: string;
    title: string;
    // pixels, so markers on the same spot fan out instead of hiding each other
    offset: Pos;
}

const lngLat = (path: Pos[]) => path.map(([lat, lon]) => [lon, lat] as Pos);

// consecutive rides in one day alternate between darker and lighter versions of the day color
const SHADES = [0, -0.35, 0.3, -0.55, 0.5];
export const WALK_GRAY = "#4b5563";
// markers closer than this share a spot and are fanned out
const SAME_SPOT_KM = 0.04;
const FAN_PX = 13;

function rideTitle(s: Segment) {
    const name = s.line && s.short && s.short !== s.line ? `${s.line} (${s.short})` : (s.line ?? s.mode);
    const toward = s.headsign ? ` toward ${s.headsign}` : "";
    return `${name}${toward} · ${s.from} → ${s.to} · ${s.stops + 1} stop${s.stops > 0 ? "s" : ""} · ${minToHhmm(s.departMin)}–${minToHhmm(s.arriveMin)}`;
}

export function legSummary(l: Leg, name: (id: string) => string) {
    const how = l.mode === "transit" && l.lines.length ? `${l.mode} (${l.lines.join(", ")})` : l.mode;
    return `${minToHhmm(l.departMin)} ${how} ${Math.round(l.minutes)} min · ${name(l.fromId)} → ${name(l.toId)}`;
}

function line(path: Pos[], props: Record<string, string | number>): GeoJSON.Feature {
    return { type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: props };
}

function point(lat: number, lon: number, props: Record<string, string | number>): GeoJSON.Feature {
    return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props };
}

export interface MapData {
    lines: Collection;
    markers: MarkerSpec[];
    // every coordinate shown, to fit the view to
    coords: Pos[];
}

// route lines and markers for every day, or for one day when `selected` is set. in the all-days view each day
// is shifted sideways a little so routes that share a street stay visible side by side
export function buildMapData(evaluation: Evaluation, registry: Registry, hotelId: string, selected: number | null): MapData {
    const features: GeoJSON.Feature[] = [];
    const markers: MarkerSpec[] = [];
    const coords: Pos[] = [];
    const single = selected !== null;
    const shown = stopNames(evaluation.days);
    const name = (id: string) => shown.get(id) ?? registry[id]?.name ?? id;
    const dayCount = evaluation.days.length;

    evaluation.days.forEach((d, di) => {
        if (single && di !== selected) return;
        const color = dayColor(di);
        // the day view keeps out-and-back legs apart, the all-days view keeps days apart
        const offset = single ? 2.5 : (di - (dayCount - 1) / 2) * 3;
        let ride = 0;
        d.legs.forEach((l, li) => {
            const base = { day: di, leg: li, offset };
            if (l.segments?.length) {
                for (const s of l.segments) {
                    const path = lngLat(s.geometry);
                    if (path.length < 2) continue;
                    coords.push(...path);
                    if (s.mode === "walk") {
                        features.push(line(path, { ...base, kind: "walk", color: single ? WALK_GRAY : color, label: "", title: `walk ${Math.round(s.arriveMin - s.departMin)} min · ${s.from} → ${s.to}` }));
                        continue;
                    }
                    const tint = single ? shade(color, SHADES[ride++ % SHADES.length]) : color;
                    const badge = s.color ?? tint;
                    features.push(line(path, { ...base, kind: "ride", color: tint, label: single ? (s.short ?? s.mode) : "", labelColor: badge, labelText: readableText(badge), title: rideTitle(s) }));
                    if (single) {
                        features.push(point(s.fromPos[0], s.fromPos[1], { ...base, kind: "station", color: tint, title: s.from }));
                        features.push(point(s.toPos[0], s.toPos[1], { ...base, kind: "station", color: tint, title: s.to }));
                    }
                }
                return;
            }
            const path = lngLat(l.geometry);
            if (path.length < 2) return;
            coords.push(...path);
            const kind = l.mode === "walk" ? "walk" : l.mode === "transit" ? "ride" : "car";
            features.push(line(path, { ...base, kind, color: kind === "walk" && single ? WALK_GRAY : color, label: "", title: legSummary(l, name) }));
        });
        d.stops.forEach((s, si) => {
            const p = registry[s.placeId];
            if (!p) return;
            coords.push([p.lon, p.lat]);
            markers.push({
                key: `${di}:${si}`,
                kind: s.meal ? "meal" : "stop",
                day: di,
                stop: si,
                label: String(si + 1),
                lat: p.lat,
                lon: p.lon,
                color,
                title: `Day ${di + 1} · ${si + 1}. ${s.name} · ${minToHhmm(s.startMin)}–${minToHhmm(s.endMin)}${s.meal ? ` · ${s.meal}` : ""}`,
                offset: [0, 0],
            });
        });
    });

    const hotel = registry[hotelId];
    if (hotel) {
        markers.push({ key: "hotel", kind: "hotel", day: -1, stop: -1, label: "H", lat: hotel.lat, lon: hotel.lon, color: "#111111", title: `Hotel: ${hotel.name}`, offset: [0, 0] });
        if (!single) coords.push([hotel.lon, hotel.lat]);
    }
    // arrival and departure are often the same airport, one marker is enough
    const airports: Place[] = [];
    for (const a of [registry.ARR, registry.DEP]) if (a && !airports.some((q) => q.lat === a.lat && q.lon === a.lon)) airports.push(a);
    for (const a of airports) {
        markers.push({ key: `airport:${a.id}`, kind: "airport", day: -1, stop: -1, label: "✈", lat: a.lat, lon: a.lon, color: "#6b7280", title: a.name, offset: [0, 0] });
    }

    fanOut(markers);
    return { lines: { type: "FeatureCollection", features }, markers, coords };
}

// markers on the same spot, e.g. lunch held at the museum it follows, are spread on a small circle
export function fanOut(markers: MarkerSpec[]) {
    const groups: MarkerSpec[][] = [];
    for (const m of markers) {
        const g = groups.find((grp) => haversineKm(grp[0], m) <= SAME_SPOT_KM);
        if (g) g.push(m);
        else groups.push([m]);
    }
    for (const g of groups) {
        if (g.length < 2) continue;
        g.forEach((m, i) => {
            const angle = (2 * Math.PI * i) / g.length - Math.PI / 2;
            m.offset = [Math.round(Math.cos(angle) * FAN_PX), Math.round(Math.sin(angle) * FAN_PX)];
        });
    }
}

// the bounds of one step: the leg's path and the stop it reaches
export function stepCoords(day: TimedDay, step: number, registry: Registry): Pos[] {
    const leg = day.legs[step];
    if (!leg) return [];
    const path: Pos[] = leg.segments?.length ? leg.segments.flatMap((s) => lngLat(s.geometry)) : lngLat(leg.geometry);
    const to = registry[leg.toId];
    return to ? [...path, [to.lon, to.lat]] : path;
}
