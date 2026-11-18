import boston from "./samples/boston.json";
import type { Draft, Intake, Place, Registry } from "./types";

// fixed trips for the dev buttons, checked and routed like a real plan but never sent to claude
// place ids, coordinates and hours are real nominatim results
// tokyo and paris are written by hand, files in samples/ are real agent runs saved with "dev: save as sample"

export interface Sample {
    name: string;
    intake: Intake;
    draft: Draft;
    registry: Registry;
}

const place = (id: string, name: string, kind: string, lat: number, lon: number, openingHours?: string): Place => ({
    id,
    name,
    kind,
    lat,
    lon,
    openingHours,
    source: "nominatim",
});

const registry = (places: Place[]): Registry => Object.fromEntries(places.map((p) => [p.id, p]));

const TOKYO_INTAKE: Intake = {
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
    interests: "temples, museums, food",
};

const HANEDA = "Tokyo International Airport (HANEDA AIRPORT TERMINAL 3)";

const TOKYO_REGISTRY = registry([
    place("ARR", HANEDA, "aeroway=aerodrome", 35.543888, 139.76865, "24/7"),
    place("DEP", HANEDA, "aeroway=aerodrome", 35.543888, 139.76865, "24/7"),
    place("n2389061846", "Shinjuku", "railway=station", 35.6902156, 139.6996243),
    place("w173154847", "Sensō-ji", "amenity=place_of_worship", 35.7134032, 139.7955265, "Mo-Su 06:00-17:00"),
    place("w33439660", "Tokyo National Museum", "tourism=museum", 35.7190448, 139.7759676, "Mo, We-Th 09:30-17:00; Fr-Su 09:30-20:00"),
    place("w288269147", "Tokyo Skytree", "tourism=attraction", 35.71005, 139.81071, "Mo-Su 08:00-22:00"),
    place("r18158889", "Ueno Park", "boundary=administrative", 35.71529, 139.77383),
    place("w89877471", "Tokyo Metropolitan Government Main Building 1", "office=government", 35.6895, 139.69171, "Mo-Fr 09:30-22:30"),
    place(
        "w469908925",
        "Meiji Jingu Main Shrine",
        "amenity=place_of_worship",
        35.67484,
        139.69963,
        "Jan 06:40-16:20; Feb 06:20-16:50; Mar 05:40-17:20; Apr 05:10-17:50; May 05:00-18:10; Jun 05:00-18:30; Jul 05:00-18:20; Aug 05:00-18:00; Sep 05:20-17:20; Oct 05:40-16:40; Nov 06:10-16:10; Dec 06:40-16:00",
    ),
    place("w617560918", "Shibuya Scramble Square", "building=retail", 35.65838, 139.70222, "06:50-24:00"),
    place("w229400762", "Daikokuya Tempura", "amenity=restaurant", 35.7127374, 139.7955918),
    place("n13255292471", "上野 精養軒", "amenity=restaurant", 35.7143595, 139.7985788),
    place("n7626527973", "Mizuguchi Shokudō", "amenity=restaurant", 35.7135352, 139.7937557),
    place("n13937694801", "OMIGA Korean Cuisine 韓国料理オミガ", "amenity=restaurant", 35.71079, 139.80881, "We-Su 11:00-14:00, 17:00-20:30"),
    place("n13808375301", "Osokaya Gold Okonomiyaki", "amenity=restaurant", 35.69479, 139.70083, "Mo-Su 11:00-23:30"),
    place("n4455902416", "Afuri", "amenity=restaurant", 35.67299, 139.70381, "Mo-Su 10:00-23:00"),
    place("r17691812", "バンコク屋台 カオサン", "amenity=restaurant", 35.69067, 139.70021, "08:00-22:00"),
]);

