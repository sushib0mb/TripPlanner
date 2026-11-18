// one color per day so routes can be told apart
export const DAY_COLORS = ["#d62728", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e", "#8c564b", "#e377c2"];

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
