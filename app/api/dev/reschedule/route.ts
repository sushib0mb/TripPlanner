import { verify } from "@/lib/planner";
import { schedule, shortlistFromDraft } from "@/lib/scheduler";
import type { Draft, Intake, Registry } from "@/lib/types";

// dev only: rearranges the plan on screen with the scheduler and checks it with real transit, no claude call
export async function POST(req: Request) {
    if (process.env.NODE_ENV !== "development") return new Response("not found", { status: 404 });
    const { intake, draft, registry } = (await req.json()) as { intake: Intake; draft: Draft; registry: Registry };
    const list = shortlistFromDraft(draft, registry);
    const scheduled = await schedule(intake, list, registry);
    const final = await verify(intake, list, scheduled.draft, registry, () => {});
    return Response.json({ draft: final.draft, evaluation: final.evaluation, report: scheduled.report, adjustments: final.adjustments });
}
