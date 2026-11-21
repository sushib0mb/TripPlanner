// planning rules shared by the scheduler, the checker and the agent prompt, all in minutes after midnight

// when each day starts and the window for getting back to the hotel
export const PACE_DAY = {
    relaxed: { start: 600, backFrom: 1200, backBy: 1290 },
    normal: { start: 540, backFrom: 1230, backBy: 1320 },
    packed: { start: 480, backFrom: 1260, backBy: 1380 },
};

export const LUNCH = { from: 11 * 60 + 45, to: 14 * 60, length: 60 };
export const DINNER = { from: 17 * 60 + 30, to: 21 * 60 + 30, length: 90 };

// leaving the airport after landing, and getting there before a flight
export const AIRPORT_EXIT_MIN = 45;
export const AIRPORT_BEFORE_DEP_MIN = 120;

// a day gets dinner unless the traveler leaves for the airport before this time or lands after the other
export const DINNER_IF_AIRPORT_BY = 21 * 60;
export const DINNER_IF_HOTEL_BY = 19 * 60;
