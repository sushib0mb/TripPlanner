import { haversineKm } from "./geo";
import { fitOpen, hoursState } from "./hours";
import { walkMatrix } from "./routing";
import { AIRPORT_BEFORE_DEP_MIN, AIRPORT_EXIT_MIN, DINNER, DINNER_IF_AIRPORT_BY, DINNER_IF_HOTEL_BY, estimate, LUNCH, LUNCH_LATEST, PACE_DAY } from "./rules";
import { addDays, hhmmToMin, minToHhmm } from "./time";
import type { Draft, DraftDay, DraftStop, Intake, Meal, Place, Registry, Shortlist, ShortlistItem, StartKind, TimeOfDay } from "./types";

// turns the agent's shortlist into days: groups nearby places, spreads them over the trip, orders each day,
// places lunch and dinner from the agent's options and fits opening hours and the pace's day window.
// travel times here are estimates, real transit is checked afterwards by the checker

// places this many walking minutes apart, edge to edge, count as one area
const CLUSTER_WALK_MIN = 12;
// trying every order is fine up to this many stops in a day, beyond that a greedy order is improved by swaps
const MAX_EXACT_ORDER = 7;
// outline boxes bigger than this are neighbourhoods or cities, not one place, so their point is used instead
const MAX_BOX_KM = 2.5;
// real transfers to the airport run longer than estimates, keep this much spare before the airport deadline
const AIRPORT_MARGIN_MIN = 20;
// aim to spend the budget only up to this share, estimated fares are rough
const BUDGET_SHARE = 0.97;
// museums and sights with no listed hours are assumed shut before this, so a plan never starts them at 08:00
const UNKNOWN_OPENS = 9 * 60 + 30;
const SIGHT_KINDS = /tourism=(museum|gallery|attraction)|historic=|amenity=place_of_worship/;
// a visit planned this close to its opening time is held to the opening, so an early real arrival waits
const HOLD_NEAR_OPENING_MIN = 60;
const TIME_WINDOWS: Record<TimeOfDay, [number, number]> = { morning: [0, 12 * 60], afternoon: [12 * 60, 17 * 60 + 30], evening: [17 * 60, 24 * 60] };

export interface Dropped {
    place_id: string;
    name: string;
    why: string;
}

// a meal the day needs, where and when, so restaurants can be chosen after the days are laid out
export interface MealSlotInfo {
    key: string;
    date: string;
    kind: Meal;
    at: number;
    from: Place;
    to: Place;
    // the point to search around: between the two stops when they are close, otherwise where the traveler is
    center: { lat: number; lon: number };
    chosen?: string;
}

export interface ScheduleResult {
    draft: Draft;
    report: string;
    problems: string[];
    dropped: Dropped[];
    slots: MealSlotInfo[];
}

export const slotKey = (date: string, kind: Meal) => `${date} ${kind}`;

// real travel times seen by the checker, fed back so a second schedule plans with them instead of guesses
export interface TravelFeedback {
    // door-to-door minutes per ordered pair of place ids, see legKey, and whether the move was a walk
    legs: Map<string, { minutes: number; walk: boolean }>;
    // real transit time over the estimate, across observed legs; scales the estimate for unseen pairs
    transitFactor: number;
}

export const legKey = (fromId: string, toId: string) => `${fromId}>${toId}`;

export interface ScheduleOptions {
    // the plan being changed: places keep their days where they can
    previous?: Draft;
    // restaurants already chosen per meal slot key
    fixedMeals?: Map<string, ShortlistItem>;
    feedback?: TravelFeedback;
}

// a restaurant may add at most this much walking to the day, about 12-15 minutes
export const MAX_MEAL_DETOUR_KM = 1.0;

const mealLength = (kind: Meal) => (kind === "lunch" ? LUNCH.length : DINNER.length);

// extra distance a restaurant adds between where the traveler is and where they go next
export const mealDetourKm = (slot: { from: Place; to: Place }, p: { lat: number; lon: number }) =>
    haversineKm(slot.from, p) + haversineKm(p, slot.to) - haversineKm(slot.from, slot.to);

// why a restaurant cannot serve a meal slot, or null when it can: near enough and open for the whole meal
// when it starts within 45 minutes of the planned time. the agent's picks and the scheduler's re-checks use
// this one rule
export function mealMisfit(slot: { date: string; kind: Meal; at: number; from: Place; to: Place }, p: Place): string | null {
    const detour = mealDetourKm(slot, p);
    if (detour > MAX_MEAL_DETOUR_KM) return `${p.name} is ${detour.toFixed(1)} km out of the way; pick one nearer ${slot.from.name}`;
    const length = mealLength(slot.kind);
    if (fitOpen(p.openingHours, slot.date, slot.at - 15, length, slot.at + length + 45) === null) {
        return `${p.name} is not open around ${minToHhmm(slot.at)} (hours: ${p.openingHours})`;
    }
    return null;
}

interface Frame {
    date: string;
    start: number;
    // latest return to the hotel, or arrival at the airport on the last day
    end: number;
    // aim to be back no earlier than this, 0 when the day may end early
    backFrom: number;
    startAt: Place;
    endAt: Place;
    lunch: boolean;
    dinner: boolean;
    dinnerAt: number;
}

interface Slot {
    item: ShortlistItem;
    place: Place;
    start: number;
    end: number;
    // waiting was intended (opening time, pin, meal), so the checker should not start before holdAt
    hold: boolean;
    holdAt?: number;
    // a booked start the traveler must make, or only a hold that later arrival may pass
    startKind: StartKind;
}

