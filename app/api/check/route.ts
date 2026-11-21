import { evaluatePlan } from "@/lib/checker";
import { checkLimiter, clientKey, limitedResponse } from "@/lib/limits";
import type { Draft, Intake, Registry } from "@/lib/types";

// re-routes and re-checks an edited plan without calling the model
export async function POST(req: Request) {
    const slot = checkLimiter.acquire(clientKey(req));
    if (!slot.ok) return limitedResponse(slot.reason, slot.retryAfterS);
    try {
        const { intake, draft, registry } = (await req.json()) as { intake: Intake; draft: Draft; registry: Registry };
        const evaluation = await evaluatePlan(intake, draft, registry, { signal: req.signal });
        return Response.json({ evaluation });
    } catch (e) {
        if (req.signal.aborted) return new Response(null, { status: 499 });
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    } finally {
        slot.release();
    }
}