const TOKYO_DRAFT: Draft = {
    hotel_place_id: "n2389061846",
    local_costs: { transit_fare: 1.5, taxi_base: 3, taxi_per_km: 3, fuel_per_km: 0.15, parking_per_stop: 5 },
    days: [
        {
            date: "2026-12-02",
            stops: [
                { place_id: "w229400762", duration_min: 60, cost_per_person: 20, meal: "lunch", note: "tempura" },
                { place_id: "w173154847", duration_min: 75, cost_per_person: 0 },
                { place_id: "w288269147", duration_min: 120, cost_per_person: 25, note: "observation deck at sunset" },
                {
                    place_id: "n13937694801",
                    start_after: "18:45",
                    duration_min: 90,
                    cost_per_person: 25,
                    meal: "dinner",
                    name_en: "Omiga Korean Cuisine",
                },
            ],
        },
        {
            date: "2026-12-03",
            stops: [
                { place_id: "w33439660", start_after: "09:30", duration_min: 150, cost_per_person: 8 },
                { place_id: "n13255292471", duration_min: 75, cost_per_person: 25, meal: "lunch", name_en: "Ueno Seiyoken" },
                { place_id: "r18158889", duration_min: 75, cost_per_person: 0 },
                { place_id: "w89877471", duration_min: 60, cost_per_person: 0, note: "free observation deck" },
                { place_id: "n13808375301", start_after: "19:00", duration_min: 90, cost_per_person: 20, meal: "dinner" },
            ],
        },
        {
            date: "2026-12-04",
            stops: [
                { place_id: "w469908925", start_after: "10:00", duration_min: 90, cost_per_person: 0 },
                { place_id: "n4455902416", duration_min: 60, cost_per_person: 12, meal: "lunch", note: "yuzu ramen" },
                { place_id: "w617560918", duration_min: 180, cost_per_person: 18, note: "shops and the Shibuya Sky deck" },
                {
                    place_id: "r17691812",
                    start_after: "19:00",
                    duration_min: 105,
                    cost_per_person: 22,
                    meal: "dinner",
                    name_en: "Bangkok Yatai Khaosan",
                    note: "thai street food",
                },
            ],
        },
        {
            date: "2026-12-05",
            stops: [{ place_id: "n7626527973", start_after: "11:30", duration_min: 60, cost_per_person: 12, meal: "lunch" }],
        },
    ],
    summary: "dev sample plan, no claude call: asakusa and skytree, ueno museums, then meiji jingu and shibuya from a shinjuku base",
};

const PARIS_INTAKE: Intake = {
    destination: "Paris",
    startDate: "2026-12-09",
    nights: 3,
    arrivalAirport: "Charles de Gaulle",
    arrivalTime: "08:30",
    departureAirport: "Orly",
    departureTime: "18:30",
    hotel: "Gare de l'Est",
    adults: 2,
    kids: 0,
    budget: 700,
    currency: "EUR",
    getAround: "mix",
    maxWalkMin: 15,
    carDailyRate: 60,
    pace: "normal",
    interests: "museums, landmarks, cafes",
};

const PARIS_REGISTRY = registry([
    place("ARR", "Charles de Gaulle International Airport (Airport Charles de Gaulle)", "aeroway=aerodrome", 49.00398, 2.57078),
    place("DEP", "Paris–Orly Airport (Paris - Orly Airport)", "aeroway=aerodrome", 48.73225, 2.37269),
    place("n2506241285", "Paris Gare de l'Est", "railway=station", 48.8771, 2.35949),
    place("r7515426", "Louvre Museum", "tourism=museum", 48.86115, 2.33803, "Mo,Th,Sa-Su 09:00-18:00; Tu off; We,Fr 09:00-21:00; Jan 01,May 01,Dec 25 off"),
    place("w5013364", "Eiffel Tower", "man_made=tower", 48.85826, 2.2945, "09:30-23:45; Jun 21-Sep 02: 09:00-00:45; Jul 14,Jul 15 off"),
    place("w63178753", "Museum of Orsay", "tourism=museum", 48.85992, 2.32658, "Tu-Su 09:30-18:00; Th 09:30-21:45"),
    place("w201611261", "Cathedral of Notre Dame", "amenity=place_of_worship", 48.85294, 2.35005, "Mo,Tu,We,Fr 07:50-19:00; Th 07:50-22:00; Sa,Su 08:15-19:30"),
    place("r3344870", "Sainte-Chapelle", "amenity=place_of_worship", 48.85539, 2.34499, "Jan-Mar 09:00-17:00; Apr-Sep 09:00-19:00; Oct-Dec 09:00-17:00"),
    place("w23762981", "Basilica of the Sacred Heart of Paris", "amenity=place_of_worship", 48.88681, 2.34302, "06:00-22:30"),
    place(
        "w226413508",
        "Arc de Triomphe",
        "building=triumphal_arch",
        48.87378,
        2.29504,
        "Apr 02-Jan 31: Mo-Su 10:00-22:30; Apr 01,Sep 30: Mo-Su 10:00-23:00; Oct 01,Dec 31: Mo-Su 10:00-22:30; Jan 01,May 01,May 08,Jul 14,Nov 11,Dec 25: off",
    ),
    place("w69224062", "Galeries Lafayette", "shop=department_store", 48.87365, 2.33213, "Mo-Sa 10:00-20:30; Su 11:00-20:00"),
    place("w57745741", "Musée national Picasso-Paris", "tourism=museum", 48.85987, 2.36212, "Tu-Fr 10:30-18:00; Sa,Su 09:30-18:00"),
    place("n14080384533", "Place des Vosges", "place=square", 48.85563, 2.36553),
    place("n2745761616", "Le Bistro du Périgord", "amenity=restaurant", 48.84986, 2.34517, "Mo-Su 07:00-24:00"),
    place("n3980721256", "Come Prima", "amenity=restaurant", 48.8617, 2.34077, "Mo-Fr 12:00-14:30,18:00-22:00; Sa,Su 12:00-22:00"),
    place("n14354598266", "L'étoile marocaine", "amenity=restaurant", 48.8714, 2.29828, "Mo-Fr 11:00-15:00, 18:00-23:00; Sa 18:00-23:00; Su 12:00-15:00, 19:00-23:00"),
    place("n10648878721", "Moom Mam", "amenity=restaurant", 48.8747, 2.33125, "Mo-Su 12:00-14:30,19:00-22:30"),
    place("n4340407982", "Le Coq Rico", "amenity=restaurant", 48.88722, 2.33719, "Mo-Su 12:00-14:30,19:00-22:30"),
    place("n6487937178", "Café Hugo", "amenity=restaurant", 48.85594, 2.36676, "Mo-Th 07:00-01:00; Fr-Sa 07:00-02:00; Su 07:00-01:00"),
    place("n3471885038", "Soon", "amenity=restaurant", 48.85809, 2.36732, "Mo-Su 12:00-14:30,19:00-22:30"),
    place("n3621910193", "L'Escale du Liban", "amenity=restaurant", 48.85609, 2.35907),
]);

