export type GetAround = "transit" | "car" | "mix";
export type Pace = "relaxed" | "normal" | "packed";

export interface Intake {
    destination: string;
    startDate: string;
    nights: number;
    arrivalAirport: string;
    arrivalTime: string;
    departureAirport: string;
    departureTime: string;
    hotel: string;
    adults: number;
    kids: number;
    budget: number;
    currency: string;
    getAround: GetAround;
    maxWalkMin: number;
    carDailyRate: number;
    pace: Pace;
    interests: string;
}

export interface Place {
    id: string;
    name: string;
    lat: number;
    lon: number;
    kind: string;
    openingHours?: string;
    source: "nominatim" | "overpass";
}

export type Registry = Record<string, Place>;

export interface LocalCosts {
    transit_fare: number;
    taxi_base: number;
    taxi_per_km: number;
    fuel_per_km: number;
    parking_per_stop: number;
}

export interface DraftStop {
    place_id: string;
    start_after?: string;
    duration_min: number;
    cost_per_person: number;
    note?: string;
}

export interface DraftDay {
    date: string;
    stops: DraftStop[];
}

export interface Draft {
    hotel_place_id: string;
    local_costs: LocalCosts;
    days: DraftDay[];
    summary: string;
}

export type LegMode = "walk" | "transit" | "drive" | "taxi";
export type DataSource = "timetable" | "routed" | "estimate";

export interface Leg {
    fromId: string;
    toId: string;
    mode: LegMode;
    departMin: number;
    arriveMin: number;
    minutes: number;
    km: number;
    cost: number;
    costSource: "transitous" | "model estimate" | "user" | "none";
    timeSource: DataSource;
    lines: string[];
    geometry: [number, number][];
    note?: string;
}

export interface TimedStop {
    placeId: string;
    name: string;
    arriveMin: number;
    startMin: number;
    endMin: number;
    cost: number;
    hours: "open" | "closed" | "unknown";
    note?: string;
}

export interface TimedDay {
    date: string;
    stops: TimedStop[];
    legs: Leg[];
}

export interface Issue {
    level: "error" | "warning";
    code: string;
    day?: string;
    message: string;
}

export interface Evaluation {
    days: TimedDay[];
    issues: Issue[];
    totals: { activities: number; transport: number; car: number; total: number; budget: number };
    timezone: string;
    transitCalls: number;
}

export type StreamEvent =
    | { type: "log"; msg: string }
    | { type: "result"; draft: Draft; evaluation: Evaluation; registry: Registry }
    | { type: "error"; msg: string };
