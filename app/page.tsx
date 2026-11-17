"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import Itinerary from "@/components/Itinerary";
import TripForm from "@/components/TripForm";
import type { Draft, Evaluation, Intake, Registry, StreamEvent } from "@/lib/types";

// leaflet needs the browser
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

    return (
        <main>
            <h1>trip planner</h1>
            <TripForm intake={intake} busy={busy} onChange={setIntake} onSubmit={() => run({ intake })} />

            {log.length > 0 && <pre style={{ maxHeight: 160, overflow: "auto" }}>{log.join("\n")}</pre>}

            {plan && (
                <>
                    <p>{plan.draft.summary}</p>
                    <TripMap evaluation={plan.evaluation} registry={plan.registry} hotelId={plan.draft.hotel_place_id} />
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (instruction.trim()) run({ intake, prior: { ...plan, instruction } });
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
                    <Itinerary evaluation={plan.evaluation} registry={plan.registry} currency={intake.currency} busy={busy} onRemove={removeStop} />
                </>
            )}
        </main>
    );
}
