import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callModel, checkCredentials, knownPlaces, placeLine, prepareRegistry, runSearch, SEARCH_TOOLS, UsageTotals } from "./agent";
import { haversineKm, searchPlaces } from "./geo";
import { mealMisfit, schedule, type MealSlotInfo, type ScheduleResult } from "./scheduler";
import { DINNER, LUNCH } from "./rules";
import { addDays, minToHhmm } from "./time";
import type { Draft, Intake, Place, Prior, Registry, Shortlist, ShortlistItem, StreamEvent } from "./types";
import { verify, type Verified } from "./verify";

// the agent chooses what is worth doing, the scheduler arranges it, then the agent picks restaurants for the
// meal slots the scheduler left, using web search for quality, and real transit verifies the plan once

const MAX_SCHEDULES = 4;
const MAX_MEAL_ROUNDS = 3;
const MAX_FINALIZES = 2;
const MAX_TURNS = 40;
// web searches per run. a fixed number keeps the tool list identical across trips, so the prompt cache that
// starts with it can be shared; search results are the largest thing the conversation carries
const WEB_SEARCHES = 6;
// nearby open restaurants listed per meal slot, and how far around the slot to look
const CANDIDATES_PER_SLOT = 6;
const CANDIDATE_RADIUS_M = 700;
// notable sights looked up before the agent starts, so it needs fewer search turns
const NOTABLE_KEYWORDS = ["attraction", "museum"];
const NOTABLE_RADIUS_M = 6000;
const MAX_NOTABLE = 25;

const SYSTEM = `You are the planning agent inside a trip planner. You decide what is worth doing and where to eat; the app's scheduler decides days, order and times.

How to work:
1. Find sights with geocode (a named place) and search_places (a type of place near a known one). Every place you use must come from these tools' results or the known places in the request; refer to it by its id. Never invent places or ids. Searches do not depend on each other, so make several geocode and search_places calls in the same turn rather than one per turn.
2. Call schedule_trip with a shortlist of the hotel and the sights and activities, without restaurants. The scheduler groups nearby places into days, orders them, fits opening hours and the traveler's pace, and reports the days, what it dropped, problems, free time and the meal slots: when and where each lunch and dinner falls, with restaurants near that spot that are open then. It uses estimated travel times, so it is quick and free; call it up to ${MAX_SCHEDULES} times.
3. Improve the shortlist from the report (add sights where a day has free time or ends early, replace dropped places, fix impossible pins) and schedule again if needed.
4. Choose a restaurant for every meal slot with choose_meals, all slots in one call where you can. Quality matters: use web_search to find well-reviewed places near the slots, one search per area rather than per meal (at most ${WEB_SEARCHES} searches), for example "best lunch near Museum of Fine Arts Boston". The pick must be near its slot: take one of the listed candidates, or geocode a well-reviewed place you found by name and use its id. choose_meals rejects places too far from the slot or closed at that time; pick again for those. Vary cuisines across the trip, keep the budget in mind, and say in the note why the place is worth it.
5. Call finalize_trip, which checks the plan against real transit timetables, re-arranges it with the real travel times if needed and makes small automatic fixes. Then reply with 2-3 plain sentences for the traveler describing the final plan, including anything dropped or that the data could not confirm.

Shortlist rules:
- Offer enough for the pace plus a few spares: relaxed 2-3, normal 3-5, packed 5-7 sights per full day. Priority "must" for the traveler's must-sees and the destination's highlights, "nice" for the rest; the scheduler drops nice ones first.
- A restaurant goes in the shortlist only when it is a destination worth a trip by itself; mark it with meal and priority "must". Every other meal is chosen in step 4.
- duration_min is a realistic visit length. cost_per_person and local_costs are your estimates in the trip currency; 0 for free places.
- Pin only real intent: day for a date the traveler asked for or a place only worth visiting then, time for things like a late opening, sunset or a morning market, start_after only for a fixed start the traveler must make, such as a booked tour. together and apart record traveler requests to keep places on one day or on different days. Do not pin to arrange the days yourself; the scheduler does that.
- Mix the traveler's interests with the destination's best-known sights; do not repeat one kind of place all trip.
- Write everything in English. When a place's name is in another script, set name_en to its common English name or a romanization, for example "Ueno Seiyoken".
- ARR and DEP are the airports; the app adds airport transfers. Never put airports in the shortlist.
- If no hotel is given, pick a well-connected central place from your results as the base.`;

