import { evaluatePlan } from "./checker";
import { haversineKm } from "./geo";
import { estimate } from "./rules";
import { legKey, schedule, type TravelFeedback } from "./scheduler";
import type { Draft, DraftDay, DraftStop, Evaluation, Intake, Issue, IssueCode, Place, Registry, Shortlist, ShortlistItem } from "./types";

// the scheduler plans with estimated travel times because asking real transit for every candidate order would
// take minutes. this module closes the loop: check the plan once with real timetables, and if anything fails,
// schedule again with the real times just seen, then make small local fixes only as a last resort. what still
// fails is reported, never hidden

// errors a dropped nice-to-have can fix; anything else (no dinner, too short, out of range, budget) needs a
// different plan rather than a smaller one
const FIXED_BY_DROPPING = new Set<IssueCode>(["missed_start", "day_too_long", "misses_flight", "closed"]);
// rounds of dropping after the real-time reschedule. each round costs one more transit check
const MAX_DROP_ROUNDS = 1;
// the observed transit speed relative to the estimate is clamped to this range, a few odd legs (a long wait,
// a lucky express) should not swing the whole plan
const FACTOR_RANGE: [number, number] = [0.6, 1.8];
const MIN_FACTOR_SAMPLES = 3;

export interface Verified {
    draft: Draft;
    evaluation: Evaluation;
    // what was changed automatically, in words for the traveler and the agent
    adjustments: string[];
    // errors still in the final plan
    unresolved: Issue[];
}

export interface VerifyOptions {
    log?: (msg: string) => void;
    // restaurants already chosen per meal slot, kept when the days are arranged again
    meals?: Map<string, ShortlistItem>;
    signal?: AbortSignal;
}

const errors = (ev: Evaluation) => ev.issues.filter((i) => i.level === "error");

// lower is better: any error outweighs every warning
export const planScore = (ev: Evaluation) => errors(ev).length * 100 + ev.issues.length;

// real door-to-door times from a check, for the scheduler to plan with
export function feedbackFrom(ev: Evaluation, registry: Registry): TravelFeedback {
    const legs: TravelFeedback["legs"] = new Map();
    const ratios: number[] = [];
    for (const d of ev.days) {
        for (const l of d.legs) {
            if (l.timeSource === "estimate" || l.fromId === l.toId) continue;
            legs.set(legKey(l.fromId, l.toId), { minutes: l.minutes, walk: l.mode === "walk" });
            const a = registry[l.fromId];
            const b = registry[l.toId];
            if (l.mode === "transit" && a && b) ratios.push(l.minutes / estimate.transitMin(haversineKm(a, b)));
        }
    }
    ratios.sort((x, y) => x - y);
    const median = ratios.length >= MIN_FACTOR_SAMPLES ? ratios[Math.floor(ratios.length / 2)] : 1;
    return { legs, transitFactor: Math.min(FACTOR_RANGE[1], Math.max(FACTOR_RANGE[0], median)) };
}

// which nice-to-have to drop from a day that still fails with real transit times, as an index into `stops`,
// or -1 to drop nothing and leave the error to the report. `candidates` are the day's droppable stops (nice
// priority, not meals) with their index in `stops`; `issues` are the day's errors this round can fix
// (missed_start, day_too_long, misses_flight, closed); `registry` has every place's coordinates
export function dropCandidate(candidates: { stop: DraftStop; index: number }[], issues: Issue[], stops: DraftStop[], registry: Registry): number {
    // travel a stop adds to the day: getting to it and on from it, minus going straight past it
    const at = (i: number) => (i >= 0 && i < stops.length ? registry[stops[i].place_id] : undefined);
    const ride = (a?: Place, b?: Place) => (a && b ? estimate.transitMin(haversineKm(a, b)) : 0);
    const detour = (i: number) => {
        const prev = at(i - 1);
        const here = at(i);
        const next = at(i + 1);
        return ride(prev, here) + ride(here, next) - (prev && next ? ride(prev, next) : 0);
    };
    const saving = (c: { stop: DraftStop; index: number }) => c.stop.duration_min + Math.max(0, detour(c.index));

    // a stop reached too late: only what comes before it made the traveler late, so cut from there
    const late = issues.find((i) => i.code === "missed_start" && i.placeId);
    const lateAt = late ? stops.findIndex((s) => s.place_id === late.placeId) : -1;
    const pool = lateAt > 0 ? candidates.filter((c) => c.index < lateAt) : candidates;

    // otherwise the stop whose removal frees the most time fixes a long day or a tight flight soonest
    const best = [...(pool.length ? pool : candidates)].sort((a, b) => saving(b) - saving(a))[0];
    return best ? best.index : -1;
}

