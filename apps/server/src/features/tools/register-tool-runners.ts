// GN-05 / ED-06 / ED-07 — wire the concrete tool runners to their tool ids.
//
// The executor knows no tool (`tool-runners.ts`), so the process that runs
// `tool_execution` jobs registers the runners once at start-up. `worker.ts` calls
// this immediately after `registerAllProviders(env)`: the quick-edit runner needs
// the gateway provider to be registered, and the background remover needs the
// Replicate token out of `env`.
import type { ServerEnv } from "../../config/env.js";
import { createQuickEditRunner } from "./runners/quick-edit.js";
import { createRemoveBackgroundRunner } from "./runners/remove-background.js";
import { registerToolRunner } from "./tool-runners.js";

export function registerToolRunners(env: ServerEnv): void {
  registerToolRunner("quick_edit", createQuickEditRunner());
  registerToolRunner(
    "remove_background",
    createRemoveBackgroundRunner({ apiToken: env.replicateApiToken ?? "" }),
  );
}
