"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import Itinerary from "@/components/Itinerary";
import TripForm from "@/components/TripForm";
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

export default function Home() {
    const [intake, setIntake] = useState<Intake>(DEFAULT_INTAKE);
    const [plan, setPlan] = useState<Plan | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [instruction, setInstruction] = useState("");
    // the new flow where a scheduler arranges the agent's picks, or the older one where the agent writes every day
    const [planner, setPlanner] = useState<"scheduler" | "agent">("scheduler");

    // reads the agent's newline-delimited json event stream
    async function streamPlan(body: object) {
        setBusy(true);
        setLog([]);
        const res = await fetch("/api/plan", { method: "POST", body: JSON.stringify(body) });
        const reader = res.body!.getReader();
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
                if (e.type === "log") setLog((l) => [...l, e.msg]);
                else if (e.type === "error") setLog((l) => [...l, "error: " + e.msg]);
                else setPlan({ draft: e.draft, evaluation: e.evaluation, registry: e.registry });
            }
        }
    }

    function run(body: object) {
        streamPlan(body)
            .catch((e: Error) => setLog((l) => [...l, "error: " + e.message]))
            .finally(() => setBusy(false));
    }

    function removeStop(date: string, placeId: string) {
        if (!plan) return;
        const draft: Draft = {
            ...plan.draft,
            days: plan.draft.days.map((d) => (d.date === date ? { ...d, stops: d.stops.filter((s) => s.place_id !== placeId) } : d)),
        };
        setBusy(true);
        fetch("/api/check", { method: "POST", body: JSON.stringify({ intake, draft, registry: plan.registry }) })
            .then((r) => r.json())
            .then((data: { evaluation: Evaluation }) => setPlan({ ...plan, draft, evaluation: data.evaluation }))
            .catch((e: Error) => setLog((l) => [...l, "error: " + e.message]))
            .finally(() => setBusy(false));
    }

    // dev only: routes and checks a fixed plan without calling claude
    function loadSample({ name, intake, draft, registry }: Sample) {
        setBusy(true);
        setLog([`dev: checking ${name} sample plan, no claude call`]);
        setIntake(intake);
        fetch("/api/check", { method: "POST", body: JSON.stringify({ intake, draft, registry }) })
            .then((r) => r.json())
            .then((data: { evaluation: Evaluation }) => setPlan({ draft, evaluation: data.evaluation, registry }))
            .catch((e: Error) => setLog((l) => [...l, "error: " + e.message]))
            .finally(() => setBusy(false));
    }

    // dev only: rearranges the plan on screen with the scheduler and real transit, no claude call
    function reschedule() {
        if (!plan) return;
        setBusy(true);
        setLog((l) => [...l, "dev: rescheduling the plan on screen, no claude call"]);
        fetch("/api/dev/reschedule", { method: "POST", body: JSON.stringify({ intake, draft: plan.draft, registry: plan.registry }) })
            .then((r) => r.json())
            .then((d: { draft: Draft; evaluation: Evaluation; report: string; adjustments: string[] }) => {
                setPlan({ ...plan, draft: d.draft, evaluation: d.evaluation });
                setLog((l) => [...l, d.report, ...d.adjustments]);
            })
            .catch((e: Error) => setLog((l) => [...l, "error: " + e.message]))
            .finally(() => setBusy(false));
    }

    // dev only: keeps the plan on screen as a sample file, named after the destination
    function saveSample() {
        if (!plan) return;
        const name = intake.destination.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        fetch("/api/dev/save-sample", { method: "POST", body: JSON.stringify({ name, intake, draft: plan.draft, registry: plan.registry }) })
            .then((r) => r.json())
            .then((d: { saved?: string; error?: string }) => setLog((l) => [...l, d.saved ? `dev: saved ${d.saved}` : `error: ${d.error}`]))
            .catch((e: Error) => setLog((l) => [...l, "error: " + e.message]));
    }

    return (
        <main>
            <h1>trip planner</h1>
            <TripForm intake={intake} busy={busy} onChange={setIntake} onSubmit={() => run({ intake, planner })} />
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
                    <TripMap evaluation={plan.evaluation} registry={plan.registry} hotelId={plan.draft.hotel_place_id} />
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
                    <Itinerary reasons={Object.fromEntries(plan.draft.days.map((d) => [d.date, d.reason ?? ""]))} evaluation={plan.evaluation} registry={plan.registry} currency={intake.currency} busy={busy} onRemove={removeStop} />
                </>
            )}
        </main>
    );
}
