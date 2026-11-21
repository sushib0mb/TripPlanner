"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import Itinerary from "@/components/Itinerary";
import TripForm from "@/components/TripForm";
import type { Focus } from "@/components/TripMap";
import { SAMPLES, type Sample } from "@/lib/samplePlan";
import type { Draft, Evaluation, Intake, Registry, StreamEvent } from "@/lib/types";

// the map needs the browser
const TripMap = dynamic(() => import("@/components/TripMap"), { ssr: false });

const DEFAULT_INTAKE: Intake = {
    destination: "Tokyo",
    startDate: "2026-12-02",
    nights: 3,
    arrivalAirport: "Haneda",
    arrivalTime: "09:30",
    departureAirport: "Haneda",
    departureTime: "19:00",
    hotel: "Shinjuku Station",
    adults: 2,
    kids: 0,
    budget: 600,
    currency: "USD",
    getAround: "mix",
    maxWalkMin: 15,
    carDailyRate: 60,
    pace: "normal",
    interests: "temples, museums, ramen",
};

interface Plan {
    draft: Draft;
    evaluation: Evaluation;
    registry: Registry;
}

// a failed request's own message, e.g. the rate limit, instead of a json parse error
async function readJson<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error ?? `the server answered ${res.status}`);
    return body;
}

