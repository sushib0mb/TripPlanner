import OpeningHours from "opening_hours";
import { haversineKm, localToUtc, timezoneAt } from "./geo";
import { osrmRoute, transitRoute } from "./routing";
import { addDays, hhmmToMin, minToHhmm } from "./time";
import type { Draft, Evaluation, Intake, Issue, Leg, Place, Registry, TimedDay, TimedStop } from "./types";

const DAY_START = { relaxed: 600, normal: 540, packed: 480 };
const AIRPORT_EXIT_MIN = 45;
const AIRPORT_BEFORE_DEP_MIN = 120;
const LATEST_RETURN_MIN = 23 * 60;
const MAX_WAIT_MIN = 60;

interface Ctx {
    intake: Intake;
    draft: Draft;
    tz: string;
    issues: Issue[];
    transitCalls: number;
    log: (msg: string) => void;
}

function hoursState(oh: string | undefined, date: string, minute: number): "open" | "closed" | "unknown" {
    if (!oh) return "unknown";
    try {
        const parsed = new OpeningHours(oh, null);
        const [y, m, d] = date.split("-").map(Number);
        // opening_hours reads local date fields, so build a date whose fields match destination time
        const at = new Date(y, m - 1, d, 0, minute);
        return parsed.getState(at) ? "open" : "closed";
    } catch {
        return "unknown";
    }
}

function estimateLeg(from: Place, to: Place, mode: Leg["mode"], tMin: number, note: string): Leg {
    const km = haversineKm(from, to) * 1.3;
    const minutes = mode === "walk" ? (km / 4.8) * 60 : (km / 25) * 60 + 10;
    return {
        fromId: from.id, toId: to.id, mode, departMin: tMin, arriveMin: tMin + minutes, minutes, km, cost: 0,
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
    if ((straight * 1.3 * 60) / 4.8 <= intake.maxWalkMin * 1.5) {
        const r = await osrmRoute("foot", from, to).catch(() => null);
        if (r && r.minutes <= intake.maxWalkMin) {
            return {
                fromId: from.id, toId: to.id, mode: "walk", departMin: tMin, arriveMin: tMin + r.minutes, minutes: r.minutes, km: r.km,
                cost: 0, costSource: "none", timeSource: "routed", lines: [], geometry: r.geometry,
            };
        }
    }

    if (intake.getAround === "car") return driveLeg(ctx, from, to, tMin, false);

    const departUtc = localToUtc(date, tMin, ctx.tz);
    ctx.transitCalls++;
    const tr = await transitRoute(from, to, departUtc).catch((e: Error) => {
        ctx.log(`transit lookup failed: ${e.message}`);
        return null;
    });
    const wait = tr ? (tr.departUtc - departUtc) / 60000 : 0;
    if (tr && wait <= MAX_WAIT_MIN) {
        const travelers = intake.adults + intake.kids;
        return {
            fromId: from.id, toId: to.id, mode: "transit", departMin: tMin, arriveMin: tMin + tr.minutes, minutes: tr.minutes, km: tr.km,
            cost: ctx.draft.local_costs.transit_fare * travelers, costSource: "model estimate", timeSource: "timetable",
            lines: tr.lines, geometry: tr.geometry, note: wait > 15 ? `waits ${Math.round(wait)} min for departure` : undefined,
        };
    }

    const why = tr ? `next transit departs in ${Math.round(wait)} min` : "no transit route in the timetable data";
    ctx.issues.push({ level: "warning", code: "transit_fallback", day: date, message: `${from.name} → ${to.name}: ${why}, using a taxi estimate` });
    const leg = await driveLeg(ctx, from, to, tMin, true);
    leg.note = why;
    return leg;
}

export async function evaluatePlan(intake: Intake, draft: Draft, registry: Registry, log: (msg: string) => void = () => {}): Promise<Evaluation> {
    const issues: Issue[] = [];
    const hotel = registry[draft.hotel_place_id];
    const lastDate = addDays(intake.startDate, intake.nights);
    const budget = intake.budget;
    if (!hotel) {
        issues.push({ level: "error", code: "unknown_hotel", message: `hotel_place_id ${draft.hotel_place_id} was not returned by geocode or search_places` });
        return { days: [], issues, totals: { activities: 0, transport: 0, car: 0, total: 0, budget }, timezone: "", transitCalls: 0 };
    }
    const ctx: Ctx = { intake, draft, tz: timezoneAt(hotel), issues, transitCalls: 0, log };
    const travelers = intake.adults + intake.kids;
    const arr = registry.ARR;
    const dep = registry.DEP;

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
        let t: number = DAY_START[intake.pace];

        if (i === 0 && arr && intake.arrivalTime) {
            t = hhmmToMin(intake.arrivalTime) + AIRPORT_EXIT_MIN;
            log(`${date}: ${arr.name} → ${hotel.name}`);
            const leg = await routeLeg(ctx, arr, hotel, date, t);
            legs.push(leg);
            t = leg.arriveMin + 15;
        }

        for (const s of draftDay?.stops ?? []) {
            const place = registry[s.place_id];
            if (!place) {
                issues.push({ level: "error", code: "unknown_place", day: date, message: `place_id ${s.place_id} was not returned by geocode or search_places` });
                continue;
            }
            log(`${date}: ${cur.name} → ${place.name}`);
            const leg = await routeLeg(ctx, cur, place, date, t);
            legs.push(leg);
            const arriveMin = leg.arriveMin;
            let startMin = arriveMin;
            if (s.start_after) {
                const wanted = hhmmToMin(s.start_after);
                if (arriveMin > wanted + 15) {
                    issues.push({ level: "error", code: "missed_start", day: date, message: `${place.name}: planned for ${s.start_after} but arrives ${minToHhmm(arriveMin)}` });
                }
                startMin = Math.max(arriveMin, wanted);
            }
            const endMin = startMin + s.duration_min;
            const atStart = hoursState(place.openingHours, date, startMin);
            const atEnd = hoursState(place.openingHours, date, endMin - 1);
            const hours = atStart === "closed" || atEnd === "closed" ? "closed" : atStart;
            if (hours === "closed") {
                issues.push({ level: "error", code: "closed", day: date, message: `${place.name} is closed during ${minToHhmm(startMin)}-${minToHhmm(endMin)} (hours: ${place.openingHours})` });
            }
            stops.push({ placeId: place.id, name: place.name, arriveMin, startMin, endMin, cost: s.cost_per_person * travelers, hours, note: s.note });
            cur = place;
            t = endMin;
        }

        if (i === intake.nights && dep && intake.departureTime) {
            log(`${date}: ${cur.name} → ${dep.name}`);
            const leg = await routeLeg(ctx, cur, dep, date, t);
            legs.push(leg);
            const latest = hhmmToMin(intake.departureTime) - AIRPORT_BEFORE_DEP_MIN;
            if (leg.arriveMin > latest) {
                issues.push({ level: "error", code: "misses_flight", day: date, message: `reaches ${dep.name} at ${minToHhmm(leg.arriveMin)}, needs to be there by ${minToHhmm(latest)}` });
            }
        } else if (cur !== hotel) {
            const leg = await routeLeg(ctx, cur, hotel, date, t);
            legs.push(leg);
            if (leg.arriveMin > LATEST_RETURN_MIN) {
                issues.push({ level: "error", code: "day_too_long", day: date, message: `back at the hotel at ${minToHhmm(leg.arriveMin)}` });
            }
        }
        days.push({ date, stops, legs });
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
