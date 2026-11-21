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
    // neighbourhood and city from the address, e.g. "Fenway-Kenmore, Boston", so the agent can group by name
    area?: string;
    // south, north, west, east; long streets, squares and parks are far bigger than one point
    bbox?: [number, number, number, number];
    // free hints for restaurants: cuisine, a listed website, a wikipedia or wikidata link (notable places)
    cuisine?: string;
    website?: boolean;
    notable?: boolean;
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

export type Meal = "lunch" | "dinner";

export interface DraftStop {
    place_id: string;
    start_after?: string;
    duration_min: number;
    cost_per_person: number;
    meal?: Meal;
    // english name or romanization from the agent when the map data only has the local script
    name_en?: string;
    note?: string;
}

export interface DraftDay {
    date: string;
    stops: DraftStop[];
    // one line from the scheduler on why the day looks like it does
    reason?: string;
}

export interface Draft {
    hotel_place_id: string;
    local_costs: LocalCosts;
    days: DraftDay[];
    summary: string;
}

export type TimeOfDay = "morning" | "afternoon" | "evening";

// what the agent chooses: places worth doing plus intent, the scheduler decides days, order and times
export interface ShortlistItem {
    place_id: string;
    priority: "must" | "nice";
    duration_min: number;
    cost_per_person: number;
    // a restaurant offered for this meal, the scheduler picks which options to use
    meal?: Meal;
    name_en?: string;
    note?: string;
    // pins, only for real intent: a date, a part of the day, or a fixed earliest start
    day?: string;
    time?: TimeOfDay;
    start_after?: string;
}

export interface Shortlist {
    hotel_place_id: string;
    local_costs: LocalCosts;
    items: ShortlistItem[];
    // place ids the traveler wants on one day, or on different days
    together?: string[][];
    apart?: string[][];
    summary: string;
}

export type LegMode = "walk" | "transit" | "drive" | "taxi";
export type DataSource = "timetable" | "routed" | "estimate";

// one ride or walk inside a transit leg, as transitous returns it
export interface Segment {
    mode: string;
    line?: string;
    short?: string;
    color?: string;
    textColor?: string;
    agency?: string;
    headsign?: string;
    from: string;
    to: string;
    fromPos: [number, number];
    toPos: [number, number];
    departMin: number;
    arriveMin: number;
    stops: number;
    geometry: [number, number][];
}

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
    segments?: Segment[];
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
    meal?: Meal;
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
