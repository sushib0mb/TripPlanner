"use client";

import { DAY_COLORS } from "@/lib/colors";
import { minToHhmm } from "@/lib/time";
import type { Evaluation, Leg, Registry, TimedStop } from "@/lib/types";

interface Props {
    evaluation: Evaluation;
    registry: Registry;
    currency: string;
    busy: boolean;
    onRemove: (date: string, placeId: string) => void;
}

type Item = { t: number; leg?: Leg; stop?: TimedStop };

export default function Itinerary({ evaluation, registry, currency, busy, onRemove }: Props) {
    const name = (id: string) => registry[id]?.name ?? id;
    const t = evaluation.totals;

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
                // legs and stops in time order
                const items: Item[] = [...d.legs.map((leg) => ({ t: leg.departMin, leg })), ...d.stops.map((stop) => ({ t: stop.arriveMin, stop }))];
                items.sort((a, b) => a.t - b.t || (a.leg ? -1 : 1));
                return (
                    <div key={d.date}>
                        <h3 style={{ color: DAY_COLORS[di % DAY_COLORS.length] }}>
                            day {di + 1}, {d.date}
                        </h3>
                        <ul>
                            {items.map((it, n) =>
                                it.leg ? (
                                    <li key={n}>
                                        {minToHhmm(it.leg.departMin)} {it.leg.mode} {Math.round(it.leg.minutes)} min {name(it.leg.fromId)} → {name(it.leg.toId)}
                                        {it.leg.lines.length > 0 && <> ({it.leg.lines.join(", ")})</>}
                                        {it.leg.cost > 0 && <>, {Math.round(it.leg.cost)} {currency}</>} [time: {it.leg.timeSource}]
                                        {it.leg.note && <i> {it.leg.note}</i>}
                                    </li>
                                ) : (
                                    <li key={n}>
                                        <b>
                                            {minToHhmm(it.stop!.startMin)}-{minToHhmm(it.stop!.endMin)} {it.stop!.name}
                                        </b>{" "}
                                        [hours: {it.stop!.hours}]{it.stop!.cost > 0 && <>, {Math.round(it.stop!.cost)} {currency}</>}
                                        {it.stop!.note && <i> {it.stop!.note}</i>}{" "}
                                        <button disabled={busy} onClick={() => onRemove(d.date, it.stop!.placeId)}>
                                            remove
                                        </button>
                                    </li>
                                ),
                            )}
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