export default function Home() {
    const [intake, setIntake] = useState<Intake>(DEFAULT_INTAKE);
    const [plan, setPlanState] = useState<Plan | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [instruction, setInstruction] = useState("");
    // the new flow where a scheduler arranges the agent's picks, or the older one where the agent writes every day
    const [planner, setPlanner] = useState<"scheduler" | "agent">("scheduler");
    // what the map shows and points at, shared with the itinerary
    const [day, setDay] = useState<number | null>(null);
    const [focus, setFocus] = useState<Focus | null>(null);
    // the plan run in progress, so it can be stopped before it spends more tokens
    const [running, setRunning] = useState<AbortController | null>(null);

    const addLog = (...lines: string[]) => setLog((l) => [...l, ...lines]);
    const fail = (e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") addLog("stopped");
        else addLog("error: " + (e instanceof Error ? e.message : String(e)));
    };

    // a new plan starts with the whole trip in view
    function setPlan(next: Plan) {
        setPlanState(next);
        setFocus(null);
        setDay((d) => (d !== null && d < next.evaluation.days.length ? d : null));
    }

    // reads the agent's newline-delimited json event stream
    async function streamPlan(body: object, signal: AbortSignal) {
        setLog([]);
        const res = await fetch("/api/plan", { method: "POST", body: JSON.stringify(body), signal });
        if (!res.ok || !res.body) {
            await readJson(res);
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                const e = JSON.parse(line) as StreamEvent;
                if (e.type === "log") addLog(e.msg);
                else if (e.type === "error") addLog("error: " + e.msg);
                else setPlan({ draft: e.draft, evaluation: e.evaluation, registry: e.registry });
            }
        }
    }

    function run(body: object) {
        const controller = new AbortController();
        setRunning(controller);
        setBusy(true);
        streamPlan(body, controller.signal)
            .catch(fail)
            .finally(() => {
                setRunning(null);
                setBusy(false);
            });
    }

    // re-routes and re-checks a changed plan without calling the model
    function check(draft: Draft, registry: Registry, forIntake: Intake = intake) {
        setBusy(true);
        fetch("/api/check", { method: "POST", body: JSON.stringify({ intake: forIntake, draft, registry }) })
            .then((r) => readJson<{ evaluation: Evaluation }>(r))
            .then((data) => setPlan({ draft, evaluation: data.evaluation, registry }))
            .catch(fail)
            .finally(() => setBusy(false));
    }

    // by position in the day, so removing a sight never takes the meal held at the same place with it
    function removeStop(date: string, index: number) {
        if (!plan) return;
        const draft: Draft = {
            ...plan.draft,
            days: plan.draft.days.map((d) => (d.date === date ? { ...d, stops: d.stops.filter((_, i) => i !== index) } : d)),
        };
        check(draft, plan.registry);
    }

    // dev only: routes and checks a fixed plan without calling claude
    function loadSample({ name, intake, draft, registry }: Sample) {
        setLog([`dev: checking ${name} sample plan, no claude call`]);
        setIntake(intake);
        check(draft, registry, intake);
    }

    // dev only: rearranges the plan on screen with the scheduler and real transit, no claude call
    function reschedule() {
        if (!plan) return;
        setBusy(true);
        addLog("dev: rescheduling the plan on screen, no claude call");
        fetch("/api/dev/reschedule", { method: "POST", body: JSON.stringify({ intake, draft: plan.draft, registry: plan.registry }) })
            .then((r) => readJson<{ draft: Draft; evaluation: Evaluation; report: string; adjustments: string[] }>(r))
            .then((d) => {
                setPlan({ ...plan, draft: d.draft, evaluation: d.evaluation });
                addLog(d.report, ...d.adjustments);
            })
            .catch(fail)
            .finally(() => setBusy(false));
    }

    // dev only: keeps the plan on screen as a sample file, named after the destination
    function saveSample() {
        if (!plan) return;
        const name = intake.destination.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        fetch("/api/dev/save-sample", { method: "POST", body: JSON.stringify({ name, intake, draft: plan.draft, registry: plan.registry }) })
            .then((r) => readJson<{ saved: string }>(r))
            .then((d) => addLog(`dev: saved ${d.saved}`))
            .catch(fail);
    }

    return (
        <main>
            <h1>trip planner</h1>
            <TripForm intake={intake} busy={busy} onChange={setIntake} onSubmit={() => run({ intake, planner })} />
            {running && (
                <button type="button" onClick={() => running.abort()}>
                    stop planning
                </button>
            )}
            {process.env.NODE_ENV === "development" && (
                <label>
                    dev: planner{" "}
                    <select value={planner} onChange={(e) => setPlanner(e.target.value as "scheduler" | "agent")}>
                        <option value="scheduler">agent picks, scheduler arranges</option>
                        <option value="agent">agent writes every day (old)</option>
                    </select>{" "}
                </label>
            )}
            {process.env.NODE_ENV === "development" &&
                SAMPLES.map((s) => (
                    <button key={s.name} type="button" disabled={busy} onClick={() => loadSample(s)}>
                        dev: {s.name} sample
                    </button>
                ))}
            {process.env.NODE_ENV === "development" && plan && (
                <>
                    <button type="button" disabled={busy} onClick={reschedule}>
                        dev: reschedule
                    </button>
                    <button type="button" disabled={busy} onClick={saveSample}>
                        dev: save as sample
                    </button>
                </>
            )}

            {log.length > 0 && (
                // stays scrolled to the newest line so messages like the save confirmation are seen
                <pre ref={(el) => el?.scrollTo(0, el.scrollHeight)} style={{ maxHeight: 160, overflow: "auto" }}>
                    {log.join("\n")}
                </pre>
            )}

            {plan && (
                <>
                    <p>{plan.draft.summary}</p>
                    <TripMap evaluation={plan.evaluation} registry={plan.registry} hotelId={plan.draft.hotel_place_id} day={day} onDay={(d) => (setDay(d), setFocus(null))} focus={focus} onFocus={setFocus} />
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (instruction.trim()) run({ intake, planner, prior: { ...plan, instruction } });
                        }}
                    >
                        <input
                            size={60}
                            placeholder="ask for a change, e.g. swap day 2 and 3, add a park on day 1"
                            value={instruction}
                            onChange={(e) => setInstruction(e.target.value)}
                        />{" "}
                        <button type="submit" disabled={busy}>
                            replan
                        </button>
                    </form>
                    <Itinerary
                        reasons={Object.fromEntries(plan.draft.days.map((d) => [d.date, d.reason ?? ""]))}
                        evaluation={plan.evaluation}
                        registry={plan.registry}
                        currency={intake.currency}
                        busy={busy}
                        onRemove={removeStop}
                        focus={focus}
                        onFocus={(f) => {
                            // a step picked in the list shows on the map; switch to its day when one other day is shown
                            if (f && day !== null && day !== f.day) setDay(f.day);
                            setFocus(f);
                        }}
                    />
                </>
            )}
        </main>
    );
}
