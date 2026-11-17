"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { DAY_COLORS } from "@/lib/colors";
import type { Evaluation, Registry } from "@/lib/types";

const DASH: Record<string, string | undefined> = { transit: "8 6", walk: "2 6" };

interface Props {
    evaluation: Evaluation;
    registry: Registry;
    hotelId: string;
}

function FitBounds({ points }: { points: [number, number][] }) {
    const map = useMap();
    useEffect(() => {
        if (points.length) map.fitBounds(points, { padding: [20, 20] });
    }, [map, points]);
    return null;
}

export default function TripMap({ evaluation, registry, hotelId }: Props) {
    const hotel = registry[hotelId];
    // only refit the view when the plan changes
    const points = useMemo(() => {
        const pts: [number, number][] = evaluation.days.flatMap((d) => d.legs.flatMap((l) => l.geometry));
        if (hotel) pts.push([hotel.lat, hotel.lon]);
        return pts;
    }, [evaluation, hotel]);

    return (
        <MapContainer center={hotel ? [hotel.lat, hotel.lon] : [0, 0]} zoom={12} style={{ height: 520 }}>
            <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, transit by <a href="https://transitous.org/sources/">Transitous</a>'
            />
            <FitBounds points={points} />
            {evaluation.days.map((d, di) =>
                d.legs.map((l, li) => (
                    <Polyline
                        key={`${di}-${li}`}
                        positions={l.geometry}
                        pathOptions={{ color: DAY_COLORS[di % DAY_COLORS.length], weight: 4, dashArray: DASH[l.mode] }}
                    >
                        <Tooltip sticky>
                            day {di + 1}: {l.mode} {Math.round(l.minutes)} min {l.lines.join(", ")}
                        </Tooltip>
                    </Polyline>
                )),
            )}
            {evaluation.days.map((d, di) =>
                d.stops.map((s, si) => {
                    const p = registry[s.placeId];
                    if (!p) return null;
                    return (
                        <CircleMarker key={`${di}-s${si}`} center={[p.lat, p.lon]} radius={7} pathOptions={{ color: DAY_COLORS[di % DAY_COLORS.length] }}>
                            <Tooltip>
                                {di + 1}.{si + 1} {s.name}
                            </Tooltip>
                        </CircleMarker>
                    );
                }),
            )}
            {hotel && (
                <CircleMarker center={[hotel.lat, hotel.lon]} radius={9} pathOptions={{ color: "black" }}>
                    <Tooltip permanent>hotel</Tooltip>
                </CircleMarker>
            )}
            {(["ARR", "DEP"] as const).map(
                (k) =>
                    registry[k] && (
                        <CircleMarker key={k} center={[registry[k].lat, registry[k].lon]} radius={9} pathOptions={{ color: "gray" }}>
                            <Tooltip>{registry[k].name}</Tooltip>
                        </CircleMarker>
                    ),
            )}
        </MapContainer>
    );
}
