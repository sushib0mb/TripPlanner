import { haversineKm, localToUtc, timezoneAt } from "./geo";
import { hoursState } from "./hours";
import { osrmRoute, transitRoute } from "./routing";
import {
    AIRPORT_BEFORE_DEP_MIN,
    AIRPORT_EXIT_MIN,
    DINNER,
    DINNER_IF_AIRPORT_BY,
    DINNER_IF_HOTEL_BY,
    estimate,
    LUNCH,
    LUNCH_EARLIEST,
    LUNCH_LATEST,
    MISSED_START_SLACK_MIN,
    PACE_DAY,
} from "./rules";
import { addDays, hhmmToMin, minToHhmm } from "./time";
import type { Draft, Evaluation, Intake, Issue, Leg, Place, Registry, TimedDay, TimedStop } from "./types";

const MAX_WAIT_MIN = 60;
const MAX_FALLBACK_WALK_MIN = 60;
// agencies publish timetables only a few weeks ahead (the mbta's ended 25 days out), so later
// dates borrow the same weekday from the soonest week inside this many days
const TIMETABLE_HORIZON_DAYS = 14;

interface Ctx {
    intake: Intake;
    draft: Draft;
    tz: string;
    issues: Issue[];
    transitCalls: number;
    // today in the destination, and trip dates whose transit used another week's timetable
    today: string;
    borrowed: Map<string, string>;
    log: (msg: string) => void;
}

export interface EvaluateOptions {
    log?: (msg: string) => void;
    // place ids the traveler asked to keep on different days, so splitting them is not flagged
    keepApart?: string[][];
    signal?: AbortSignal;
}

// sights this close on different days are worth visiting together, e.g. the mfa and the gardner, 400 m apart
const SPLIT_KM = 0.6;
const MAX_SPLIT_WARNINGS = 4;
// a day that spends more than this share of its time moving between places is poorly grouped
const TRAVEL_SHARE = 0.3;

// warnings only: a split can be deliberate, e.g. a museum that is open late on one day
function groupingWarnings(days: TimedDay[], registry: Registry, keepApart: string[][]): Issue[] {
    const apart = (a: string, b: string) => keepApart.some((g) => g.includes(a) && g.includes(b));
    const issues: Issue[] = [];
    // meals left out, there is a restaurant near something on most days
    const sights = days.flatMap((d) => d.stops.filter((s) => !s.meal && registry[s.placeId]).map((s) => ({ s, date: d.date, p: registry[s.placeId] })));
    const splits: { km: number; message: string; date: string; placeId: string }[] = [];
    for (let i = 0; i < sights.length; i++) {
        for (let j = i + 1; j < sights.length; j++) {
            const a = sights[i];
            const b = sights[j];
            // places the traveler asked to keep apart are split on purpose
            if (a.date === b.date || a.p.id === b.p.id || apart(a.p.id, b.p.id)) continue;
            const km = haversineKm(a.p, b.p);
            if (km > SPLIT_KM) continue;
            const message = `${a.s.name} (${a.date}) is ${Math.round(km * 1000)} m from ${b.s.name} (${b.date}); visiting them the same day saves a trip`;
            splits.push({ km, message, date: b.date, placeId: b.p.id });
        }
    }
    splits.sort((x, y) => x.km - y.km);
    for (const s of splits.slice(0, MAX_SPLIT_WARNINGS)) issues.push({ level: "warning", code: "split_area", day: s.date, placeId: s.placeId, message: s.message });

    for (const d of days) {
        // airport transfers are fixed, so only count travel between the day's own stops and the hotel
        const legs = d.legs.filter((l) => l.fromId !== "ARR" && l.toId !== "DEP");
        if (!legs.length) continue;
        const span = legs[legs.length - 1].arriveMin - legs[0].departMin;
        const travel = legs.reduce((a, l) => a + l.minutes, 0);
        if (span >= 240 && travel / span > TRAVEL_SHARE) {
            const share = Math.round((travel / span) * 100);
            issues.push({
                level: "warning",
                code: "travel_heavy",
                day: d.date,
                message: `${Math.round(travel)} of ${Math.round(span)} minutes (${share}%) are spent travelling; put the day's stops closer together`,
            });
        }
    }
    return issues;
}

