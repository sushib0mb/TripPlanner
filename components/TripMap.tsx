"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Map as MapLibre, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DAY_COLORS, readableText } from "@/lib/colors";
import { minToHhmm } from "@/lib/time";
import type { Evaluation, Registry, Segment } from "@/lib/types";

// the bundler breaks maplibre's own worker path, postinstall copies the worker into public
setWorkerUrl("/maplibre-gl-worker.mjs");

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

type Base = "streets" | "light" | "satellite";
type Style = NonNullable<Parameters<MapLibre["setStyle"]>[0]>;
type Collection = GeoJSON.FeatureCollection;

// openfreemap is free vector tiles with no key, satellite is esri imagery with a label layer
const STYLES: Record<Base, Style> = {
    streets: "https://tiles.openfreemap.org/styles/liberty",
    light: "https://tiles.openfreemap.org/styles/positron",
    satellite: {
        version: 8,
        glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
        sources: {
            imagery: {
                type: "raster",
                tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
                tileSize: 256,
                maxzoom: 19,
                attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
            },
            labels: { type: "raster", tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
        },
        layers: [
            { id: "imagery", type: "raster", source: "imagery" },
            { id: "labels", type: "raster", source: "labels" },
        ],
    },
};

const HOVER_LAYERS = ["points", "stations", "leg-ride", "leg-ride-dash", "leg-car", "leg-walk"];
const WALK_GRAY = "#4b5563";
// consecutive rides in one day alternate between darker and lighter versions of the day color
const SHADES = [0, -0.4, 0.35, -0.6, 0.55];

// negative mixes toward black, positive toward white
function shade(hex: string, amount: number) {
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return "#" + channels.map((c) => Math.round(c + (target - c) * p).toString(16).padStart(2, "0")).join("");
}

interface Props {
    evaluation: Evaluation;
    registry: Registry;
    hotelId: string;
}

type Pos = [number, number];

const lngLat = (path: Pos[]) => path.map(([lat, lon]) => [lon, lat] as Pos);

type FeatureProps = Record<string, string | number>;

function point(lat: number, lon: number, props: FeatureProps): GeoJSON.Feature {
    return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props };
}

function line(path: Pos[], props: FeatureProps): GeoJSON.Feature {
    return { type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: props };
}

function rideTitle(s: Segment) {
    const name = s.line && s.short && s.short !== s.line ? `${s.line} (${s.short})` : (s.line ?? s.mode);
    const toward = s.headsign ? ` toward ${s.headsign}` : "";
    return `${name}${toward} · ${s.from} → ${s.to} · ${s.stops + 1} stop${s.stops > 0 ? "s" : ""} · ${minToHhmm(s.departMin)}–${minToHhmm(s.arriveMin)}`;
}