const PARIS_DRAFT: Draft = {
    hotel_place_id: "n2506241285",
    local_costs: { transit_fare: 2.5, taxi_base: 4, taxi_per_km: 2, fuel_per_km: 0.15, parking_per_stop: 6 },
    days: [
        {
            date: "2026-12-09",
            stops: [
                { place_id: "n2745761616", start_after: "12:00", duration_min: 75, cost_per_person: 25, meal: "lunch" },
                { place_id: "w201611261", duration_min: 60, cost_per_person: 0 },
                { place_id: "r3344870", duration_min: 45, cost_per_person: 13 },
                { place_id: "r7515426", duration_min: 150, cost_per_person: 22, note: "open late on wednesdays" },
                { place_id: "n3980721256", start_after: "19:00", duration_min: 90, cost_per_person: 30, meal: "dinner", note: "italian" },
            ],
        },
        {
            date: "2026-12-10",
            stops: [
                { place_id: "w63178753", start_after: "09:30", duration_min: 120, cost_per_person: 16 },
                { place_id: "w5013364", duration_min: 90, cost_per_person: 29 },
                { place_id: "n14354598266", duration_min: 60, cost_per_person: 20, meal: "lunch", note: "moroccan" },
                { place_id: "w226413508", duration_min: 60, cost_per_person: 16 },
                { place_id: "w69224062", duration_min: 90, cost_per_person: 0, note: "rooftop view, free" },
                { place_id: "n10648878721", start_after: "19:00", duration_min: 90, cost_per_person: 25, meal: "dinner", note: "thai" },
            ],
        },
        {
            date: "2026-12-11",
            stops: [
                { place_id: "w23762981", start_after: "10:00", duration_min: 90, cost_per_person: 0 },
                { place_id: "n4340407982", start_after: "12:15", duration_min: 90, cost_per_person: 40, meal: "lunch" },
                { place_id: "w57745741", duration_min: 120, cost_per_person: 16 },
                { place_id: "n6487937178", duration_min: 60, cost_per_person: 8, note: "coffee on the place des vosges" },
                { place_id: "n3471885038", start_after: "19:00", duration_min: 90, cost_per_person: 30, meal: "dinner", note: "korean" },
            ],
        },
        {
            date: "2026-12-12",
            stops: [
                { place_id: "n14080384533", start_after: "10:00", duration_min: 45, cost_per_person: 0 },
                { place_id: "n3621910193", start_after: "11:30", duration_min: 60, cost_per_person: 20, meal: "lunch", note: "lebanese" },
            ],
        },
    ],
    summary: "dev sample plan, no claude call: louvre, orsay, the eiffel tower and the marais from a gare de l'est base",
};

export const SAMPLES: Sample[] = [
    { name: "tokyo", intake: TOKYO_INTAKE, draft: TOKYO_DRAFT, registry: TOKYO_REGISTRY },
    { name: "paris", intake: PARIS_INTAKE, draft: PARIS_DRAFT, registry: PARIS_REGISTRY },
    boston as Sample,
];