export function timetableDate(date: string, today: string) {
    const ahead = (Date.parse(date) - Date.parse(today)) / 86400000;
    if (ahead <= TIMETABLE_HORIZON_DAYS) return date;
    return addDays(date, -7 * Math.ceil((ahead - TIMETABLE_HORIZON_DAYS) / 7));
}

function estimateLeg(from: Place, to: Place, mode: Leg["mode"], tMin: number, note: string): Leg {
    const straight = haversineKm(from, to);
    const minutes = mode === "walk" ? estimate.walkMin(straight) : mode === "transit" ? estimate.transitMin(straight) : estimate.driveMin(straight);
    return {
        fromId: from.id, toId: to.id, mode, departMin: tMin, arriveMin: tMin + minutes, minutes, km: estimate.km(straight), cost: 0,
        costSource: "none", timeSource: "estimate", lines: [], geometry: [[from.lat, from.lon], [to.lat, to.lon]], note,
    };
}

async function driveLeg(ctx: Ctx, from: Place, to: Place, tMin: number, taxi: boolean): Promise<Leg> {
    const c = ctx.draft.local_costs;
    const travelers = ctx.intake.adults + ctx.intake.kids;
    const r = await osrmRoute("car", from, to).catch(() => null);
    const leg: Leg = r
        ? {
              fromId: from.id, toId: to.id, mode: taxi ? "taxi" : "drive", departMin: tMin, arriveMin: 0, minutes: r.minutes + (taxi ? 5 : 10),
              km: r.km, cost: 0, costSource: "model estimate", timeSource: "routed", lines: [], geometry: r.geometry,
          }
        : estimateLeg(from, to, taxi ? "taxi" : "drive", tMin, "road routing unavailable, straight-line estimate");
    leg.cost = taxi ? (c.taxi_base + c.taxi_per_km * leg.km) * Math.ceil(travelers / 4) : c.fuel_per_km * leg.km + c.parking_per_stop;
    leg.costSource = "model estimate";
    leg.arriveMin = tMin + leg.minutes;
    return leg;
}