// geojson for the visible days plus the coordinates to fit the view to
// all days draws rides dashed so overlapping days stay visible,
// one day draws each ride in its own shade of the day color with line codes and stations
function buildData(evaluation: Evaluation, registry: Registry, hotelId: string, selected: number | null) {
    const features: GeoJSON.Feature[] = [];
    const coords: Pos[] = [];
    const single = selected !== null;
    const shown = new Map(evaluation.days.flatMap((d) => d.stops.map((s) => [s.placeId, s.name] as const)));
    const name = (id: string) => shown.get(id) ?? registry[id]?.name ?? "";
    // a small sideways shift in the day view keeps out and back legs on the same track apart
    const offset = single ? 2.5 : 0;
    evaluation.days.forEach((d, di) => {
        if (single && di !== selected) return;
        const color = DAY_COLORS[di % DAY_COLORS.length];
        let ride = 0;
        for (const l of d.legs) {
            if (l.segments?.length) {
                for (const s of l.segments) {
                    const path = lngLat(s.geometry);
                    coords.push(...path);
                    if (s.mode === "walk") {
                        const title = `walk ${Math.round(s.arriveMin - s.departMin)} min · ${s.from} → ${s.to}`;
                        features.push(line(path, { kind: "walk", color: single ? WALK_GRAY : color, offset, title }));
                        continue;
                    }
                    const tint = single ? shade(color, SHADES[ride++ % SHADES.length]) : color;
                    const label = single ? (s.short ?? s.mode) : "";
                    const props = { kind: "ride", dash: single ? 0 : 1, color: tint, offset, label, labelColor: s.color ?? tint, labelText: readableText(s.color ?? tint) };
                    features.push(line(path, { ...props, title: rideTitle(s) }));
                    if (single) {
                        features.push(point(s.fromPos[0], s.fromPos[1], { kind: "station", color: tint, label: "", title: s.from }));
                        features.push(point(s.toPos[0], s.toPos[1], { kind: "station", color: tint, label: "", title: s.to }));
                    }
                }
                continue;
            }
            const path = lngLat(l.geometry);
            coords.push(...path);
            const kind = l.mode === "walk" ? "walk" : l.mode === "transit" ? "ride" : "car";
            const title = `${l.mode} ${Math.round(l.minutes)} min · ${name(l.fromId)} → ${name(l.toId)}`;
            features.push(line(path, { kind, dash: single ? 0 : 1, color: kind === "walk" && single ? WALK_GRAY : color, offset, label: "", title }));
        }
        d.stops.forEach((s, si) => {
            const p = registry[s.placeId];
            if (!p) return;
            coords.push([p.lon, p.lat]);
            features.push(point(p.lat, p.lon, { kind: "stop", color, label: String(si + 1), title: `${di + 1}.${si + 1} ${s.name}` }));
        });
    });
    const hotel = registry[hotelId];
    if (hotel) {
        features.push(point(hotel.lat, hotel.lon, { kind: "hotel", color: "#111111", label: "H", title: `hotel: ${hotel.name}` }));
        if (!single) coords.push([hotel.lon, hotel.lat]);
    }
    const arr = registry.ARR;
    const dep = registry.DEP;
    if (arr) features.push(point(arr.lat, arr.lon, { kind: "airport", color: "#6b7280", label: "", title: arr.name }));
    if (dep && (!arr || dep.lat !== arr.lat || dep.lon !== arr.lon)) {
        features.push(point(dep.lat, dep.lon, { kind: "airport", color: "#6b7280", label: "", title: dep.name }));
    }
    return { data: { type: "FeatureCollection", features } as Collection, coords };
}

// adds the route layers, or just swaps their data if they already exist
function drawOverlay(map: MapLibre, data: Collection) {
    const source = map.getSource("trip") as GeoJSONSource | undefined;
    if (source) {
        source.setData(data);
        return;
    }
    map.addSource("trip", { type: "geojson", data });
    const round = { "line-join": "round", "line-cap": "round" } as const;
    map.addLayer({
        id: "leg-casing",
        type: "line",
        source: "trip",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: round,
        paint: { "line-color": "#ffffff", "line-width": 7.5, "line-opacity": 0.85, "line-offset": ["get", "offset"] },
    });
    map.addLayer({
        id: "leg-car",
        type: "line",
        source: "trip",
        filter: ["==", ["get", "kind"], "car"],
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4, "line-offset": ["get", "offset"], "line-dasharray": [2, 1] },
    });
    map.addLayer({
        id: "leg-ride",
        type: "line",
        source: "trip",
        filter: ["all", ["==", ["get", "kind"], "ride"], ["==", ["get", "dash"], 0]],
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": 5, "line-offset": ["get", "offset"] },
    });
    // dashes let a day underneath show through where routes overlap
    map.addLayer({
        id: "leg-ride-dash",
        type: "line",
        source: "trip",
        filter: ["all", ["==", ["get", "kind"], "ride"], ["==", ["get", "dash"], 1]],
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4.5, "line-dasharray": [2, 1] },
    });
    // zero length dashes with round caps draw as dots
    map.addLayer({
        id: "leg-walk",
        type: "line",
        source: "trip",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "kind"], "walk"]],
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": 4, "line-offset": ["get", "offset"], "line-dasharray": [0, 1.8] },
    });
    // line code along each ride in the operator's own colors, e.g. JY or E, a thick halo reads as a badge
    map.addLayer({
        id: "ride-labels",
        type: "symbol",
        source: "trip",
        filter: ["all", ["==", ["get", "kind"], "ride"], ["!=", ["get", "label"], ""]],
        layout: { "symbol-placement": "line", "symbol-spacing": 220, "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 13 },
        paint: { "text-color": ["get", "labelText"], "text-halo-color": ["get", "labelColor"], "text-halo-width": 3 },
    });
    map.addLayer({
        id: "stations",
        type: "circle",
        source: "trip",
        filter: ["==", ["get", "kind"], "station"],
        paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 3 },
    });
    map.addLayer({
        id: "points",
        type: "circle",
        source: "trip",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "kind"], "station"]],
        paint: {
            "circle-radius": ["match", ["get", "kind"], "stop", 11, "hotel", 11, 8],
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2.5,
        },
    });
    map.addLayer({
        id: "point-labels",
        type: "symbol",
        source: "trip",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "label"], ""]],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#ffffff" },
    });
}