interface DayPlan {
    slots: Slot[];
    back: number;
    problems: string[];
    // moves that are not walks, each one a transit fare or a drive
    rides: number;
}

interface Ctx {
    intake: Intake;
    registry: Registry;
    hotel: Place;
    travel: (a: Place, b: Place) => number;
    near: (a: Place, b: Place) => number;
    walkable: (a: Place, b: Place) => boolean;
    // a typical meal price from the agent's options, for meal breaks with no listed restaurant
    mealCost: number;
}

const round5 = (m: number) => Math.ceil(m / 5) * 5;

// distance between outline boxes, so a long street counts as close to what lines it
function edgeKm(a: Place, b: Place) {
    const box = (p: Place): [number, number, number, number] => {
        if (!p.bbox) return [p.lat, p.lat, p.lon, p.lon];
        const [s, n, w, e] = p.bbox;
        const diag = haversineKm({ lat: s, lon: w }, { lat: n, lon: e });
        return diag <= MAX_BOX_KM ? p.bbox : [p.lat, p.lat, p.lon, p.lon];
    };
    const [as, an, aw, ae] = box(a);
    const [bs, bn, bw, be] = box(b);
    const dLat = Math.max(0, bs - an, as - bn);
    const dLon = Math.max(0, bw - ae, aw - be);
    return Math.hypot(dLat, dLon * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)) * 111;
}

async function buildCtx(intake: Intake, registry: Registry, hotel: Place, places: Place[], feedback?: TravelFeedback): Promise<Ctx> {
    const all = [hotel, ...places, ...(["ARR", "DEP"] as const).map((k) => registry[k]).filter((p): p is Place => !!p)];
    const unique = [...new Map(all.map((p) => [p.id, p])).values()];
    const index = new Map(unique.map((p, i) => [p.id, i]));
    // one request for every pair, straight-line estimates when the server is unavailable
    const matrix = await walkMatrix(unique).catch(() => null);
    const walkMin = (a: Place, b: Place) => {
        const i = index.get(a.id);
        const j = index.get(b.id);
        const m = matrix && i !== undefined && j !== undefined ? matrix[i][j] : undefined;
        return m !== undefined && Number.isFinite(m) ? m : estimate.walkMin(haversineKm(a, b));
    };
    const factor = feedback?.transitFactor ?? 1;
    const travel = (a: Place, b: Place) => {
        if (a.id === b.id) return 0;
        // a real time from the last check beats any estimate
        const seen = feedback?.legs.get(legKey(a.id, b.id));
        if (seen) return seen.minutes;
        const walk = walkMin(a, b);
        if (walk <= intake.maxWalkMin) return walk;
        const straight = haversineKm(a, b);
        if (intake.getAround === "car") return estimate.driveMin(straight);
        return estimate.transitMin(straight) * factor;
    };
    const near = (a: Place, b: Place) => Math.min(walkMin(a, b), estimate.walkMin(edgeKm(a, b)));
    const walkable = (a: Place, b: Place) => {
        if (a.id === b.id) return true;
        const seen = feedback?.legs.get(legKey(a.id, b.id));
        return seen ? seen.walk : walkMin(a, b) <= intake.maxWalkMin;
    };
    return { intake, registry, hotel, travel, near, walkable, mealCost: 20 };
}

function frames(ctx: Ctx): Frame[] {
    const { intake, registry, hotel, travel } = ctx;
    const pace = PACE_DAY[intake.pace];
    // dinner late enough that the day runs into the pace's return window
    const dinnerAt = Math.min(Math.max(Math.ceil((pace.backFrom - DINNER.length - 10) / 15) * 15, DINNER.from), DINNER.to - 30);
    const out: Frame[] = [];
    for (let i = 0; i <= intake.nights; i++) {
        const date = addDays(intake.startDate, i);
        let start = pace.start;
        let end = pace.backBy;
        let backFrom = pace.backFrom;
        let endAt = hotel;
        let hotelAt: number | null = null;
        if (i === 0 && registry.ARR && intake.arrivalTime) {
            hotelAt = hhmmToMin(intake.arrivalTime) + AIRPORT_EXIT_MIN + travel(registry.ARR, hotel);
            start = Math.max(start, hotelAt + 15);
            if (hotelAt > pace.backFrom - 180) backFrom = 0;
        }
        const departing = i === intake.nights && !!registry.DEP && !!intake.departureTime;
        let latestAtAirport = 0;
        if (departing) {
            latestAtAirport = hhmmToMin(intake.departureTime) - AIRPORT_BEFORE_DEP_MIN;
            end = latestAtAirport - AIRPORT_MARGIN_MIN;
            endAt = registry.DEP;
            backFrom = 0;
        }
        let dinner = departing ? latestAtAirport >= DINNER_IF_AIRPORT_BY : (hotelAt ?? 0) <= DINNER_IF_HOTEL_BY;
        let dayDinnerAt = dinnerAt;
        if (departing && dinner) {
            dayDinnerAt = Math.min(dinnerAt, Math.floor((end - DINNER.length - travel(hotel, endAt) - 15) / 15) * 15);
            dinner = dayDinnerAt >= DINNER.from;
        }
        const lunch = start <= 12 * 60 + 30 && end >= 14 * 60 + 30;
        out.push({ date, start, end, backFrom, startAt: hotel, endAt, lunch, dinner, dinnerAt: dayDinnerAt });
    }
    return out;
}