const ItemSchema = z.object({
    place_id: z.string(),
    priority: z.enum(["must", "nice"]),
    duration_min: z.number().min(5).max(600),
    cost_per_person: z.number().min(0),
    meal: z.enum(["lunch", "dinner"]).optional(),
    name_en: z.string().optional(),
    note: z.string().optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    time: z.enum(["morning", "afternoon", "evening"]).optional(),
    start_after: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
const ShortlistSchema = z.object({
    hotel_place_id: z.string(),
    local_costs: z.object({
        transit_fare: z.number().min(0),
        taxi_base: z.number().min(0),
        taxi_per_km: z.number().min(0),
        fuel_per_km: z.number().min(0),
        parking_per_stop: z.number().min(0),
    }),
    items: z.array(ItemSchema).min(1),
    together: z.array(z.array(z.string()).min(2)).optional(),
    apart: z.array(z.array(z.string()).min(2)).optional(),
    summary: z.string(),
});
const MealsSchema = z.object({
    choices: z
        .array(
            z.object({
                slot: z.string(),
                place_id: z.string(),
                cost_per_person: z.number().min(0),
                name_en: z.string().optional(),
                note: z.string().optional(),
            }),
        )
        .min(1),
});

const groups = { type: "array", items: { type: "array", items: { type: "string" } } };

// built once: the same bytes on every request and every trip, so the cached prefix is reused
const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
    ...SEARCH_TOOLS(),
    // reviews and best-of lists for restaurant quality, which the map data does not have
    { type: "web_search_20260209", name: "web_search", max_uses: WEB_SEARCHES },
    {
        name: "schedule_trip",
        description:
            "Arrange a shortlist of sights into days with estimated times. Returns each day, what was dropped and why, problems, free time, and the meal slots with nearby open restaurants. Quick and free; call again with an improved shortlist.",
        input_schema: {
            type: "object",
            properties: {
                hotel_place_id: { type: "string" },
                local_costs: {
                    type: "object",
                    properties: {
                        transit_fare: { type: "number", description: "one ride, one person" },
                        taxi_base: { type: "number" },
                        taxi_per_km: { type: "number" },
                        fuel_per_km: { type: "number" },
                        parking_per_stop: { type: "number" },
                    },
                    required: ["transit_fare", "taxi_base", "taxi_per_km", "fuel_per_km", "parking_per_stop"],
                },
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            place_id: { type: "string" },
                            priority: { type: "string", enum: ["must", "nice"] },
                            duration_min: { type: "number" },
                            cost_per_person: { type: "number" },
                            meal: { type: "string", enum: ["lunch", "dinner"], description: "only for a destination restaurant worth a trip by itself" },
                            name_en: { type: "string", description: "English name or romanization when the place name is in another script" },
                            note: { type: "string", description: "short note in English" },
                            day: { type: "string", description: "optional YYYY-MM-DD pin, only for real intent" },
                            time: { type: "string", enum: ["morning", "afternoon", "evening"], description: "optional part-of-day pin" },
                            start_after: { type: "string", description: "optional fixed start HH:MM the traveler must make, e.g. a booked tour" },
                        },
                        required: ["place_id", "priority", "duration_min", "cost_per_person"],
                    },
                },
                together: { ...groups, description: "groups of place ids the traveler wants on the same day" },
                apart: { ...groups, description: "groups of place ids the traveler wants on different days" },
                summary: { type: "string", description: "one line on the plan's idea" },
            },
            required: ["hotel_place_id", "local_costs", "items", "summary"],
        },
        eager_input_streaming: true,
    },
    {
        name: "choose_meals",
        description:
            "Pick a restaurant for meal slots from the latest schedule, by slot name such as '2027-01-15 lunch'. Each pick must be near its slot and open then; rejected picks come back with the reason. Returns the updated schedule.",
        input_schema: {
            type: "object",
            properties: {
                choices: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            slot: { type: "string", description: "slot name from the schedule report" },
                            place_id: { type: "string", description: "a listed candidate, or a place you found with geocode or search_places" },
                            cost_per_person: { type: "number" },
                            name_en: { type: "string" },
                            note: { type: "string", description: "why it is worth it, e.g. what reviews praise" },
                        },
                        required: ["slot", "place_id", "cost_per_person"],
                    },
                },
            },
            required: ["choices"],
        },
        eager_input_streaming: true,
    },
    {
        name: "finalize_trip",
        description: "Check the latest schedule against real transit timetables, re-arrange it with real travel times and make small automatic fixes if needed, and return the final plan with any remaining problems.",
        input_schema: { type: "object", properties: {} },
    },
];