async function routeLeg(ctx: Ctx, from: Place, to: Place, date: string, tMin: number): Promise<Leg> {
    const { intake } = ctx;
    const straight = haversineKm(from, to);
    if (straight < 0.05) {
        return { fromId: from.id, toId: to.id, mode: "walk", departMin: tMin, arriveMin: tMin, minutes: 0, km: 0, cost: 0, costSource: "none", timeSource: "routed", lines: [], geometry: [] };
    }

    // walk when it is within the traveler's limit
    if (estimate.walkMin(straight) <= intake.maxWalkMin * 1.5) {
        const r = await osrmRoute("foot", from, to).catch(() => null);
        if (r && r.minutes <= intake.maxWalkMin) {
            return {
                fromId: from.id, toId: to.id, mode: "walk", departMin: tMin, arriveMin: tMin + r.minutes, minutes: r.minutes, km: r.km,
                cost: 0, costSource: "none", timeSource: "routed", lines: [], geometry: r.geometry,
            };
        }
    }

    if (intake.getAround === "car") return driveLeg(ctx, from, to, tMin, false);

    const ttDate = timetableDate(date, ctx.today);
    if (ttDate !== date) ctx.borrowed.set(date, ttDate);
    const departUtc = localToUtc(ttDate, tMin, ctx.tz);
    ctx.transitCalls++;
    // null route means no transit in the data; an error means the service itself failed
    const { tr, lookupError } = await transitRoute(from, to, departUtc).then(
        (r) => ({ tr: r, lookupError: null as string | null }),
        (e: unknown) => ({ tr: null, lookupError: e instanceof Error ? e.message : String(e) }),
    );
    const travelers = intake.adults + intake.kids;

    // the timetable service did not answer: that says nothing about the plan, so use an estimate and say so,
    // never an error that would make the plan look impossible
    if (lookupError) {
        ctx.log(`transit lookup failed: ${lookupError}`);
        ctx.issues.push({
            level: "warning",
            code: "lookup_failed",
            day: date,
            placeId: to.id,
            message: `${from.name} → ${to.name}: the transit timetable service did not answer (${lookupError}); this leg's time is an estimate`,
        });
        const leg = estimateLeg(from, to, "transit", tMin, "transit lookup failed, estimated");
        leg.cost = ctx.draft.local_costs.transit_fare * travelers;
        leg.costSource = "model estimate";
        return leg;
    }

    const wait = tr ? (tr.departUtc - departUtc) / 60000 : 0;
    if (tr && wait <= MAX_WAIT_MIN) {
        const local = (utc: number) => tMin + (utc - departUtc) / 60000;
        // transitous names the two ends START and END, use the real places instead
        const segments = tr.segments.map(({ departUtc: d, arriveUtc: a, ...s }) => ({
            ...s,
            from: s.from === "START" ? from.name : s.from,
            to: s.to === "END" ? to.name : s.to,
            departMin: local(d),
            arriveMin: local(a),
        }));
        return {
            fromId: from.id, toId: to.id, mode: "transit", departMin: tMin, arriveMin: tMin + tr.minutes, minutes: tr.minutes, km: tr.km,
            cost: ctx.draft.local_costs.transit_fare * travelers, costSource: "model estimate", timeSource: "timetable",
            lines: tr.lines, geometry: tr.geometry, segments, note: wait > 15 ? `waits ${Math.round(wait)} min for departure` : undefined,
        };
    }

    const why = tr ? `next transit departs in ${Math.round(wait)} min` : "no transit route in the timetable data";
    if (intake.getAround === "transit") {
        // transit only means no taxis, so walk instead and make a very long walk an error the agent must fix
        const r = await osrmRoute("foot", from, to).catch(() => null);
        const leg: Leg = r
            ? {
                  fromId: from.id, toId: to.id, mode: "walk", departMin: tMin, arriveMin: tMin + r.minutes, minutes: r.minutes, km: r.km,
                  cost: 0, costSource: "none", timeSource: "routed", lines: [], geometry: r.geometry,
              }
            : estimateLeg(from, to, "walk", tMin, "walking route unavailable, straight-line estimate");
        const tooFar = leg.minutes > MAX_FALLBACK_WALK_MIN;
        ctx.issues.push({
            level: tooFar ? "error" : "warning",
            code: "no_transit",
            day: date,
            placeId: to.id,
            message: `${from.name} → ${to.name}: ${why}; walking ${Math.round(leg.minutes)} min instead${tooFar ? ", too far, choose places closer together" : ""}`,
        });
        leg.note = `${why}, walking (transit only)`;
        return leg;
    }
    ctx.issues.push({ level: "warning", code: "transit_fallback", day: date, placeId: to.id, message: `${from.name} → ${to.name}: ${why}, using a taxi estimate` });
    const leg = await driveLeg(ctx, from, to, tMin, true);
    leg.note = why;
    return leg;
}