// union-find over places within a short walk, then the traveler's together groups
function cluster(ids: string[], ctx: Ctx, together: string[][]): string[][] {
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    const join = (a: string, b: string) => parent.set(find(a), find(b));
    for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
            if (ctx.near(ctx.registry[ids[i]], ctx.registry[ids[j]]) <= CLUSTER_WALK_MIN) join(ids[i], ids[j]);
        }
    for (const g of together) {
        const inside = g.filter((id) => parent.has(id));
        for (const id of inside.slice(1)) join(inside[0], id);
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
    return [...groups.values()];
}

// split a group around seeds: every other place joins the seed it is nearest to
function splitAround(group: string[], seeds: string[], ctx: Ctx): string[][] {
    const parts = seeds.map((s) => [s]);
    for (const id of group) {
        if (seeds.includes(id)) continue;
        let best = 0;
        seeds.forEach((s, i) => {
            if (ctx.near(ctx.registry[id], ctx.registry[s]) < ctx.near(ctx.registry[id], ctx.registry[seeds[best]])) best = i;
        });
        parts[best].push(id);
    }
    return parts;
}

// units are what gets assigned to a day: areas split where pins or apart requests disagree, and where an area is too big for one day
function makeUnits(acts: ShortlistItem[], ctx: Ctx, list: Shortlist, maxCap: number): string[][] {
    const items = new Map(acts.map((a) => [a.place_id, a]));
    let groups = cluster([...items.keys()], ctx, list.together ?? []);
    const apart = list.apart ?? [];
    const split = (g: string[]): string[][] => {
        // places pinned to different days
        const pinDays = [...new Set(g.map((id) => items.get(id)!.day).filter((d): d is string => !!d))];
        if (pinDays.length > 1) {
            const seeds = pinDays.map((d) => g.find((id) => items.get(id)!.day === d)!);
            return splitAround(g, seeds, ctx).flatMap(split);
        }
        // places asked to be apart
        for (const pair of apart) {
            const inside = pair.filter((id) => g.includes(id));
            if (inside.length > 1) return splitAround(g, inside, ctx).flatMap(split);
        }
        // more than one day's worth, cut along a walking path
        const dur = g.reduce((a, id) => a + items.get(id)!.duration_min + 15, 0);
        if (dur > maxCap * 0.85 && g.length > 1) {
            const path = [g[0]];
            const rest = new Set(g.slice(1));
            while (rest.size) {
                const last = ctx.registry[path[path.length - 1]];
                const next = [...rest].sort((x, y) => ctx.near(last, ctx.registry[x]) - ctx.near(last, ctx.registry[y]))[0];
                path.push(next);
                rest.delete(next);
            }
            const parts = Math.ceil(dur / (maxCap * 0.7));
            const size = Math.ceil(path.length / parts);
            return Array.from({ length: parts }, (_, i) => path.slice(i * size, (i + 1) * size)).filter((p) => p.length);
        }
        return [g];
    };
    groups = groups.flatMap(split);
    // the traveler's together requests win over the size split
    for (const g of list.together ?? []) {
        const parts = groups.filter((part) => part.some((id) => g.includes(id)));
        if (parts.length < 2) continue;
        groups = [...groups.filter((part) => !parts.includes(part)), parts.flat()];
    }
    return groups;
}

// lunch before the next stop once it is lunchtime, or late morning when that stop would run well past lunch;
// an early long visit goes first and lunch follows it
const lunchFirst = (t: number, go: number, length: number) => t >= LUNCH.from - 15 || (t >= 10 * 60 + 30 && t + go + length > LUNCH_LATEST);
// each minute a lunch starts after its window weighs this much when comparing orders, so an order that fits
// lunch in, e.g. the short museum before the long one, wins over one that pushes lunch to mid-afternoon
const LATE_LUNCH_WEIGHT = 3;
// before restaurants are chosen, a meal is assumed to be this far from the stops around it
const MEAL_DETOUR_MIN = 10;
// a meal may add at most this much travel to the day, unless the agent marked the restaurant must, worth a trip of its own
const MAX_MEAL_DETOUR_MIN = 20;

interface MealSlot {
    day: number;
    kind: Meal;
    from: Place;
    to: Place;
    at: number;
}

const capacity = (f: Frame) => Math.max(0, (f.dinner ? f.dinnerAt : f.end) - f.start - (f.lunch ? LUNCH.length : 0) - 30);

// the stay at one place, shifted for travel, pins and opening hours
function place(item: ShortlistItem, p: Place, date: string, arrive: number, frameEnd: number) {
    let earliest = arrive;
    if (item.start_after) earliest = Math.max(earliest, hhmmToMin(item.start_after));
    if (item.time) earliest = Math.max(earliest, TIME_WINDOWS[item.time][0]);
    if (!p.openingHours && SIGHT_KINDS.test(p.kind)) earliest = Math.max(earliest, UNKNOWN_OPENS);
    const fit = fitOpen(p.openingHours, date, earliest, item.duration_min, Math.max(frameEnd, earliest + item.duration_min));
    const start = fit ?? earliest;
    return { start, closed: fit === null, pinMiss: !!item.time && start + item.duration_min > TIME_WINDOWS[item.time][1] + 30 };
}

