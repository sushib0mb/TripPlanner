import { runAgent } from "@/lib/agent";
import { clientKey, limitedResponse, planLimiter } from "@/lib/limits";
import { runPlanner } from "@/lib/planner";
import type { Intake, Prior, StreamEvent } from "@/lib/types";

interface Body {
    intake: Intake;
    prior?: Prior;
    // "scheduler" is the agent picks, scheduler arranges flow; "agent" is the older flow where the agent writes every day
    planner?: "scheduler" | "agent";
}

// streams newline-delimited json events while the agent works
export async function POST(req: Request) {
    const slot = planLimiter.acquire(clientKey(req));
    if (!slot.ok) return limitedResponse(slot.reason, slot.retryAfterS);

    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        slot.release();
        return Response.json({ error: "the request body is not json" }, { status: 400 });
    }

    // stops the run, and the tokens it spends, when the traveler leaves or the connection drops
    const abort = new AbortController();
    const stop = () => abort.abort();
    req.signal.addEventListener("abort", stop, { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const emit = (e: StreamEvent) => {
                if (abort.signal.aborted) return;
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
                } catch {
                    // the reader is gone
                    abort.abort();
                }
            };
            try {
                const run = body.planner === "agent" ? runAgent : runPlanner;
                await run(body.intake, emit, body.prior, abort.signal);
            } catch (e) {
                if (!abort.signal.aborted) emit({ type: "error", msg: e instanceof Error ? e.message : String(e) });
            } finally {
                slot.release();
                req.signal.removeEventListener("abort", stop);
                try {
                    controller.close();
                } catch {
                    // already closed by a cancel
                }
            }
        },
        cancel() {
            abort.abort();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
