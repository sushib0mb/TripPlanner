import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { alias: { "@": path.resolve(__dirname) } },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // a timezone with daylight saving, so tests catch code that leans on the server's clock
        env: { TZ: "America/New_York" },
    },
});