const mealLength = (slot: MealSlotInfo) => (slot.kind === "lunch" ? LUNCH.length : DINNER.length);
const RESTAURANT = /amenity=(restaurant|cafe|pub|food_court)/;

// restaurants near each open meal slot that are open then, added to the registry so the agent can pick them by id
async function mealCandidates(result: ScheduleResult, registry: Registry, log: (m: string) => void) {
    const lines: string[] = [];
    for (const slot of result.slots) {
        const where = slot.from.id === slot.to.id ? slot.from.name : `${slot.from.name}, then ${slot.to.name}`;
        if (slot.chosen) {
            lines.push(`[${slot.key}] ~${minToHhmm(slot.at)} near ${where}: ${slot.chosen}`);
            continue;
        }
        log(`finding restaurants for ${slot.key}`);
        const hits = await searchPlaces(slot.center, "restaurant", CANDIDATE_RADIUS_M).catch(() => []);
        const near = hits
            .filter((p) => RESTAURANT.test(p.kind) || (slot.kind === "lunch" && p.kind === "amenity=fast_food"))
            .filter((p) => mealMisfit(slot, p) === null)
            .slice(0, CANDIDATES_PER_SLOT);
        for (const p of near) registry[p.id] ??= p;
        lines.push(`[${slot.key}] ~${minToHhmm(slot.at)}, ${mealLength(slot)} min, near ${where}; nearby and open:`);
        lines.push(...(near.length ? near.map((p) => `    ${placeLine(p)} | ${Math.round(haversineKm(slot.center, p) * 1000)} m`) : ["    none listed; find one with web_search and geocode"]));
    }
    return `meal slots, choose with choose_meals:\n${lines.join("\n")}`;
}

// well-known sights around the destination from the map data (places with a wikipedia or wikidata link),
// so the agent can shortlist the obvious highlights without spending turns finding them
async function notableNearby(center: Place, registry: Registry, log: (m: string) => void): Promise<Place[]> {
    log("looking up notable sights nearby");
    const found = new Map<string, Place>();
    for (const keyword of NOTABLE_KEYWORDS) {
        const hits = await searchPlaces(center, keyword, NOTABLE_RADIUS_M).catch(() => []);
        for (const p of hits) if (p.notable && !found.has(p.id)) found.set(p.id, p);
    }
    const list = [...found.values()].slice(0, MAX_NOTABLE);
    for (const p of list) registry[p.id] ??= p;
    return list;
}

// what the agent reads after the real check: problems, then each day as it will be shown
function describeFinal(v: Verified, registry: Registry) {
    const lines: string[] = [];
    const errors = v.evaluation.issues.filter((i) => i.level === "error");
    const warnings = v.evaluation.issues.filter((i) => i.level === "warning");
    lines.push(`errors: ${errors.length}`, ...errors.map((e) => `  [${e.code}] ${e.day ?? ""} ${e.message}`));
    lines.push(`warnings: ${warnings.length}`, ...warnings.map((w) => `  [${w.code}] ${w.day ?? ""} ${w.message}`));
    if (v.adjustments.length) lines.push("automatic fixes and notes:", ...v.adjustments.map((a) => `  ${a}`));
    for (const d of v.evaluation.days) {
        const last = d.legs[d.legs.length - 1];
        const stops = d.stops.map((s) => `${minToHhmm(s.startMin)} ${s.name}${s.meal ? ` (${s.meal})` : ""}`).join(", ");
        lines.push(`${d.date}: ${stops || "no stops"}${last ? `; ends ${minToHhmm(last.arriveMin)} at ${registry[last.toId]?.name ?? last.toId}` : ""}`);
    }
    const t = v.evaluation.totals;
    lines.push(`total ${Math.round(t.total)} of budget ${t.budget}`);
    return lines.join("\n");
}