const placesOf = (d: Draft) => new Set(d.days.flatMap((day) => day.stops.filter((s) => !s.meal).map((s) => s.place_id)));

export async function verify(intake: Intake, list: Shortlist, draft: Draft, registry: Registry, opts: VerifyOptions = {}): Promise<Verified> {
    const log = opts.log ?? (() => {});
    const check = (d: Draft) => evaluatePlan(intake, d, registry, { log, keepApart: list.apart, signal: opts.signal });
    const items = new Map(list.items.map((i) => [i.place_id, i]));
    const nameOf = (id: string) => items.get(id)?.name_en ?? registry[id]?.name ?? id;
    const adjustments: string[] = [];
    let evaluation = await check(draft);

    // 1. arrange the days again with the real times this check just measured
    if (errors(evaluation).length) {
        const feedback = feedbackFrom(evaluation, registry);
        log(`rescheduling with ${feedback.legs.size} real travel times (transit runs ${feedback.transitFactor.toFixed(2)}x the estimate)`);
        const again = await schedule(intake, list, registry, { previous: draft, fixedMeals: opts.meals, feedback });
        opts.signal?.throwIfAborted();
        const evAgain = await check(again.draft);
        if (planScore(evAgain) < planScore(evaluation)) {
            const before = placesOf(draft);
            const after = placesOf(again.draft);
            const lost = [...before].filter((id) => !after.has(id));
            adjustments.push(`re-arranged the days with real transit times${lost.length ? `, leaving out ${lost.map(nameOf).join(", ")}` : ""}`);
            draft = again.draft;
            evaluation = evAgain;
        }
    }

    // 2. last resort: on each day that still fails for a reason a smaller day can fix, drop one nice-to-have
    for (let round = 0; round < MAX_DROP_ROUNDS; round++) {
        const fixable = errors(evaluation).filter((i) => i.day && FIXED_BY_DROPPING.has(i.code));
        if (!fixable.length) break;
        let changed = false;
        const days: DraftDay[] = draft.days.map((d) => {
            const mine = fixable.filter((i) => i.day === d.date);
            if (!mine.length) return d;
            const nice = (id: string) => items.get(id)?.priority === "nice";
            // a closed place goes first when it may; otherwise the policy below picks one
            const closed = mine.find((i) => i.code === "closed" && i.placeId && nice(i.placeId));
            const closedAt = closed ? d.stops.findIndex((s) => !s.meal && s.place_id === closed.placeId) : -1;
            const candidates = d.stops.flatMap((stop, index) => (!stop.meal && nice(stop.place_id) ? [{ stop, index }] : []));
            const index = closedAt >= 0 ? closedAt : dropCandidate(candidates, mine, d.stops, registry);
            if (index < 0) return d;
            changed = true;
            const stop = d.stops[index];
            adjustments.push(`${d.date}: dropped ${stop.name_en ?? nameOf(stop.place_id)} so the day works with real transit times`);
            return { ...d, stops: d.stops.filter((_, i) => i !== index) };
        });
        if (!changed) break;
        draft = { ...draft, days };
        log(`rechecking after ${adjustments.length} automatic fixes`);
        evaluation = await check(draft);
    }

    const unresolved = errors(evaluation);
    for (const e of unresolved) adjustments.push(`could not fix automatically: ${e.day ? `${e.day} ` : ""}${e.message}`);
    return { draft, evaluation, adjustments, unresolved };
}
