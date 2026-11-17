"use client";

import type { Intake } from "@/lib/types";

interface Props {
    intake: Intake;
    busy: boolean;
    onChange: (intake: Intake) => void;
    onSubmit: () => void;
}

export default function TripForm({ intake, busy, onChange, onSubmit }: Props) {
    const text = (key: keyof Intake, label: string, type = "text") => (
        <label>
            {label}{" "}
            <input
                type={type}
                value={intake[key] as string | number}
                onChange={(e) => onChange({ ...intake, [key]: type === "number" ? Number(e.target.value) : e.target.value })}
            />
        </label>
    );

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
            }}
        >
            <fieldset>
                <legend>where and when</legend>
                {text("destination", "destination")} {text("startDate", "start", "date")} {text("nights", "nights", "number")}
            </fieldset>
            <fieldset>
                <legend>flights (optional)</legend>
                {text("arrivalAirport", "arrive at")} {text("arrivalTime", "landing", "time")} {text("departureAirport", "leave from")}{" "}
                {text("departureTime", "takeoff", "time")}
            </fieldset>
            <fieldset>
                <legend>hotel and people</legend>
                {text("hotel", "hotel or area (optional)")} {text("adults", "adults", "number")} {text("kids", "kids", "number")}
            </fieldset>
            <fieldset>
                <legend>budget for activities and local transport</legend>
                {text("budget", "budget", "number")} {text("currency", "currency")}
            </fieldset>
            <fieldset>
                <legend>getting around</legend>
                <label>
                    mode{" "}
                    <select value={intake.getAround} onChange={(e) => onChange({ ...intake, getAround: e.target.value as Intake["getAround"] })}>
                        <option value="mix">transit, taxi when needed</option>
                        <option value="transit">transit only</option>
                        <option value="car">rental car</option>
                    </select>
                </label>{" "}
                {text("maxWalkMin", "max walk (min)", "number")} {intake.getAround === "car" && text("carDailyRate", "car per day", "number")}
            </fieldset>
            <fieldset>
                <legend>style</legend>
                <label>
                    pace{" "}
                    <select value={intake.pace} onChange={(e) => onChange({ ...intake, pace: e.target.value as Intake["pace"] })}>
                        <option value="relaxed">relaxed</option>
                        <option value="normal">normal</option>
                        <option value="packed">packed</option>
                    </select>
                </label>{" "}
                {text("interests", "interests and must-sees")}
            </fieldset>
            <button type="submit" disabled={busy}>
                {busy ? "planning..." : "plan trip"}
            </button>
        </form>
    );
}
