import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { evaluatePlan } from "./checker";
import { findAirport, geocode, searchPlaces } from "./geo";
import { addDays, minToHhmm } from "./time";
import type { Draft, Evaluation, Intake, Place, Registry, StreamEvent } from "./types";

const MODEL = "claude-opus-5-5";
const MAX_SUBMISSIONS = 4;
const MAX_TURNS = 30;

// created on first use so the app still loads without a key
let client: Anthropic | undefined;

const SYSTEM = `You are the planning agent inside a trip planner. You build day-by-day itineraries from real places.

Rules:
- Every place in a plan must come from a geocode or search_places result. Refer to it by its id. Never invent places or ids.
- You do not compute travel times, routes or schedules. Submit the plan with submit_plan. The app routes every leg with real walking, driving and public transit timetable data, builds the schedule, checks opening hours, flights and budget, and returns the problems it finds.
- Fix every error the app reports and submit again. Warnings may stay when there is no better option. Stop when a submission has no errors, or when the app says no more submissions are allowed.
- Group each day's stops by area to keep travel short. Pace: relaxed 2-3 stops, normal 3-5, packed 5-7 per full day. Arrival and departure days are partial days.
- Include a lunch stop, and dinner when the day runs into the evening, chosen from food results.
- local_costs and cost_per_person are your estimates in the trip currency; the app labels them as estimates. Use 0 for free places.
- ARR and DEP are the arrival and departure airports when given. The app adds the airport legs itself; never add airports as stops.
- If no hotel is given, pick a well-connected central place from your results as the base and use its id as hotel_place_id.
- After your last submission, reply with 2-3 plain sentences for the traveler, including anything the data could not confirm.`;

const GeocodeInput = z.object({ query: z.string().min(1) });
const SearchInput = z.object({
    near_place_id: z.string(),
    keyword: z.string().min(2),
    radius_m: z.number().min(200).max(25000),
});
const StopSchema = z.object({
    place_id: z.string(),
    start_after: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    duration_min: z.number().min(5).max(600),
    cost_per_person: z.number().min(0),
    note: z.string().optional(),
});
const DraftSchema = z.object({
    hotel_place_id: z.string(),
    local_costs: z.object({
        transit_fare: z.number().min(0),
        taxi_base: z.number().min(0),
        taxi_per_km: z.number().min(0),
        fuel_per_km: z.number().min(0),
        parking_per_stop: z.number().min(0),
    }),
    days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), stops: z.array(StopSchema) })),
    summary: z.string(),
});

const TOOLS: Anthropic.Beta.BetaTool[] = [
    {
        name: "geocode",
        description: "Find places by name or address (a landmark, a neighborhood, a hotel, a specific restaurant). Returns up to 5 places with ids, coordinates and opening hours when known. Results are biased toward the destination.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        eager_input_streaming: true,
    },
    {
        name: "search_places",
        description: "List real places matching one keyword around a known place, nearest first, with opening hours when known. Use plain type words like museum, temple, shrine, park, restaurant, cafe, ramen, market, zoo, viewpoint. A keyword with no results returns nothing; try another word, or geocode a specific place by name.",
        input_schema: {
            type: "object",
            properties: {
                near_place_id: { type: "string", description: "id of a place from an earlier result" },
                keyword: { type: "string", description: "one place type, e.g. museum" },
                radius_m: { type: "number", description: "search radius in meters, 200 to 25000" },
            },
            required: ["near_place_id", "keyword", "radius_m"],
        },
        eager_input_streaming: true,
    },
    {
        name: "submit_plan",
        description: "Submit the full itinerary. The app routes and checks it and returns the schedule with errors and warnings. Always send every day of the trip.",
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
                days: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            date: { type: "string", description: "YYYY-MM-DD" },
                            stops: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        place_id: { type: "string" },
                                        start_after: { type: "string", description: "optional HH:MM, earliest local start" },
                                        duration_min: { type: "number" },
                                        cost_per_person: { type: "number" },
                                        note: { type: "string" },
                                    },
                                    required: ["place_id", "duration_min", "cost_per_person"],
                                },
                            },
                        },
                        required: ["date", "stops"],
                    },
                },
                summary: { type: "string", description: "one line on the plan's idea" },
            },
            required: ["hotel_place_id", "local_costs", "days", "summary"],
        },
        eager_input_streaming: true,
    },
];

