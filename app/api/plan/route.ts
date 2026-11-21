import { runAgent } from "@/lib/agent";
import { runPlanner } from "@/lib/planner";
import type { Draft, Evaluation, Intake, Registry, StreamEvent } from "@/lib/types";

interface Body {
    intake: Intake;
    prior?: { registry: Registry; draft: Draft; evaluation: Evaluation; instruction: string };
    // "scheduler" is the agent picks, scheduler arranges flow; "agent" is the older flow where the agent writes every day
    planner?: "scheduler" | "agent";
}

// streams newline-delimited json events while the agent works
export async function POST(req: Request) {
    const body = (await req.json()) as Body;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const emit = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
            try {
                const run = body.planner === "agent" ? runAgent : runPlanner;
                await run(body.intake, emit, body.prior);
            } catch (e) {
                emit({ type: "error", msg: e instanceof Error ? e.message : String(e) });
            }
            controller.close();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
