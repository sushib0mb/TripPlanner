// planning rules shared by the scheduler, the checker and the agent prompt, all in minutes after midnight.
// anything both the scheduler and the checker reason about lives here, so the two can never disagree

// when each day starts and the window for getting back to the hotel
export const PACE_DAY = {
    relaxed: { start: 600, backFrom: 1200, backBy: 1290 },
    normal: { start: 540, backFrom: 1230, backBy: 1320 },
    packed: { start: 480, backFrom: 1260, backBy: 1380 },
};

// `from` and `to` bound the meal's start time, `length` is how long it takes
export const LUNCH = { from: 11 * 60 + 45, to: 14 * 60, length: 60 };
export const DINNER = { from: 17 * 60 + 30, to: 21 * 60 + 30, length: 90 };
// a lunch may start this much outside its window before the checker warns; the scheduler aims inside it
export const LUNCH_SLACK_MIN = 30;
export const LUNCH_EARLIEST = LUNCH.from - LUNCH_SLACK_MIN;
export const LUNCH_LATEST = LUNCH.to + LUNCH_SLACK_MIN;

// leaving the airport after landing, and getting there before a flight
export const AIRPORT_EXIT_MIN = 45;
export const AIRPORT_BEFORE_DEP_MIN = 120;

// a day gets dinner unless the traveler leaves for the airport before this time or lands after the other
export const DINNER_IF_AIRPORT_BY = 21 * 60;
export const DINNER_IF_HOTEL_BY = 19 * 60;

// arriving this much after a fixed start (a booked tour, a pinned time) counts as missing it
export const MISSED_START_SLACK_MIN = 15;

// door-to-door travel estimates used wherever real routing is not available yet. the scheduler plans with
// these and the checker falls back to them, so both sides make the same guess
const DETOUR = 1.3; // street distance per straight-line km
const WALK_KMH = 4.8;

export const estimate = {
    km: (straightKm: number) => straightKm * DETOUR,
    walkMin: (straightKm: number) => ((straightKm * DETOUR) / WALK_KMH) * 60,
    // cautious transit guess: waiting, transfers and station walks at about 19 km/h door to door
    transitMin: (straightKm: number) => 12 + straightKm * DETOUR * 3.2,
    driveMin: (straightKm: number) => 10 + ((straightKm * DETOUR) / 25) * 60,
};