function placeLine(p: Place) {
    return `${p.id} | ${p.name} | ${p.kind} | ${p.lat.toFixed(4)},${p.lon.toFixed(4)}${p.openingHours ? ` | hours: ${p.openingHours}` : ""}`;
}

export function describeEvaluation(ev: Evaluation, registry: Registry) {
    const name = (id: string) => registry[id]?.name ?? id;
    const lines: string[] = [];
    const errors = ev.issues.filter((i) => i.level === "error");
    const warnings = ev.issues.filter((i) => i.level === "warning");
    lines.push(`errors: ${errors.length}`);
    for (const e of errors) lines.push(`  ERROR [${e.code}]${e.day ? ` ${e.day}` : ""}: ${e.message}`);
    lines.push(`warnings: ${warnings.length}`);
    for (const w of warnings) lines.push(`  warning [${w.code}]${w.day ? ` ${w.day}` : ""}: ${w.message}`);
    for (const d of ev.days) {
        lines.push(`${d.date}:`);
        for (const l of d.legs) {
            lines.push(`  ${minToHhmm(l.departMin)} ${l.mode} ${Math.round(l.minutes)} min ${name(l.fromId)} → ${name(l.toId)}${l.lines.length ? ` (${l.lines.join(", ")})` : ""}`);
        }
        for (const s of d.stops) {
            lines.push(`  stop ${minToHhmm(s.startMin)}-${minToHhmm(s.endMin)} ${s.name} [hours ${s.hours}]`);
        }
    }
    const t = ev.totals;
    lines.push(`totals: activities ${Math.round(t.activities)}, transport ${Math.round(t.transport)}, car ${Math.round(t.car)}, total ${Math.round(t.total)} of budget ${t.budget}`);
    return lines.join("\n");
}

function score(ev: Evaluation) {
    return ev.issues.filter((i) => i.level === "error").length * 100 + ev.issues.length;
}

export async function prepareRegistry(intake: Intake, log: (m: string) => void): Promise<Registry> {
    const registry: Registry = {};
    log(`finding ${intake.destination}`);
    const center = (await geocode(intake.destination))[0];
    if (!center) throw new Error(`could not find "${intake.destination}"`);
    registry[center.id] = center;
    const airport = async (code: string, alias: "ARR" | "DEP") => {
        if (!code) return;
        log(`finding airport ${code}`);
        const hit = await findAirport(code, center);
        if (hit) registry[alias] = { ...hit, id: alias };
        else log(`could not find airport ${code}, skipping airport legs`);
    };
    await airport(intake.arrivalAirport, "ARR");
    await airport(intake.departureAirport, "DEP");
    if (intake.hotel) {
        log(`finding hotel ${intake.hotel}`);
        for (const h of await geocode(intake.hotel, center)) registry[h.id] = h;
    }
    return registry;
}