// rough day for comparing orders: activities, with lunch as a fixed hour and dinner at its target time
function roughScore(frame: Frame, order: ShortlistItem[], ctx: Ctx) {
    let t = frame.start;
    let at = frame.startAt;
    let lunchDone = !frame.lunch;
    let score = 0;
    for (const item of order) {
        const p = ctx.registry[item.place_id];
        const go = ctx.travel(at, p);
        if (!lunchDone && lunchFirst(t, go, item.duration_min)) {
            const lunchAt = Math.max(t + MEAL_DETOUR_MIN, LUNCH.from);
            score += Math.max(0, LUNCH.from - t - MEAL_DETOUR_MIN) * 0.3 + Math.max(0, lunchAt - LUNCH.to) * LATE_LUNCH_WEIGHT;
            t = lunchAt + LUNCH.length;
            lunchDone = true;
        }
        const s = place(item, p, frame.date, t + go, frame.end);
        score += go + (s.start - t - go) * 0.3 + (s.closed ? 1000 : 0) + (s.pinMiss ? 300 : 0);
        t = s.start + item.duration_min;
        at = p;
    }
    if (!lunchDone && frame.lunch) {
        // lunch after the last sight, or none at all when the day ran past the window
        const lunchAt = Math.max(t + MEAL_DETOUR_MIN, LUNCH.from);
        score += lunchAt > LUNCH_LATEST ? 200 : Math.max(0, lunchAt - LUNCH.to) * LATE_LUNCH_WEIGHT;
    }
    if (frame.dinner) {
        t = Math.max(t + 15, frame.dinnerAt) + DINNER.length;
        score += t > DINNER.to + DINNER.length ? (t - DINNER.to - DINNER.length) * 5 : 0;
    }
    const back = t + ctx.travel(at, frame.endAt);
    return score + Math.max(0, back - frame.end) * 5;
}

function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

function bestOrder(frame: Frame, acts: ShortlistItem[], ctx: Ctx): ShortlistItem[] {
    if (acts.length <= 1) return acts;
    if (acts.length <= MAX_EXACT_ORDER) {
        let best = acts;
        let bestScore = Infinity;
        for (const p of permutations(acts)) {
            const s = roughScore(frame, p, ctx);
            if (s < bestScore) [best, bestScore] = [p, s];
        }
        return best;
    }
    // nearest first from the hotel, then pairwise swaps while they help
    const order: ShortlistItem[] = [];
    const rest = [...acts];
    let at = frame.startAt;
    while (rest.length) {
        rest.sort((x, y) => ctx.travel(at, ctx.registry[x.place_id]) - ctx.travel(at, ctx.registry[y.place_id]));
        order.push(rest.shift()!);
        at = ctx.registry[order[order.length - 1].place_id];
    }
    let score = roughScore(frame, order, ctx);
    for (let improved = true; improved; ) {
        improved = false;
        for (let i = 0; i < order.length; i++)
            for (let j = i + 1; j < order.length; j++) {
                [order[i], order[j]] = [order[j], order[i]];
                const s = roughScore(frame, order, ctx);
                if (s < score - 0.5) [score, improved] = [s, true];
                else [order[i], order[j]] = [order[j], order[i]];
            }
    }
    return order;
}

