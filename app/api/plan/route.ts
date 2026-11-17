import { runAgent } from "@/lib/agent";
import type { Draft, Evaluation, Intake, Registry, StreamEvent } from "@/lib/types";

interface Body {
    intake: Intake;
    prior?: { registry: Registry; draft: Draft; evaluation: Evaluation; instruction: string };
}

// streams newline-delimited json events while the agent works
export async function POST(req: Request) {
    const body = (await req.json()) as Body;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const emit = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
            try {
                await runAgent(body.intake, emit, body.prior);
            } catch (e) {
                emit({ type: "error", msg: e instanceof Error ? e.message : String(e) });
            }
            controller.close();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
