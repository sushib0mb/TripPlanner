import { mkdir, writeFile } from "fs/promises";
import path from "path";

// dev only: writes a finished plan to lib/samples so it can be reloaded later without calling claude
export async function POST(req: Request) {
    if (process.env.NODE_ENV !== "development") return new Response("not found", { status: 404 });
    const body = await req.json();
    const name = String(body.name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");
    if (!name || !body.intake || !body.draft || !body.registry) {
        return Response.json({ error: "need name, intake, draft and registry" }, { status: 400 });
    }
    const dir = path.join(process.cwd(), "lib", "samples");
    await mkdir(dir, { recursive: true });
    const sample = { name, intake: body.intake, draft: body.draft, registry: body.registry };
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify(sample, null, 4) + "\n");
    return Response.json({ saved: `lib/samples/${name}.json` });
}