// restaurants for every meal of the trip at once, cheapest detours first, so early days do not take the
// options later days need; options offered for the other meal are a last resort
function assignMeals(slots: MealSlot[], options: ShortlistItem[], fr: Frame[], ctx: Ctx, fixed: Map<string, ShortlistItem>) {
    // picks made for an earlier schedule are checked again, a slot may have moved since
    const rejected: string[] = [];
    const pairs: { slot: number; option: number; cost: number }[] = [];
    slots.forEach((slot, i) => {
        options.forEach((o, j) => {
            const p = ctx.registry[o.place_id];
            const length = slot.kind === "lunch" ? LUNCH.length : DINNER.length;
            const date = fr[slot.day].date;
            // open for the whole meal if it starts within 45 minutes of the planned time
            if (fitOpen(p.openingHours, date, slot.at, length, slot.at + length + 45) === null) return;
            const unknown = hoursState(p.openingHours, date, slot.at + 10) === "unknown";
            const detour = ctx.travel(slot.from, p) + ctx.travel(p, slot.to) - ctx.travel(slot.from, slot.to);
            if (detour > MAX_MEAL_DETOUR_MIN && o.priority !== "must") return;
            const cost = detour + (o.meal === slot.kind ? 0 : 60) + (unknown ? 10 : 0);
            pairs.push({ slot: i, option: j, cost });
        });
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const chosen = new Map<number, ShortlistItem>();
    const taken = new Set<string>();
    slots.forEach((slot, i) => {
        const key = slotKey(fr[slot.day].date, slot.kind);
        const pick = fixed.get(key);
        const p = pick && ctx.registry[pick.place_id];
        if (!pick || !p || taken.has(pick.place_id)) return;
        const misfit = mealMisfit({ ...slot, date: fr[slot.day].date }, p);
        if (misfit) {
            rejected.push(`${key}: the chosen ${misfit} now that the day moved; choose again`);
            return;
        }
        chosen.set(i, pick);
        taken.add(pick.place_id);
    });
    for (const pair of pairs) {
        const place = options[pair.option].place_id;
        if (chosen.has(pair.slot) || taken.has(place)) continue;
        chosen.set(pair.slot, options[pair.option]);
        taken.add(place);
    }
    return { chosen, rejected };
}

// the day with real choices: restaurants picked, opening hours fitted, holds marked where waiting is intended
function realize(frame: Frame, order: ShortlistItem[], ctx: Ctx, day: number, meals?: Partial<Record<Meal, ShortlistItem>>, need?: MealSlot[]): DayPlan {
    const slots: Slot[] = [];
    const problems: string[] = [];
    let t = frame.start;
    let at = frame.startAt;
    let lunchDone = !frame.lunch;
    let rides = 0;
    const move = (to: Place) => {
        if (!ctx.walkable(at, to)) rides++;
        return ctx.travel(at, to);
    };
    const eat = (kind: Meal, next: Place, target: number) => {
        const length = kind === "lunch" ? LUNCH.length : DINNER.length;
        if (!meals) {
            // planning pass: hold the time, the restaurant is chosen once every day is laid out
            const start = round5(Math.max(t + MEAL_DETOUR_MIN, target));
            need?.push({ day, kind, from: at, to: next, at: start });
            slots.push({ item: { place_id: "", priority: "nice", duration_min: length, cost_per_person: 0, meal: kind }, place: at, start, end: start + length, hold: true, startKind: "not_before" });
            t = start + length + MEAL_DETOUR_MIN;
            return;
        }
        const option = meals[kind];
        if (!option) {
            // no restaurant yet: hold the meal where the traveler is; the meal slot list asks the agent to choose one
            const start = round5(Math.max(t, target));
            const item: ShortlistItem = {
                place_id: at.id,
                priority: "nice",
                duration_min: length,
                cost_per_person: ctx.mealCost,
                meal: kind,
                name_en: `${kind === "lunch" ? "Lunch" : "Dinner"} near ${at.name}`,
                note: "no listed restaurant close by, eat at or around here",
            };
            slots.push({ item, place: at, start, end: start + length, hold: true, startKind: "not_before" });
            t = start + length;
            return;
        }
        const p = ctx.registry[option.place_id];
        const arrive = t + move(p);
        const wanted = Math.max(arrive, target);
        const start = round5(fitOpen(p.openingHours, frame.date, wanted, length, wanted + length + 60) ?? wanted);
        const floor = kind === "lunch" ? round5(fitOpen(p.openingHours, frame.date, LUNCH.from, length, LUNCH.to + length) ?? LUNCH.from) : start;
        slots.push({ item: { ...option, meal: kind, duration_min: length }, place: p, start, end: start + length, hold: true, holdAt: Math.min(floor, start), startKind: "not_before" });
        t = start + length;
        at = p;
    };
    for (const item of order) {
        const p = ctx.registry[item.place_id];
        if (!lunchDone && lunchFirst(t, ctx.travel(at, p), item.duration_min)) {
            eat("lunch", p, LUNCH.from);
            lunchDone = true;
        }
        const arrive = t + move(p);
        const s = place(item, p, frame.date, arrive, frame.end);
        if (s.closed) problems.push(`${frame.date}: ${item.name_en ?? p.name} is closed or too short open for a ${item.duration_min} min visit`);
        if (s.pinMiss) problems.push(`${frame.date}: ${item.name_en ?? p.name} misses its ${item.time} pin`);
        const start = round5(s.start);
        const opens = p.openingHours || SIGHT_KINDS.test(p.kind) ? place(item, p, frame.date, frame.start, frame.end).start : null;
        const nearOpening = opens !== null && start - opens < HOLD_NEAR_OPENING_MIN && opens > frame.start;
        const pinned = !!item.start_after || !!item.time;
        const hold = pinned || nearOpening || s.start > arrive;
        // only a fixed start from the agent (a booked tour) is a commitment; part-of-day pins, opening times
        // and waits are holds that a later real arrival may pass
        const startKind: StartKind = item.start_after ? "fixed" : "not_before";
        slots.push({ item, place: p, start, end: start + item.duration_min, hold, holdAt: nearOpening && !pinned ? round5(opens) : start, startKind });
        t = start + item.duration_min;
        at = p;
    }
    if (!lunchDone && t + MEAL_DETOUR_MIN <= LUNCH_LATEST) eat("lunch", frame.endAt, LUNCH.from);
    if (frame.dinner) {
        eat("dinner", frame.endAt, frame.dinnerAt);
        const dinner = slots.find((s) => s.item.meal === "dinner");
        if (dinner && dinner.start > DINNER.to) problems.push(`${frame.date}: dinner can only start at ${minToHhmm(dinner.start)}, the day is too full`);
    }
    const back = t + move(frame.endAt);
    return { slots, back, problems, rides };
}

// greedy day assignment, then moves and swaps while the total cost drops
function assign(units: string[][], fr: Frame[], items: Map<string, ShortlistItem>, ctx: Ctx, list: Shortlist, previous?: Draft) {
    const prevDay = new Map<string, string>();
    for (const d of previous?.days ?? []) for (const s of d.stops) prevDay.set(s.place_id, d.date);
    const centre = (ids: string[]) => ({
        lat: ids.reduce((a, id) => a + ctx.registry[id].lat, 0) / ids.length,
        lon: ids.reduce((a, id) => a + ctx.registry[id].lon, 0) / ids.length,
    });
    const info = units.map((ids) => {
        const dur = ids.reduce((a, id) => a + items.get(id)!.duration_min + 15, 0) + 20;
        const pin = ids.map((id) => items.get(id)!.day).find((d) => !!d);
        const sticky = ids.map((id) => prevDay.get(id)).find((d) => !!d);
        // days on which every place in the unit is open long enough
        const feasible = fr
            .map((f, i) => ({ f, i }))
            .filter(({ f }) => ids.every((id) => f.start + items.get(id)!.duration_min <= f.end && fitOpen(ctx.registry[id].openingHours, f.date, f.start, items.get(id)!.duration_min, f.end) !== null))
            .map(({ i }) => i);
        return { ids, dur, pin: pin ? fr.findIndex((f) => f.date === pin) : -1, sticky: sticky ? fr.findIndex((f) => f.date === sticky) : -1, feasible, centre: centre(ids), must: ids.some((id) => items.get(id)!.priority === "must") };
    });
    const day = info.map(() => -1);
    const apartGroups = list.apart ?? [];
    const clash = (u: number, v: number) => apartGroups.some((g) => info[u].ids.some((x) => g.includes(x)) && info[v].ids.some((x) => g.includes(x)));
    const cost = () => {
        let total = 0;
        for (let u = 0; u < info.length; u++) for (let v = u + 1; v < info.length; v++) if (day[u] >= 0 && day[u] === day[v] && clash(u, v)) total += 10000;
        fr.forEach((f, d) => {
            const mine = info.filter((_, u) => day[u] === d);
            const load = mine.reduce((a, u) => a + u.dur, 0);
            const cap = capacity(f);
            total += Math.max(0, load - cap) * 5;
            // spread the sights so no day sits idle until dinner while another is crowded; the last day stays lighter
            total += Math.max(0, cap * (f.backFrom ? 0.8 : 0.5) - load) * 0.8;
            for (let a = 0; a < mine.length; a++) {
                total += haversineKm(mine[a].centre, ctx.hotel) * 2;
                // on the departure day prefer sights on the way to the airport
                if (f.endAt.id !== ctx.hotel.id) total += haversineKm(mine[a].centre, f.endAt) * 3;
                for (let b = a + 1; b < mine.length; b++) total += haversineKm(mine[a].centre, mine[b].centre) * 12;
            }
        });
        info.forEach((u, i) => {
            if (u.sticky >= 0 && day[i] !== u.sticky) total += 60;
        });
        return total;
    };
    const options = (u: (typeof info)[number]) => (u.pin >= 0 ? [u.pin] : u.feasible);
    const order = info.map((_, i) => i).sort((a, b) => Number(info[b].pin >= 0) - Number(info[a].pin >= 0) || Number(info[b].must) - Number(info[a].must) || info[b].dur - info[a].dur);
    for (const u of order) {
        let best = -1;
        let bestCost = Infinity;
        for (const d of options(info[u])) {
            day[u] = d;
            const c = cost();
            if (c < bestCost) [best, bestCost] = [d, c];
        }
        day[u] = best;
    }
    let current = cost();
    for (let pass = 0; pass < 6; pass++) {
        let improved = false;
        for (let u = 0; u < info.length; u++) {
            if (info[u].pin >= 0 || day[u] < 0) continue;
            for (const d of options(info[u])) {
                const was = day[u];
                day[u] = d;
                const c = cost();
                if (c < current - 0.5) [current, improved] = [c, true];
                else day[u] = was;
            }
            for (let v = u + 1; v < info.length; v++) {
                if (info[v].pin >= 0 || day[v] === day[u] || day[v] < 0) continue;
                if (!options(info[u]).includes(day[v]) || !options(info[v]).includes(day[u])) continue;
                [day[u], day[v]] = [day[v], day[u]];
                const c = cost();
                if (c < current - 0.5) [current, improved] = [c, true];
                else [day[u], day[v]] = [day[v], day[u]];
            }
        }
        if (!improved) break;
    }
    return info.map((u, i) => ({ ids: u.ids, day: day[i] }));
}

export async function schedule(intake: Intake, list: Shortlist, registry: Registry, opts: ScheduleOptions = {}): Promise<ScheduleResult> {
    const fixedMeals = opts.fixedMeals ?? new Map<string, ShortlistItem>();
    const problems: string[] = [];
    const dropped: Dropped[] = [];
    const hotel = registry[list.hotel_place_id];
    if (!hotel) throw new Error(`hotel_place_id ${list.hotel_place_id} was not returned by geocode or search_places`);
    const seen = new Set<string>();
    // copies, so fixing an item below never changes the caller's shortlist
    const known = list.items.flatMap((i) => {
        if (!registry[i.place_id] || i.place_id === "ARR" || i.place_id === "DEP") {
            problems.push(`unknown or airport place_id ${i.place_id}, left out`);
            return [];
        }
        // a sight listed twice would be visited twice; a restaurant may be offered for both meals
        const key = `${i.place_id}|${i.meal ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...i }];
    });
    const acts = known.filter((i) => !i.meal);
    const meals = known.filter((i) => i.meal);
    const items = new Map(acts.map((i) => [i.place_id, i]));
    const ctx = await buildCtx(intake, registry, hotel, known.map((i) => registry[i.place_id]), opts.feedback);
    const prices = meals.map((m) => m.cost_per_person).sort((a, b) => a - b);
    if (prices.length) ctx.mealCost = prices[Math.floor(prices.length / 2)];
    const fr = frames(ctx);
    for (const i of acts) {
        if (i.day && !fr.some((f) => f.date === i.day)) {
            problems.push(`${i.name_en ?? registry[i.place_id].name} is pinned to ${i.day}, outside the trip; pin ignored`);
            i.day = undefined;
        }
    }

    const maxCap = Math.max(...fr.map(capacity), 60);
    const assigned = assign(makeUnits(acts, ctx, list, maxCap), fr, items, ctx, list, opts.previous);
    const byDay: ShortlistItem[][] = fr.map(() => []);
    for (const u of assigned) {
        for (const id of u.ids) {
            if (u.day < 0) {
                dropped.push({ place_id: id, name: items.get(id)!.name_en ?? registry[id].name, why: "not open long enough on any day of the trip" });
            } else byDay[u.day].push(items.get(id)!);
        }
    }

    // order each day with placeholder meals, dropping nice-to-haves from overfull days
    const orders: ShortlistItem[][] = [];
    const plans: DayPlan[] = [];
    const spare: ShortlistItem[] = [];
    fr.forEach((f, d) => {
        let acts = byDay[d];
        let order = bestOrder(f, acts, ctx);
        let plan = realize(f, order, ctx, d);
        while (plan.back > f.end + 10) {
            const nice = acts.filter((a) => a.priority === "nice");
            if (!nice.length && plan.back <= f.end + 60) {
                problems.push(`${f.date}: runs until ${minToHhmm(plan.back)} even with only must-sees; drop one or move it with a pin`);
                break;
            }
            if (!nice.length && !acts.length) break;
            const pool = nice.length ? nice : acts;
            const cut = [...pool].sort((a, b) => b.duration_min - a.duration_min)[0];
            if (!nice.length) problems.push(`${f.date}: too full even with only must-sees, ${cut.name_en ?? registry[cut.place_id].name} was left out`);
            acts = acts.filter((a) => a !== cut);
            spare.push(cut);
            order = bestOrder(f, acts, ctx);
            plan = realize(f, order, ctx, d);
        }
        byDay[d] = acts;
        orders.push(order);
        plans.push(plan);
    });

    // days that end early get spare places that fit, nearest first
    fr.forEach((f, d) => {
        while (f.backFrom && plans[d].back < f.backFrom - 20 && spare.length) {
            const centre = byDay[d].length ? registry[byDay[d][0].place_id] : f.startAt;
            const pick = spare
                .filter((s) => fitOpen(registry[s.place_id].openingHours, f.date, f.start, s.duration_min, f.end) !== null)
                .sort((a, b) => ctx.travel(centre, registry[a.place_id]) - ctx.travel(centre, registry[b.place_id]))[0];
            if (!pick) break;
            const order = bestOrder(f, [...byDay[d], pick], ctx);
            const trial = realize(f, order, ctx, d);
            if (trial.back > f.end) break;
            spare.splice(spare.indexOf(pick), 1);
            byDay[d] = [...byDay[d], pick];
            orders[d] = order;
            plans[d] = trial;
        }
    });
    for (const s of spare) dropped.push({ place_id: s.place_id, name: s.name_en ?? registry[s.place_id].name, why: "did not fit any day" });

    // restaurants for the whole trip at once, then the final timings with them
    const need: MealSlot[] = [];
    fr.forEach((f, d) => realize(f, orders[d], ctx, d, undefined, need));
    const { chosen, rejected } = assignMeals(need, meals, fr, ctx, fixedMeals);
    problems.push(...rejected);
    const dayMeals = fr.map((_, d) => {
        const mine: Partial<Record<Meal, ShortlistItem>> = {};
        need.forEach((slot, i) => {
            if (slot.day === d && chosen.has(i)) mine[slot.kind] = chosen.get(i);
        });
        return mine;
    });
    fr.forEach((f, d) => (plans[d] = realize(f, orders[d], ctx, d, dayMeals[d])));

    // estimated cost against the budget: places and meals, fares for every move that is not a walk, the rental car
    // the airport transfers count too, the checker bills both
    const travelers = intake.adults + intake.kids;
    const fare = list.local_costs.transit_fare * travelers;
    const airportRides = (registry.ARR && intake.arrivalTime && !ctx.walkable(registry.ARR, hotel) ? 1 : 0) + (registry.DEP && intake.departureTime ? 1 : 0);
    const estimateCost = () =>
        plans.reduce((a, p) => a + p.slots.reduce((b, s) => b + s.item.cost_per_person * travelers, 0) + p.rides * fare, 0) +
        (intake.getAround === "car" ? intake.carDailyRate * (intake.nights + 1) : airportRides * fare);
    while (estimateCost() > intake.budget * BUDGET_SHARE) {
        const costly = orders
            .flatMap((o, d) => o.filter((a) => a.priority === "nice" && a.cost_per_person > 0).map((a) => ({ a, d })))
            .sort((x, y) => y.a.cost_per_person - x.a.cost_per_person)[0];
        if (!costly) {
            problems.push(`estimated ${Math.round(estimateCost())} ${intake.currency} is near or over the ${intake.budget} ${intake.currency} budget; mark costly sights nice or offer cheaper restaurants`);
            break;
        }
        orders[costly.d] = orders[costly.d].filter((a) => a !== costly.a);
        plans[costly.d] = realize(fr[costly.d], orders[costly.d], ctx, costly.d, dayMeals[costly.d]);
        dropped.push({ place_id: costly.a.place_id, name: costly.a.name_en ?? registry[costly.a.place_id].name, why: "over budget" });
    }

    const days: DraftDay[] = fr.map((f, d) => {
        const plan = plans[d];
        problems.push(...plan.problems);
        if (f.backFrom && plan.back < f.backFrom - 20) {
            problems.push(`${f.date}: back at the hotel around ${minToHhmm(plan.back)}, before the ${minToHhmm(f.backFrom)} target; add a nearby sight`);
        }
        const stops: DraftStop[] = plan.slots.map((s) => ({
            place_id: s.place.id,
            start_after: s.hold ? minToHhmm(s.holdAt ?? s.start) : undefined,
            start_kind: s.hold ? s.startKind : undefined,
            duration_min: s.item.duration_min,
            cost_per_person: s.item.cost_per_person,
            meal: s.item.meal,
            name_en: s.item.name_en,
            note: s.item.note,
        }));
        const areas = [...new Set(plan.slots.filter((s) => !s.item.meal).map((s) => s.place.area?.split(",")[0] ?? s.item.name_en ?? s.place.name))];
        return { date: f.date, stops, reason: areas.length ? areas.slice(0, 3).join(" + ") : "free day" };
    });
    // long idle stretches, usually waiting for dinner, that a nearby sight could fill
    const free: string[] = [];
    plans.forEach((plan, d) => {
        for (let i = 1; i < plan.slots.length; i++) {
            const prev = plan.slots[i - 1];
            const gap = plan.slots[i].start - prev.end - ctx.travel(prev.place, plan.slots[i].place);
            if (gap >= 90) free.push(`${fr[d].date}: about ${Math.round(gap / 30) / 2} h free after ${prev.item.name_en ?? prev.place.name} (${minToHhmm(prev.end)}); add a sight nearby or leave it free`);
        }
    });
    const unusedMeals = meals.filter((m) => !plans.some((p) => p.slots.some((s) => s.item.place_id === m.place_id))).length;
    const draft: Draft = { hotel_place_id: hotel.id, local_costs: list.local_costs, days, summary: list.summary };
    const slots: MealSlotInfo[] = need.map((slot, i) => {
        const close = haversineKm(slot.from, slot.to) <= 1.5;
        const center = close ? { lat: (slot.from.lat + slot.to.lat) / 2, lon: (slot.from.lon + slot.to.lon) / 2 } : { lat: slot.from.lat, lon: slot.from.lon };
        const pick = chosen.get(i);
        const date = fr[slot.day].date;
        return { key: slotKey(date, slot.kind), date, kind: slot.kind, at: slot.at, from: slot.from, to: slot.to, center, chosen: pick && (pick.name_en ?? registry[pick.place_id]?.name) };
    });
    return { draft, problems, dropped, slots, report: report(fr, plans, days, dropped, problems, free, unusedMeals, ctx) };
}

// a finished plan's places as an unordered shortlist with no pins, so the scheduler can rearrange it; sights are
// must-sees, restaurants are meal options, and with a registry every other restaurant found during the run is
// offered too, as a real shortlist would. used by the dev reschedule button and to compare with agent-laid plans
export function shortlistFromDraft(draft: Draft, registry?: Registry): Shortlist {
    const seen = new Set<string>();
    const items: ShortlistItem[] = [];
    for (const d of draft.days)
        for (const s of d.stops) {
            if (seen.has(s.place_id)) continue;
            seen.add(s.place_id);
            const priority = s.meal ? "nice" : "must";
            // a start the scheduler marked as a commitment stays one; plain holds are left to the new schedule
            const start_after = s.start_kind === "fixed" ? s.start_after : undefined;
            items.push({ place_id: s.place_id, priority, duration_min: s.duration_min, cost_per_person: s.cost_per_person, meal: s.meal, name_en: s.name_en, note: s.note, start_after });
        }
    const mealCosts = items.filter((i) => i.meal).map((i) => i.cost_per_person).sort((a, b) => a - b);
    const typical = mealCosts[Math.floor(mealCosts.length / 2)] ?? 20;
    for (const p of Object.values(registry ?? {})) {
        if (seen.has(p.id) || !/amenity=(restaurant|cafe|fast_food)/.test(p.kind)) continue;
        for (const meal of ["lunch", "dinner"] as const) items.push({ place_id: p.id, priority: "nice", duration_min: 75, cost_per_person: typical, meal });
    }
    return { hotel_place_id: draft.hotel_place_id, local_costs: draft.local_costs, items, summary: draft.summary };
}

// what the agent reads back: estimated times per day, what was dropped and why, and problems to fix
function report(fr: Frame[], plans: DayPlan[], days: DraftDay[], dropped: Dropped[], problems: string[], free: string[], unusedMeals: number, ctx: Ctx) {
    const lines = ["times are estimates before the real transit check"];
    fr.forEach((f, d) => {
        lines.push(`${f.date} (${days[d].reason}), from ${minToHhmm(f.start)}:`);
        for (const s of plans[d].slots) lines.push(`  ${minToHhmm(s.start)}-${minToHhmm(s.end)} ${s.item.name_en ?? s.place.name}${s.item.meal ? ` (${s.item.meal})` : ""}`);
        const target = f.backFrom ? ` (target ${minToHhmm(f.backFrom)}-${minToHhmm(f.end)})` : ` (must be there by ${minToHhmm(f.end)})`;
        lines.push(`  back at ${f.endAt.id === ctx.hotel.id ? "the hotel" : f.endAt.name} about ${minToHhmm(plans[d].back)}${target}`);
    });
    lines.push(dropped.length ? `dropped: ${dropped.map((x) => `${x.name} (${x.why})`).join("; ")}` : "dropped: none");
    lines.push(problems.length ? `problems:\n${problems.map((p) => `  ${p}`).join("\n")}` : "problems: none");
    if (free.length) lines.push(`free time:\n${free.map((f) => `  ${f}`).join("\n")}`);
    lines.push(`unused meal options: ${unusedMeals}`);
    return lines.join("\n");
}