export async function runAgent(
    intake: Intake,
    emit: (e: StreamEvent) => void,
    prior?: { registry: Registry; draft: Draft; evaluation: Evaluation; instruction: string },
) {
    const log = (msg: string) => emit({ type: "log", msg });
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("no Claude credentials: put ANTHROPIC_API_KEY=... in trip-planner/.env.local and restart the server");
    }
    const registry: Registry = prior ? { ...prior.registry } : await prepareRegistry(intake, log);
    const lastDate = addDays(intake.startDate, intake.nights);

    let userText = `Trip request (dates ${intake.startDate} to ${lastDate}, ${intake.nights} nights):\n${JSON.stringify(intake, null, 2)}\n\nKnown places (id | name | kind | lat,lon | hours):\n${Object.values(registry).map(placeLine).join("\n")}`;
    if (prior) {
        userText += `\n\nCurrent plan:\n${JSON.stringify(prior.draft)}\n\nIts check result:\n${describeEvaluation(prior.evaluation, registry)}\n\nThe traveler asks for this change: ${prior.instruction}\nChange only what the request needs, then submit the full plan.`;
    } else {
        userText += `\n\nPlan the trip.`;
    }
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userText }];

    let best: { draft: Draft; evaluation: Evaluation } | undefined;
    let submissions = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        client ??= new Anthropic();
        const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 64000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "medium" },
            cache_control: { type: "ephemeral" },
            system: SYSTEM,
            tools: TOOLS,
            messages,
        });
        const message = await stream.finalMessage().catch((e: unknown) => {
            // surface the api's own message instead of the raw json body
            if (e instanceof Anthropic.APIError) {
                const body = e.error as { error?: { message?: string } } | undefined;
                throw new Error(`Claude API ${e.status ?? ""}: ${body?.error?.message ?? e.message}`);
            }
            throw e;
        });

        if (message.stop_reason === "refusal") throw new Error("the model declined this request");
        messages.push({ role: "assistant", content: message.content });
        for (const b of message.content) if (b.type === "text" && b.text.trim()) log(`agent: ${b.text.trim()}`);

        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (calls.length === 0 || message.stop_reason === "end_turn") break;
        if (message.stop_reason === "max_tokens") throw new Error("the model's output was cut off");

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
            const result = await runTool(call, intake, registry, log, () => submissions, (d, ev) => {
                submissions++;
                if (!best || score(ev) <= score(best.evaluation)) best = { draft: d, evaluation: ev };
            });
            results.push({ type: "tool_result", tool_use_id: call.id, content: result.text, is_error: result.error });
        }
        messages.push({ role: "user", content: results });
        if (submissions >= MAX_SUBMISSIONS && best && score(best.evaluation) >= 100) {
            log(`stopping after ${submissions} submissions, keeping the best one`);
            break;
        }
    }

    if (!best) throw new Error("the agent never submitted a plan");
    emit({ type: "result", draft: best.draft, evaluation: best.evaluation, registry });
}

async function runTool(
    call: Anthropic.Beta.BetaToolUseBlock,
    intake: Intake,
    registry: Registry,
    log: (m: string) => void,
    submissions: () => number,
    onPlan: (d: Draft, ev: Evaluation) => void,
): Promise<{ text: string; error: boolean }> {
    try {
        if (call.name === "geocode") {
            const input = GeocodeInput.parse(call.input);
            log(`geocode "${input.query}"`);
            const center = Object.values(registry)[0];
            const hits = await geocode(input.query, center);
            for (const h of hits) registry[h.id] = h;
            return { text: hits.length ? hits.map(placeLine).join("\n") : "no results", error: false };
        }
        if (call.name === "search_places") {
            const input = SearchInput.parse(call.input);
            const near = registry[input.near_place_id];
            if (!near) return { text: `unknown place id ${input.near_place_id}`, error: true };
            log(`search "${input.keyword}" near ${near.name}`);
            const hits = await searchPlaces(near, input.keyword, input.radius_m);
            for (const h of hits) registry[h.id] = h;
            return { text: hits.length ? hits.map(placeLine).join("\n") : "no results", error: false };
        }
        if (call.name === "submit_plan") {
            if (submissions() >= MAX_SUBMISSIONS) return { text: "No more submissions are allowed. Write your summary for the traveler now.", error: true };
            const draft = DraftSchema.parse(call.input) as Draft;
            log(`checking submission ${submissions() + 1}`);
            const ev = await evaluatePlan(intake, draft, registry, log);
            onPlan(draft, ev);
            const left = MAX_SUBMISSIONS - submissions();
            return { text: `${describeEvaluation(ev, registry)}\n\nsubmissions left: ${left}`, error: false };
        }
        return { text: `unknown tool ${call.name}`, error: true };
    } catch (e) {
        const msg = e instanceof z.ZodError ? `invalid input: ${e.message}` : e instanceof Error ? e.message : String(e);
        log(`${call.name} failed: ${msg}`);
        return { text: msg, error: true };
    }
}
