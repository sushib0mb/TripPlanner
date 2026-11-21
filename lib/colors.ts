// one color per day so routes can be told apart. based on the okabe-ito palette, which stays distinguishable
// for the common kinds of color blindness, ordered so neighbouring days contrast most and darkened where
// needed to read on a light map
export const DAY_COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#B8860B", "#56B4E9", "#7A3E9D"];

export const dayColor = (day: number) => DAY_COLORS[((day % DAY_COLORS.length) + DAY_COLORS.length) % DAY_COLORS.length];

// black or white text, whichever contrasts more with the background
// transit feeds' own text colors are unreliable, e.g. white on yellow
export function readableText(hex: string) {
    const lin = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    // above this point black text has the higher contrast ratio
    return luminance > 0.179 ? "#111111" : "#ffffff";
}

// negative mixes toward black, positive toward white
export function shade(hex: string, amount: number) {
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return "#" + channels.map((c) => Math.round(c + (target - c) * p).toString(16).padStart(2, "0")).join("");
}
