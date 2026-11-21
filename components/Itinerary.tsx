"use client";

import { useEffect, useRef } from "react";
import { dayColor, readableText } from "@/lib/colors";
import { daySteps } from "@/lib/mapData";
import { stopNames } from "@/lib/names";
import { minToHhmm } from "@/lib/time";
import type { Evaluation, Leg, Registry, Segment, TimedStop } from "@/lib/types";
import type { Focus } from "./TripMap";

// line code in the operator's own colors, like station signage
function LineBadge({ s }: { s: Segment }) {
    return (
        <b style={{ background: s.color ?? "#555555", color: readableText(s.color ?? "#555555"), padding: "0 5px", borderRadius: 3 }}>
            {s.short ?? s.mode}
        </b>
    );
}

interface Props {
    evaluation: Evaluation;
    registry: Registry;
    currency: string;
    busy: boolean;
    // the stop's position in its day of the draft, which stays right when a meal shares a sight's place id
    onRemove: (date: string, index: number) => void;
    // the scheduler's one-line reason per day, e.g. "Fenway + Back Bay"
    reasons?: Record<string, string>;
    focus: Focus | null;
    onFocus: (focus: Focus | null) => void;
}

type Item = { t: number; step: number; leg?: Leg; stop?: TimedStop; number?: number };

export default function Itinerary({ evaluation, registry, currency, busy, onRemove, reasons, focus, onFocus }: Props) {
    // stops carry the english name, the registry may only have the local one
    const shown = stopNames(evaluation.days);
    const name = (id: string) => shown.get(id) ?? registry[id]?.name ?? id;
    const t = evaluation.totals;
    const current = useRef<HTMLLIElement>(null);

    // a stop clicked on the map scrolls into view here; focus set from this list leaves the scroll alone
    useEffect(() => {
        if (focus?.from !== "list") current.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, [focus]);

    return (
        <div>
            <h3>problems</h3>
            {evaluation.issues.length === 0 && <p>none</p>}
            <ul>
                {evaluation.issues.map((i, n) => (
                    <li key={n}>
                        <b>{i.level}</b> {i.day} {i.message}
                    </li>
                ))}
            </ul>

            <h3>budget</h3>
            <p>
                activities {Math.round(t.activities)} + transport {Math.round(t.transport)}
                {t.car > 0 && <> + car {Math.round(t.car)}</>} = {Math.round(t.total)} of {t.budget} {currency} (estimates)
            </p>

            {evaluation.days.map((d, di) => {
                const color = dayColor(di);
                const steps = daySteps(d);
                const stepOf = new Map(steps.filter((s) => s.stop !== null).map((s) => [s.stop!, s.leg]));
                // legs and stops in time order, leaving out moves that stay in one place, like a lunch break at a museum
                const items: Item[] = [
                    ...d.legs.flatMap((leg, li) => (leg.fromId !== leg.toId ? [{ t: leg.departMin, step: li, leg }] : [])),
                    ...d.stops.map((stop, si) => ({ t: stop.arriveMin, step: stepOf.get(si) ?? -1, stop, number: si + 1 })),
                ];
                items.sort((a, b) => a.t - b.t || (a.leg ? -1 : 1));
                const isCurrent = (it: Item) => focus !== null && focus.day === di && focus.step === it.step && it.step >= 0;
                const select = (it: Item) => it.step >= 0 && onFocus(isCurrent(it) ? null : { day: di, step: it.step, from: "list" });
                return (
                    <div key={d.date}>
                        <h3 style={{ color }}>
                            day {di + 1}, {d.date}
                        </h3>
                        {reasons?.[d.date] && <p>{reasons[d.date]}</p>}
                        <ul style={{ listStyle: "none", paddingLeft: 8 }}>
                            {items.map((it) => {
                                const here = isCurrent(it);
                                const key = it.leg ? `leg-${it.step}` : `stop-${it.stop!.index}`;
                                // a move and the stop it reaches are one step; the stop row carries the highlight ref
                                const ref = here && (it.stop !== undefined || steps[it.step]?.stop === null) ? current : undefined;
                                return it.leg ? (
                                    <li key={key} ref={ref} className={`itinerary-row${here ? " is-current" : ""}`} style={{ ["--c" as string]: color }}>
                                        <button type="button" className="row-link" onClick={() => select(it)} aria-pressed={here}>
                                            {minToHhmm(it.leg.departMin)} {it.leg.mode} {Math.round(it.leg.minutes)} min {name(it.leg.fromId)} → {name(it.leg.toId)}
                                        </button>
                                        {it.leg.lines.length > 0 && <> ({it.leg.lines.join(", ")})</>}
                                        {it.leg.cost > 0 && <>, {Math.round(it.leg.cost)} {currency}</>} [time: {it.leg.timeSource}]
                                        {it.leg.note && <i> {it.leg.note}</i>}
                                        {it.leg.segments && (
                                            <ul>
                                                {it.leg.segments.map((s, si) =>
                                                    s.mode === "walk" ? (
                                                        <li key={si}>
                                                            {minToHhmm(s.departMin)} walk {Math.round(s.arriveMin - s.departMin)} min to {s.to}
                                                        </li>
                                                    ) : (
                                                        <li key={si}>
                                                            {minToHhmm(s.departMin)}-{minToHhmm(s.arriveMin)} <LineBadge s={s} /> {s.line}
                                                            {s.headsign && <> toward {s.headsign}</>}, {s.from} → {s.to}, {s.stops + 1} stop{s.stops > 0 && "s"}
                                                        </li>
                                                    ),
                                                )}
                                            </ul>
                                        )}
                                    </li>
                                ) : (
                                    <li key={key} ref={ref} className={`itinerary-row${here ? " is-current" : ""}`} style={{ ["--c" as string]: color }}>
                                        <span className={`trip-marker trip-marker--badge trip-marker--${it.stop!.meal ? "meal" : "stop"}`} style={{ ["--c" as string]: color, marginRight: 6 }} aria-hidden>
                                            {it.number}
                                        </span>
                                        <button type="button" className="row-link" onClick={() => select(it)} aria-pressed={here}>
                                            <b>
                                                {minToHhmm(it.stop!.startMin)}-{minToHhmm(it.stop!.endMin)} {it.stop!.name}
                                            </b>
                                        </button>{" "}
                                        [hours: {it.stop!.hours}]{it.stop!.cost > 0 && <>, {Math.round(it.stop!.cost)} {currency}</>}
                                        {it.stop!.note && <i> {it.stop!.note}</i>}{" "}
                                        <button type="button" disabled={busy} onClick={() => onRemove(d.date, it.stop!.index)}>
                                            remove
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                );
            })}
            <p>
                timezone {evaluation.timezone}, {evaluation.transitCalls} transit lookups
            </p>
        </div>
    );
}