// the previous plan in a form the agent can rebuild a shortlist from
function describePrior(draft: Draft, registry: Registry) {
    return draft.days
        .map((d) => `${d.date}: ${d.stops.map((s) => `${s.place_id} ${s.name_en ?? registry[s.place_id]?.name ?? ""}${s.meal ? ` (${s.meal})` : ""} ${s.duration_min} min`).join("; ")}`)
        .join("\n");
}

export async function runPlanner(intake: Intake, emit: (e: StreamEvent) => void, prior?: Prior, signal?: AbortSignal) {
    const log = (msg: string) => emit({ type: "log", msg });
    checkCredentials();
    const registry: Registry = prior ? { ...prior.registry } : await prepareRegistry(intake, log);
    const lastDate = addDays(intake.startDate, intake.nights);
    const usage = new UsageTotals();

    let userText = `Trip request (dates ${intake.startDate} to ${lastDate}, ${intake.nights} nights):\n${JSON.stringify(intake, null, 2)}\n\nKnown places (id | name | kind | area | lat,lon | hours):\n${knownPlaces(registry, prior?.draft)}`;
    if (prior) {
        userText += `\n\nCurrent plan:\n${describePrior(prior.draft, registry)}\n\nThe traveler asks for this change: ${prior.instruction}\nBuild a shortlist from the current plan's sights and keep them unless the request changes them; the scheduler keeps places on their current days where it can. Keep the current restaurants with choose_meals unless the request is about food or a meal slot moved.`;
    } else {
        const center = Object.values(registry)[0];
        const notable = center ? await notableNearby(center, registry, log) : [];
        if (notable.length) userText += `\n\nNotable sights near ${intake.destination} from the map data; use their ids directly, no need to search for them again:\n${notable.map(placeLine).join("\n")}`;
        userText += "\n\nPlan the trip.";
    }
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userText }];

    let list: Shortlist | undefined;
    let scheduled: ScheduleResult | undefined;
    let final: Verified | undefined;
    // restaurants chosen per meal slot, kept across later schedule rounds
    const meals = new Map<string, ShortlistItem>();
    let schedules = 0;
    let mealRounds = 0;
    let finalizes = 0;
    let reply = "";

    const rescheduled = async () => {
        scheduled = await schedule(intake, list!, registry, { previous: scheduled?.draft ?? prior?.draft, fixedMeals: meals });
        log(`scheduled: ${scheduled.dropped.length} dropped, ${scheduled.problems.length} problems`);
        return `${scheduled.report}\n\n${await mealCandidates(scheduled, registry, log)}`;
    };

    try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            const message = await callModel(SYSTEM, TOOLS, messages, signal);
            usage.add(message.usage);
            const u = message.usage;
            const searches = u.server_tool_use?.web_search_requests ?? 0;
            log(`tokens: ${u.input_tokens} in, ${u.cache_read_input_tokens ?? 0} cached, ${u.cache_creation_input_tokens ?? 0} cache write, ${u.output_tokens} out${searches ? `, ${searches} web searches` : ""}`);
            if (message.stop_reason === "refusal") throw new Error("the model declined this request");
            messages.push({ role: "assistant", content: message.content });
            for (const b of message.content) {
                if (b.type === "server_tool_use" && b.name === "web_search") log(`web search "${(b.input as { query?: string }).query ?? ""}"`);
                if (b.type !== "text" || !b.text.trim()) continue;
                log(`agent: ${b.text.trim()}`);
                reply = b.text.trim();
            }
            // a long web search turn pauses; sending the conversation back as it is lets it resume
            if (message.stop_reason === "pause_turn") continue;
            const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
            if (calls.length === 0 || message.stop_reason === "end_turn") break;
            if (message.stop_reason === "max_tokens") throw new Error("the model's output was cut off");

            const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
            for (const call of calls) {
                let out: { text: string; error: boolean };
                try {
                    const searched = await runSearch(call, registry, log);
                    if (searched) out = searched;
                    else if (call.name === "schedule_trip") {
                        if (schedules >= MAX_SCHEDULES) out = { text: "No more schedule_trip calls are allowed. Choose meals, then call finalize_trip.", error: true };
                        else {
                            list = ShortlistSchema.parse(call.input) as Shortlist;
                            schedules++;
                            log(`scheduling ${list.items.length} places (round ${schedules})`);
                            out = { text: `${await rescheduled()}\n\nschedule_trip calls left: ${MAX_SCHEDULES - schedules}`, error: false };
                        }
                    } else if (call.name === "choose_meals") {
                        if (!scheduled || !list) out = { text: "Call schedule_trip first.", error: true };
                        else if (mealRounds >= MAX_MEAL_ROUNDS) out = { text: "No more choose_meals calls are allowed. Call finalize_trip now.", error: true };
                        else {
                            mealRounds++;
                            const input = MealsSchema.parse(call.input);
                            const rejected: string[] = [];
                            const slots = new Map(scheduled.slots.map((s) => [s.key, s]));
                            for (const c of input.choices) {
                                const slot = slots.get(c.slot);
                                const p = registry[c.place_id];
                                // only picks for slots that still exist count; an old pick for a slot that moved away
                                // must not block the same restaurant elsewhere
                                const usedElsewhere = [...meals].some(([key, m]) => key !== c.slot && slots.has(key) && m.place_id === c.place_id);
                                const misfit = slot && p ? mealMisfit(slot, p) : null;
                                if (!slot) rejected.push(`${c.slot}: no such meal slot in the latest schedule`);
                                else if (!p) rejected.push(`${c.slot}: unknown place id ${c.place_id}; geocode it first`);
                                else if (misfit) rejected.push(`${c.slot}: ${misfit}`);
                                else if (usedElsewhere) rejected.push(`${c.slot}: ${p.name} is already used for another meal`);
                                else meals.set(c.slot, { place_id: c.place_id, priority: "nice", duration_min: mealLength(slot), cost_per_person: c.cost_per_person, meal: slot.kind, name_en: c.name_en, note: c.note });
                            }
                            log(`meals chosen: ${input.choices.length - rejected.length} of ${input.choices.length}`);
                            const report = await rescheduled();
                            out = { text: `${rejected.length ? `rejected:\n${rejected.map((r) => `  ${r}`).join("\n")}\n\n` : ""}${report}\n\nchoose_meals calls left: ${MAX_MEAL_ROUNDS - mealRounds}`, error: false };
                        }
                    } else if (call.name === "finalize_trip") {
                        if (!scheduled || !list) out = { text: "Call schedule_trip first.", error: true };
                        else if (finalizes >= MAX_FINALIZES) out = { text: "No more finalize_trip calls are allowed. Write your summary for the traveler now.", error: true };
                        else {
                            finalizes++;
                            log("checking the schedule with real transit");
                            final = await verify(intake, list, scheduled.draft, registry, { log, meals, signal });
                            out = { text: `${describeFinal(final, registry)}\n\nNow reply with 2-3 sentences for the traveler about this final plan.`, error: false };
                        }
                    } else out = { text: `unknown tool ${call.name}`, error: true };
                } catch (e) {
                    // a cancelled run stops here instead of telling the model about it
                    if (signal?.aborted) throw e;
                    const msg = e instanceof z.ZodError ? `invalid input: ${e.message}` : e instanceof Error ? e.message : String(e);
                    log(`${call.name} failed: ${msg}`);
                    out = { text: msg, error: true };
                }
                results.push({ type: "tool_result", tool_use_id: call.id, content: out.text, is_error: out.error });
            }
            messages.push({ role: "user", content: results });
        }
    } finally {
        log(usage.summary());
    }

    // the agent may stop without finalizing, the last schedule is still checked before it is shown
    if (!final && scheduled && list) {
        log("checking the last schedule with real transit");
        final = await verify(intake, list, scheduled.draft, registry, { log, meals, signal });
    }
    if (!final) throw new Error("the agent never scheduled a plan");
    for (const a of final.adjustments) log(a);
    const summary = (finalizes > 0 && reply) || list?.summary || "";
    emit({ type: "result", draft: { ...final.draft, summary }, evaluation: final.evaluation, registry });
}
