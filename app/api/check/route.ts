import { evaluatePlan } from "@/lib/checker";
import type { Draft, Intake, Registry } from "@/lib/types";

// re-routes and re-checks an edited plan without calling the model
export async function POST(req: Request) {
    const { intake, draft, registry } = (await req.json()) as { intake: Intake; draft: Draft; registry: Registry };
    const evaluation = await evaluatePlan(intake, draft, registry);
    return Response.json({ evaluation });
}
