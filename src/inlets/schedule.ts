import { Cron } from "croner";
import type { Flow } from "../engine/flow-schema.ts";
import type { Runner } from "../engine/runner.ts";
import type { Store } from "../engine/store.ts";

// `inlet.schedule` in a flow:
//   schedule:
//     cron: "0 9 * * MON"      # five-field cron, server local time
//     data: { period: last week }
export interface ScheduleInlet {
  cron: string;
  data?: Record<string, unknown>;
}

export function scheduleInlet(flow: Flow): ScheduleInlet | undefined {
  return flow.inlet?.schedule as ScheduleInlet | undefined;
}

// Opens a case at each scheduled time. Each slot is marked in the store
// before the case opens, so two processes or a restart never run it twice.
export function startSchedules(flows: Flow[], runner: Runner, store: Store): Cron[] {
  return flows.flatMap((flow) => {
    const inlet = scheduleInlet(flow);
    if (!inlet) return [];
    return [
      new Cron(inlet.cron, { protect: true }, async (job: Cron) => {
        const slot = job.currentRun()?.toISOString() ?? new Date().toISOString();
        if (!store.mark(`schedule:${flow.flow}:${slot}`)) return;
        await runner.open(flow.flow, { ...inlet.data, scheduled_for: slot }, `schedule ${inlet.cron}`);
      }),
    ];
  });
}

export function nextRuns(flows: Flow[]): { flow: string; next: string | null }[] {
  return flows.flatMap((flow) => {
    const inlet = scheduleInlet(flow);
    if (!inlet) return [];
    return [{ flow: flow.flow, next: new Cron(inlet.cron, { paused: true }).nextRun()?.toISOString() ?? null }];
  });
}
