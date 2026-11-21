"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Map as MapLibre, Marker, NavigationControl, Popup, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { dayColor } from "@/lib/colors";
import { buildMapData, daySteps, legSummary, stepCoords, WALK_GRAY, type Collection, type MarkerSpec } from "@/lib/mapData";
import { stopNames } from "@/lib/names";
import type { Evaluation, Registry } from "@/lib/types";

// the bundler breaks maplibre's own worker path, postinstall copies the worker into public
setWorkerUrl("/maplibre-gl-worker.mjs");

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

type Base = "light" | "streets" | "satellite";
type Style = NonNullable<Parameters<MapLibre["setStyle"]>[0]>;

// a quiet light map by default so the routes carry the color; openfreemap is free vector tiles with no key,
// satellite is esri imagery with a label layer
const STYLES: Record<Base, Style> = {
    light: "https://tiles.openfreemap.org/styles/positron",
    streets: "https://tiles.openfreemap.org/styles/liberty",
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

// what the map and the itinerary point at together: one step (a move and the stop it reaches) of one day.
// `from` says who set it; the camera only moves for focus that came from outside the map
export interface Focus {
    day: number;
    step: number;
    from: "map" | "list" | "stepper";
}

interface Props {
    evaluation: Evaluation;
    registry: Registry;
    hotelId: string;
    // the day shown alone, null for every day
    day: number | null;
    onDay: (day: number | null) => void;
    focus: Focus | null;
    onFocus: (focus: Focus | null) => void;
}

const LINE_LAYERS = ["leg-ride", "leg-car", "leg-walk"];

// how strongly each line shows: other days fade while one day is focused or hovered, other legs fade while
// stepping through a day. the inputs live in the map's global state, so a focus change never rebuilds data
const gs = (k: string) => ["global-state", k] as unknown as ExpressionSpecification;
const OPACITY: ExpressionSpecification = [
    "case",
    ["all", [">=", gs("focusDay"), 0], ["!=", ["get", "day"], gs("focusDay")]],
    0.15,
    ["all", [">=", gs("step"), 0], ["!=", ["get", "leg"], gs("step")]],
    0.3,
    ["all", ["<", gs("focusDay"), 0], [">=", gs("hoverDay"), 0], ["!=", ["get", "day"], gs("hoverDay")]],
    0.2,
    1,
];
const IS_STEP: ExpressionSpecification = ["all", [">=", gs("step"), 0], ["==", ["get", "day"], gs("focusDay")], ["==", ["get", "leg"], gs("step")]];
const width = (base: number): ExpressionSpecification => ["case", IS_STEP, base + 2.5, base];

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// a white chevron with a dark edge, drawn once, so direction reads on any route color
function addArrow(map: MapLibre) {
    if (map.hasImage("chevron")) return;
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const draw = () => {
        ctx.beginPath();
        ctx.moveTo(18, 13);
        ctx.lineTo(31, 24);
        ctx.lineTo(18, 35);
        ctx.stroke();
    };
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 9;
    draw();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    draw();
    map.addImage("chevron", ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
}

// adds the route layers, or just swaps their data if they already exist
function drawOverlay(map: MapLibre, data: Collection) {
    const source = map.getSource("trip") as GeoJSONSource | undefined;
    if (source) {
        source.setData(data);
        return;
    }
    addArrow(map);
    map.addSource("trip", { type: "geojson", data });
    const round = { "line-join": "round", "line-cap": "round" } as const;
    const isLine: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
    map.addLayer({
        id: "leg-casing",
        type: "line",
        source: "trip",
        filter: ["all", isLine, ["!=", ["get", "kind"], "walk"]],
        layout: round,
        paint: { "line-color": "#ffffff", "line-width": width(8), "line-opacity": OPACITY, "line-offset": ["get", "offset"] },
    });
    map.addLayer({
        id: "leg-car",
        type: "line",
        source: "trip",
        filter: ["all", isLine, ["==", ["get", "kind"], "car"]],
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": width(4), "line-opacity": OPACITY, "line-offset": ["get", "offset"], "line-dasharray": [2, 1.2] },
    });
    map.addLayer({
        id: "leg-ride",
        type: "line",
        source: "trip",
        filter: ["all", isLine, ["==", ["get", "kind"], "ride"]],
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": width(4.5), "line-opacity": OPACITY, "line-offset": ["get", "offset"] },
    });
    // zero length dashes with round caps draw as dots
    map.addLayer({
        id: "leg-walk",
        type: "line",
        source: "trip",
        filter: ["all", isLine, ["==", ["get", "kind"], "walk"]],
        layout: round,
        paint: { "line-color": ["get", "color"], "line-width": width(4), "line-opacity": OPACITY, "line-offset": ["get", "offset"], "line-dasharray": [0, 1.8] },
    });
    map.addLayer({
        id: "leg-arrows",
        type: "symbol",
        source: "trip",
        filter: ["all", isLine, ["!=", ["get", "kind"], "walk"]],
        layout: {
            "symbol-placement": "line",
            "symbol-spacing": 90,
            "icon-image": "chevron",
            "icon-size": 0.55,
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": OPACITY },
    });
    // line code along each ride in the operator's own colors, e.g. JY or E, a thick halo reads as a badge
    map.addLayer({
        id: "ride-labels",
        type: "symbol",
        source: "trip",
        filter: ["all", isLine, ["==", ["get", "kind"], "ride"], ["!=", ["get", "label"], ""]],
        layout: { "symbol-placement": "line", "symbol-spacing": 240, "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12 },
        paint: { "text-color": ["get", "labelText"], "text-halo-color": ["get", "labelColor"], "text-halo-width": 3, "text-opacity": OPACITY },
    });
    map.addLayer({
        id: "stations",
        type: "circle",
        source: "trip",
        filter: ["==", ["get", "kind"], "station"],
        paint: { "circle-radius": 4, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5, "circle-opacity": OPACITY, "circle-stroke-opacity": OPACITY },
    });
}

function fit(map: MapLibre, coords: [number, number][], maxZoom = 15) {
    if (!coords.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: { top: 70, bottom: 90, left: 50, right: 50 }, maxZoom, duration: reducedMotion() ? 0 : 600 });
}

export default function TripMap({ evaluation, registry, hotelId, day, onDay, focus, onFocus }: Props) {
    const container = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapLibre | null>(null);
    const linesRef = useRef<Collection>({ type: "FeatureCollection", features: [] });
    const markersRef = useRef<{ spec: MarkerSpec; marker: Marker; el: HTMLElement }[]>([]);
    const baseRef = useRef<Base>("light");
    const [base, setBase] = useState<Base>("light");
    const selected = day !== null && day < evaluation.days.length ? day : null;
    const data = useMemo(() => buildMapData(evaluation, registry, hotelId, selected), [evaluation, registry, hotelId, selected]);
    const stepsByDay = useMemo(() => evaluation.days.map((d) => daySteps(d)), [evaluation]);
    const names = useMemo(() => stopNames(evaluation.days), [evaluation]);

    // the latest values for map and marker event handlers, which are attached once
    const live = useRef({ onFocus, focus, day: selected, stepsByDay, hoverDay: -1 });
    useEffect(() => {
        Object.assign(live.current, { onFocus, focus, day: selected, stepsByDay });
    });

    // dims and highlights lines (through global state) and markers (through classes) for focus and hover
    const paint = () => {
        const map = mapRef.current;
        const { focus: f, hoverDay, stepsByDay: steps } = live.current;
        const focusDay = f ? f.day : -1;
        const step = f ? f.step : -1;
        try {
            map?.setGlobalStateProperty("focusDay", focusDay);
            map?.setGlobalStateProperty("step", step);
            map?.setGlobalStateProperty("hoverDay", hoverDay);
        } catch {
            // no style yet; style.load paints again once it is there
        }
        for (const { spec, el } of markersRef.current) {
            const markerStep = spec.day >= 0 ? (steps[spec.day]?.find((s) => s.stop === spec.stop)?.leg ?? -1) : -1;
            const current = f !== null && spec.day === f.day && markerStep === f.step;
            const otherDay = spec.day >= 0 && ((focusDay >= 0 && spec.day !== focusDay) || (focusDay < 0 && hoverDay >= 0 && spec.day !== hoverDay));
            const otherStep = step >= 0 && spec.day === focusDay && !current;
            el.classList.toggle("is-dim", otherDay || otherStep);
            el.classList.toggle("is-current", current);
        }
    };
    const paintRef = useRef(paint);
    useEffect(() => {
        paintRef.current = paint;
    });
    const hover = (d: number) => {
        if (live.current.hoverDay === d) return;
        live.current.hoverDay = d;
        paintRef.current();
    };
    const hoverRef = useRef(hover);
    useEffect(() => {
        hoverRef.current = hover;
    });

    // create the map once
    useEffect(() => {
        const map = new MapLibre({
            container: container.current!,
            style: STYLES.light,
            center: [0, 20],
            zoom: 1,
            globalState: { focusDay: -1, step: -1, hoverDay: -1 },
            attributionControl: { compact: true, customAttribution: 'transit by <a href="https://transitous.org/sources/">Transitous</a>' },
        });
        map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
        // a new background wipes custom layers and global state, so redraw them each time
        map.on("style.load", () => {
            drawOverlay(map, linesRef.current);
            paintRef.current();
        });

        const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "320px" });
        const show = (e: MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f) return;
            map.getCanvas().style.cursor = "pointer";
            popup.setLngLat(e.lngLat).setText(String(f.properties.title)).addTo(map);
            // in the all-days view, pointing at a route brings its whole day forward
            if (live.current.day === null) hoverRef.current(Number(f.properties.day));
        };
        const hide = () => {
            map.getCanvas().style.cursor = "";
            popup.remove();
            hoverRef.current(-1);
        };
        const click = (e: MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (f) live.current.onFocus({ day: Number(f.properties.day), step: Number(f.properties.leg), from: "map" });
        };
        for (const id of LINE_LAYERS) {
            map.on("mousemove", id, show);
            map.on("mouseleave", id, hide);
            map.on("click", id, click);
        }

        mapRef.current = map;
        return () => {
            for (const m of markersRef.current) m.marker.remove();
            markersRef.current = [];
            popup.remove();
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // redraw lines and markers and refit when the plan or the shown day changes
    useEffect(() => {
        linesRef.current = data.lines;
        const map = mapRef.current;
        if (!map) return;
        // before the style has loaded there is no source yet, the style.load handler draws from linesRef
        (map.getSource("trip") as GeoJSONSource | undefined)?.setData(data.lines);

        for (const m of markersRef.current) m.marker.remove();
        markersRef.current = data.markers.map((spec) => {
            // maplibre positions the outer element with a transform, so the visible dot is an inner button
            // that can scale freely
            const el = document.createElement("div");
            const dot = document.createElement("button");
            dot.type = "button";
            dot.className = `trip-marker trip-marker--${spec.kind}`;
            dot.textContent = spec.label;
            dot.title = spec.title;
            dot.setAttribute("aria-label", spec.title);
            dot.style.setProperty("--c", spec.color);
            el.appendChild(dot);
            if (spec.day >= 0) {
                dot.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const step = live.current.stepsByDay[spec.day]?.find((s) => s.stop === spec.stop)?.leg ?? -1;
                    if (step >= 0) live.current.onFocus({ day: spec.day, step, from: "map" });
                });
                dot.addEventListener("mouseenter", () => {
                    if (live.current.day === null) hoverRef.current(spec.day);
                });
                dot.addEventListener("mouseleave", () => hoverRef.current(-1));
            }
            const marker = new Marker({ element: el, offset: spec.offset }).setLngLat([spec.lon, spec.lat]).addTo(map);
            return { spec, marker, el: dot };
        });
        paintRef.current();
        fit(map, data.coords);
    }, [data]);

    // focus: highlight, and bring the step into view unless the click came from the map itself
    useEffect(() => {
        paintRef.current();
        const map = mapRef.current;
        if (!map || !focus || focus.from === "map") return;
        const d = evaluation.days[focus.day];
        if (d) fit(map, stepCoords(d, focus.step, registry), 16);
    }, [focus, evaluation, registry]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || baseRef.current === base) return;
        baseRef.current = base;
        // a full reload always fires style.load, a diffed swap may not
        map.setStyle(STYLES[base], { diff: false });
    }, [base]);

    // the step-through bar for the shown day
    const shownDay = selected !== null ? evaluation.days[selected] : undefined;
    const steps = selected !== null ? stepsByDay[selected] : [];
    const current = focus && focus.day === selected ? focus.step : -1;
    const nameOf = (id: string) => names.get(id) ?? registry[id]?.name ?? id;
    const go = (step: number) => {
        if (selected !== null) onFocus(step < 0 ? null : { day: selected, step, from: "stepper" });
    };
    const next = () => {
        if (steps.length) go(current < 0 ? 0 : Math.min(steps.length - 1, current + 1));
    };
    const prev = () => {
        if (steps.length) go(current < 0 ? steps.length - 1 : Math.max(0, current - 1));
    };

    return (
        <div
            tabIndex={-1}
            onKeyDown={(e) => {
                if (e.key === "ArrowRight" && selected !== null) next();
                else if (e.key === "ArrowLeft" && selected !== null) prev();
                else if (e.key === "Escape") onFocus(null);
                else return;
                e.preventDefault();
            }}
        >
            <div style={{ position: "relative" }}>
                <div ref={container} style={{ height: 540, borderRadius: 8, overflow: "hidden" }} />
                {/* one bar so the two groups wrap instead of overlapping on narrow screens */}
                <div style={bar}>
                    <div style={panel} role="group" aria-label="map style">
                        {(["light", "streets", "satellite"] as const).map((b) => (
                            <button key={b} type="button" style={pill(base === b)} aria-pressed={base === b} onClick={() => setBase(b)}>
                                {b}
                            </button>
                        ))}
                    </div>
                    <div style={panel} role="group" aria-label="days">
                        <button type="button" style={pill(selected === null)} aria-pressed={selected === null} onClick={() => onDay(null)}>
                            all days
                        </button>
                        {evaluation.days.map((d, di) => (
                            <button
                                key={d.date}
                                type="button"
                                style={pill(selected === di)}
                                aria-pressed={selected === di}
                                onClick={() => onDay(di)}
                                onMouseEnter={() => selected === null && hover(di)}
                                onMouseLeave={() => hover(-1)}
                            >
                                <span style={{ ...dot, background: dayColor(di) }} />
                                day {di + 1}
                            </button>
                        ))}
                    </div>
                </div>

                {shownDay && steps.length > 0 && (
                    <div style={stepper} aria-live="polite">
                        <button type="button" style={roundButton} onClick={prev} aria-label="previous step">
                            ‹
                        </button>
                        <div style={{ minWidth: 0, flex: 1, fontSize: 13, lineHeight: 1.3 }}>
                            {current >= 0 && shownDay.legs[current] ? (
                                <>
                                    <b>
                                        Step {current + 1} of {steps.length}
                                    </b>{" "}
                                    <span style={{ color: "#4b5563" }}>{legSummary(shownDay.legs[current], nameOf)}</span>
                                </>
                            ) : (
                                <span style={{ color: "#4b5563" }}>
                                    {steps.length} moves on day {(selected ?? 0) + 1}. Step through them with the arrows, or click a stop or a route.
                                </span>
                            )}
                        </div>
                        <button type="button" style={roundButton} onClick={next} aria-label="next step">
                            ›
                        </button>
                        {current >= 0 && (
                            <button type="button" style={{ ...pill(false), marginLeft: 2 }} onClick={() => go(-1)}>
                                whole day
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* under the map, so it never covers a route */}
            <div style={legendRow} aria-label="legend">
                <span style={legendItem}>
                    <svg width="30" height="10" aria-hidden>
                        <line x1="2" y1="5" x2="28" y2="5" stroke={dayColor(0)} strokeWidth="4" strokeLinecap="round" />
                    </svg>
                    transit
                </span>
                <span style={legendItem}>
                    <svg width="30" height="10" aria-hidden>
                        <line x1="3" y1="5" x2="28" y2="5" stroke={WALK_GRAY} strokeWidth="4" strokeLinecap="round" strokeDasharray="0 7" />
                    </svg>
                    walk
                </span>
                <span style={legendItem}>
                    <svg width="30" height="10" aria-hidden>
                        <line x1="2" y1="5" x2="28" y2="5" stroke={dayColor(0)} strokeWidth="4" strokeDasharray="7 4" />
                    </svg>
                    taxi or car
                </span>
                <span style={legendItem}>
                    <span className="trip-marker trip-marker--stop trip-marker--legend" style={{ ["--c" as string]: dayColor(0) }}>
                        1
                    </span>
                    sight, in visiting order
                </span>
                <span style={legendItem}>
                    <span className="trip-marker trip-marker--meal trip-marker--legend" style={{ ["--c" as string]: dayColor(0) }}>
                        2
                    </span>
                    meal
                </span>
                <span style={legendItem}>
                    <span className="trip-marker trip-marker--hotel trip-marker--legend">H</span>
                    hotel
                </span>
                <span style={{ ...legendItem, color: "#4b5563" }}>arrows show the direction of travel; hover a route for details, click a stop or route to focus it</span>
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

const stepper: CSSProperties = {
    position: "absolute",
    left: "50%",
    bottom: 34,
    transform: "translateX(-50%)",
    width: "min(560px, calc(100% - 120px))",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    background: "#ffffff",
    color: "#111111",
    borderRadius: 10,
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
};

const legendRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center", margin: "6px 2px", fontSize: 12 };
const legendItem: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };

const roundButton: CSSProperties = {
    width: 30,
    height: 30,
    flex: "none",
    border: "1px solid #d1d5db",
    borderRadius: "50%",
    background: "#ffffff",
    color: "#111111",
    font: "inherit",
    fontSize: 20,
    lineHeight: "26px",
    padding: 0,
    cursor: "pointer",
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