export async function evaluatePlan(intake: Intake, draft: Draft, registry: Registry, opts: EvaluateOptions = {}): Promise<Evaluation> {
    const log = opts.log ?? (() => {});
    const issues: Issue[] = [];
    const hotel = registry[draft.hotel_place_id];
    const lastDate = addDays(intake.startDate, intake.nights);
    const budget = intake.budget;
    if (!hotel) {
        issues.push({ level: "error", code: "unknown_hotel", message: `hotel_place_id ${draft.hotel_place_id} was not returned by geocode or search_places` });
        return { days: [], issues, totals: { activities: 0, transport: 0, car: 0, total: 0, budget }, timezone: "", transitCalls: 0 };
    }
    const tz = timezoneAt(hotel);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const ctx: Ctx = { intake, draft, tz, issues, transitCalls: 0, today, borrowed: new Map(), log };
    const travelers = intake.adults + intake.kids;
    const arr = registry.ARR;
    const dep = registry.DEP;
    const route = (from: Place, to: Place, date: string, t: number) => {
        opts.signal?.throwIfAborted();
        return routeLeg(ctx, from, to, date, t);
    };

    for (const d of draft.days) {
        if (d.date < intake.startDate || d.date > lastDate) {
            issues.push({ level: "error", code: "date_out_of_range", day: d.date, message: `${d.date} is outside the trip (${intake.startDate} to ${lastDate})` });
        }
    }

    const days: TimedDay[] = [];
    for (let i = 0; i <= intake.nights; i++) {
        const date = addDays(intake.startDate, i);
        const draftDay = draft.days.find((d) => d.date === date);
        const legs: Leg[] = [];
        const stops: TimedStop[] = [];
        let cur: Place = hotel;
        const pace = PACE_DAY[intake.pace];
        let t: number = pace.start;
        // on the arrival day, when the traveler first reaches the hotel
        let hotelAt: number | null = null;

        if (i === 0 && arr && intake.arrivalTime) {
            t = hhmmToMin(intake.arrivalTime) + AIRPORT_EXIT_MIN;
            log(`${date}: ${arr.name} → ${hotel.name}`);
            const leg = await route(arr, hotel, date, t);
            legs.push(leg);
            hotelAt = leg.arriveMin;
            t = leg.arriveMin + 15;
        }

        for (const [index, s] of (draftDay?.stops ?? []).entries()) {
            const place = registry[s.place_id];
            if (!place) {
                issues.push({ level: "error", code: "unknown_place", day: date, placeId: s.place_id, message: `place_id ${s.place_id} was not returned by geocode or search_places` });
                continue;
            }
            const name = s.name_en || place.name;
            // carry the english name so transit walks to and from this stop show it too
            const shown: Place = name === place.name ? place : { ...place, name };
            log(`${date}: ${cur.name} → ${name}`);
            const leg = await route(cur, shown, date, t);
            legs.push(leg);
            const arriveMin = leg.arriveMin;
            let startMin = arriveMin;
            if (s.start_after) {
                const wanted = hhmmToMin(s.start_after);
                // a not-before hold only waits; arriving later is fine unless the place closes, checked below
                if (s.start_kind !== "not_before" && arriveMin > wanted + MISSED_START_SLACK_MIN) {
                    issues.push({ level: "error", code: "missed_start", day: date, placeId: place.id, message: `${name}: planned for ${s.start_after} but arrives ${minToHhmm(arriveMin)}` });
                }
                startMin = Math.max(arriveMin, wanted);
            }
            const endMin = startMin + s.duration_min;
            const atStart = hoursState(place.openingHours, date, startMin);
            const atEnd = hoursState(place.openingHours, date, endMin - 1);
            const hours = atStart === "closed" || atEnd === "closed" ? "closed" : atStart;
            if (hours === "closed") {
                issues.push({ level: "error", code: "closed", day: date, placeId: place.id, message: `${name} is closed during ${minToHhmm(startMin)}-${minToHhmm(endMin)} (hours: ${place.openingHours})` });
            }
            stops.push({ index, placeId: place.id, name, arriveMin, startMin, endMin, cost: s.cost_per_person * travelers, hours, meal: s.meal, note: s.note });
            cur = shown;
            t = endMin;
        }

        const departing = i === intake.nights && dep && intake.departureTime;
        const latestAtAirport = departing ? hhmmToMin(intake.departureTime) - AIRPORT_BEFORE_DEP_MIN : 0;
        if (departing) {
            log(`${date}: ${cur.name} → ${dep.name}`);
            const leg = await route(cur, dep, date, t);
            legs.push(leg);
            if (leg.arriveMin > latestAtAirport) {
                issues.push({ level: "error", code: "misses_flight", day: date, message: `reaches ${dep.name} at ${minToHhmm(leg.arriveMin)}, needs to be there by ${minToHhmm(latestAtAirport)}` });
            }
        } else {
            let back = hotelAt ?? pace.start;
            if (cur.id !== hotel.id) {
                const leg = await route(cur, hotel, date, t);
                legs.push(leg);
                back = leg.arriveMin;
            }
            // a late landing leaves too little day to fill, otherwise the day should run into the evening
            const fullEnough = hotelAt === null || hotelAt <= pace.backFrom - 180;
            if (fullEnough && back < pace.backFrom) {
                issues.push({
                    level: "error",
                    code: "day_too_short",
                    day: date,
                    message: `back at the hotel at ${minToHhmm(back)}; at a ${intake.pace} pace the day should run until ${minToHhmm(pace.backFrom)}-${minToHhmm(pace.backBy)}, add stops or a later dinner`,
                });
            }
            if (back > pace.backBy) {
                issues.push({ level: "error", code: "day_too_long", day: date, message: `back at the hotel at ${minToHhmm(back)}; at a ${intake.pace} pace be back by ${minToHhmm(pace.backBy)}` });
            }
        }

        // every day with a free evening gets dinner, not a departure day that leaves for the airport first
        const freeEvening = departing ? latestAtAirport >= DINNER_IF_AIRPORT_BY : (hotelAt ?? 0) <= DINNER_IF_HOTEL_BY;
        const dinner = stops.find((s) => s.meal === "dinner");
        if (freeEvening && !dinner) {
            issues.push({ level: "error", code: "no_dinner", day: date, message: `no dinner stop; add a restaurant with meal "dinner" starting ${minToHhmm(DINNER.from)}-${minToHhmm(DINNER.to)}` });
        } else if (dinner && (dinner.startMin < DINNER.from || dinner.startMin > DINNER.to)) {
            issues.push({ level: "error", code: "dinner_time", day: date, placeId: dinner.placeId, message: `dinner at ${dinner.name} starts ${minToHhmm(dinner.startMin)}; it should start ${minToHhmm(DINNER.from)}-${minToHhmm(DINNER.to)}` });
        }
        // a warning, not an error: a late lunch after a long morning visit is unusual, not impossible
        const lunch = stops.find((s) => s.meal === "lunch");
        if (lunch && (lunch.startMin < LUNCH_EARLIEST || lunch.startMin > LUNCH_LATEST)) {
            issues.push({ level: "warning", code: "lunch_time", day: date, placeId: lunch.placeId, message: `lunch at ${lunch.name} starts ${minToHhmm(lunch.startMin)}; lunch usually starts ${minToHhmm(LUNCH.from)}-${minToHhmm(LUNCH.to)}` });
        }
        days.push({ date, stops, legs });
    }

    issues.push(...groupingWarnings(days, registry, opts.keepApart ?? []));

    if (ctx.borrowed.size) {
        const pairs = [...ctx.borrowed].map(([d, t]) => `${d} uses ${t}`).join(", ");
        issues.push({
            level: "warning",
            code: "timetable_borrowed",
            message: `dates more than ${TIMETABLE_HORIZON_DAYS} days out use transit times from the same weekday in an earlier week, since agencies often publish timetables only a few weeks ahead (${pairs}); nothing to fix`,
        });
    }

    const activities = days.reduce((a, d) => a + d.stops.reduce((b, s) => b + s.cost, 0), 0);
    const transport = days.reduce((a, d) => a + d.legs.reduce((b, l) => b + l.cost, 0), 0);
    const car = intake.getAround === "car" ? intake.carDailyRate * (intake.nights + 1) : 0;
    const total = activities + transport + car;
    if (total > budget) {
        issues.push({ level: "error", code: "over_budget", message: `estimated ${Math.round(total)} ${intake.currency} is over the ${budget} ${intake.currency} budget (lodging and flights not included)` });
    }
    return { days, issues, totals: { activities, transport, car, total, budget }, timezone: ctx.tz, transitCalls: ctx.transitCalls };
}