function fit(map: MapLibre, coords: [number, number][]) {
    if (!coords.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 600 });
}

export default function TripMap({ evaluation, registry, hotelId }: Props) {
    const container = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapLibre | null>(null);
    const dataRef = useRef<Collection>({ type: "FeatureCollection", features: [] });
    const baseRef = useRef<Base>("streets");
    // null shows every day
    const [day, setDay] = useState<number | null>(null);
    const [base, setBase] = useState<Base>("streets");
    const selected = day !== null && day < evaluation.days.length ? day : null;

    // create the map once
    useEffect(() => {
        const map = new MapLibre({
            container: container.current!,
            style: STYLES.streets,
            center: [0, 20],
            zoom: 1,
            attributionControl: { compact: true, customAttribution: 'transit by <a href="https://transitous.org/sources/">Transitous</a>' },
        });
        map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
        // a new background wipes custom layers, so redraw them each time
        map.on("style.load", () => drawOverlay(map, dataRef.current));

        const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12 });
        const show = (e: MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f) return;
            map.getCanvas().style.cursor = "pointer";
            popup.setLngLat(e.lngLat).setText(String(f.properties.title)).addTo(map);
        };
        const hide = () => {
            map.getCanvas().style.cursor = "";
            popup.remove();
        };
        for (const id of HOVER_LAYERS) {
            map.on("mousemove", id, show);
            map.on("mouseleave", id, hide);
        }

        mapRef.current = map;
        return () => {
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // redraw and refit when the plan or the selected day changes
    useEffect(() => {
        const { data, coords } = buildData(evaluation, registry, hotelId, selected);
        dataRef.current = data;
        const map = mapRef.current;
        if (!map) return;
        // before the style has loaded there is no source yet, the style.load handler draws from dataRef
        (map.getSource("trip") as GeoJSONSource | undefined)?.setData(data);
        fit(map, coords);
    }, [evaluation, registry, hotelId, selected]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || baseRef.current === base) return;
        baseRef.current = base;
        // a full reload always fires style.load, a diffed swap may not
        map.setStyle(STYLES[base], { diff: false });
    }, [base]);

    return (
        <div style={{ position: "relative" }}>
            <div ref={container} style={{ height: 520, borderRadius: 8, overflow: "hidden" }} />
            {/* one bar so the two groups wrap instead of overlapping on narrow screens */}
            <div style={bar}>
                <div style={panel}>
                    {(["streets", "light", "satellite"] as const).map((b) => (
                        <button key={b} style={pill(base === b)} onClick={() => setBase(b)}>
                            {b}
                        </button>
                    ))}
                </div>
                <div style={panel}>
                    <button style={pill(selected === null)} onClick={() => setDay(null)}>
                        all days
                    </button>
                    {evaluation.days.map((d, di) => (
                        <button key={d.date} style={pill(selected === di)} onClick={() => setDay(di)}>
                            <span style={{ ...dot, background: DAY_COLORS[di % DAY_COLORS.length] }} />
                            day {di + 1}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

// the bar lets map drags through, only the panels take clicks
const bar: CSSProperties = {
    position: "absolute",
    top: 10,
    left: 10,
    right: 10,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 6,
    pointerEvents: "none",
};

const panel: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    pointerEvents: "auto",
    gap: 2,
    padding: 3,
    background: "#ffffff",
    borderRadius: 8,
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.2)",
};

const dot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", display: "inline-block" };

function pill(active: boolean): CSSProperties {
    return {
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: "none",
        borderRadius: 6,
        padding: "5px 10px",
        font: "inherit",
        fontSize: 13,
        cursor: "pointer",
        background: active ? "#111111" : "transparent",
        color: active ? "#ffffff" : "#222222",
    };
}
