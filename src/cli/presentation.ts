import path from "node:path";

export type OutputMode = "json" | "human" | "verbose" | "quiet";

export interface OutputSelectionInput {
  argv: string[];
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface FormattedOutput {
  stream: "stdout" | "stderr";
  text: string;
}

function has(input: OutputSelectionInput, flag: string): boolean {
  return input.argv.includes(flag);
}

export function selectOutputMode(input: OutputSelectionInput): OutputMode {
  const explicit = [has(input, "--json") ? "json" : undefined, has(input, "--verbose") ? "verbose" : undefined, has(input, "--quiet") ? "quiet" : undefined].filter(Boolean);
  if (explicit.length > 1) throw Object.assign(new Error("Choose only one output mode: --json, --verbose, or --quiet."), { code: "CLI_OUTPUT_MODE_CONFLICT" });
  if (explicit[0]) return explicit[0] as OutputMode;
  return input.stdinIsTTY === true && input.stdoutIsTTY === true ? "human" : "json";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function label(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function entries(value: unknown): Array<[string, Record<string, unknown>]> {
  return Object.entries(object(value)).map(([key, item]) => [key, object(item)]);
}

function setupSummary(value: unknown): string[] {
  const result = object(value); const install = object(result.installation); const health = object(result.health);
  const ready = result.status === "ready";
  const lines = [ready ? "✓ Orbitkeep setup complete" : "! Orbitkeep setup needs attention", "", `Installation: ${ready ? "ready" : label(health.activation, "attention required")}`];
  const projectRoot = label(install.projectRoot, ""); const stateRoot = label(health.stateRoot, "");
  if (stateRoot) lines.push(`State directory: ${projectRoot ? path.relative(projectRoot, stateRoot) || "." : stateRoot}`);
  const providers = entries(health.providerActivation);
  if (providers.length) {
    lines.push("", "Providers");
    const runtimes = object(health.providerRuntime);
    for (const [name, state] of providers) {
      const runtime = object(runtimes[name]);
      const suffix = state.status === "active" && runtime.available === false ? " (CLI not found)" : "";
      lines.push(`${state.status === "active" && runtime.available !== false ? "✓" : state.status === "off" ? "-" : "!"} ${name}: ${label(state.status)}${suffix}`);
    }
  }
  const created = Array.isArray(install.created) ? install.created.length : 0; const preserved = Array.isArray(install.preserved) ? install.preserved.length : 0;
  lines.push("", `Files: ${created} created, ${preserved} preserved`);
  if (install.legacyDetected === true) lines.push("! Legacy workflow records were detected and preserved.");
  const errors = Array.isArray(health.errors) ? health.errors : []; const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  for (const message of errors.slice(0, 5)) lines.push(`✗ ${String(message)}`);
  for (const message of warnings.slice(0, 5)) lines.push(`! ${String(message)}`);
  lines.push("", ready ? "Next: start a Mission with `npx orbitkeep mission start`." : "Next: run `npx orbitkeep repair --plan` after reviewing the findings.");
  return lines;
}

function doctorSummary(value: unknown): string[] {
  const report = object(value); const healthy = report.healthy === true && report.activation !== "blocked" && report.activation !== "repair_required";
  const lines = [healthy ? "✓ Orbitkeep health check passed" : "! Orbitkeep needs attention", "", `Activation: ${label(report.activation)}`];
  const supervisor = object(report.supervisor);
  if (Object.keys(supervisor).length > 0) lines.push(`Supervisor: ${supervisor.running === true ? "running" : "stopped"} — ${String(supervisor.activeJobs ?? 0)} active Mission${supervisor.activeJobs === 1 ? "" : "s"}`);
  const providers = entries(report.providerActivation);
  if (providers.length) {
    lines.push("", "Providers");
    const runtimes = object(report.providerRuntime);
    for (const [name, state] of providers) {
      const runtime = object(runtimes[name]);
      const suffix = state.status === "active" && runtime.available === false ? " (CLI not found)" : "";
      lines.push(`${state.status === "active" && runtime.available !== false ? "✓" : state.status === "off" ? "-" : "!"} ${name}: ${label(state.status)}${suffix} — ${label(state.reason, "No reason reported")}`);
    }
  }
  const errors = Array.isArray(report.errors) ? report.errors : []; const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (errors.length) { lines.push("", "Errors"); for (const message of errors) lines.push(`✗ ${String(message)}`); }
  if (warnings.length) { lines.push("", "Warnings"); for (const message of warnings) lines.push(`! ${String(message)}`); }
  if (!healthy) lines.push("", "Next: run `npx orbitkeep repair --plan`.");
  return lines;
}

function installSummary(value: unknown): string[] {
  const result = object(value); const created = Array.isArray(result.created) ? result.created.length : 0; const preserved = Array.isArray(result.preserved) ? result.preserved.length : 0;
  return ["✓ Orbitkeep installation complete", "", `Files: ${created} created, ${preserved} preserved`, result.legacyDetected === true ? "! Legacy workflow records were detected and preserved." : "Legacy records: none detected", "", "Next: run `npx orbitkeep doctor`."];
}

function repairSummary(value: unknown): string[] {
  const result = object(value); const actions = Array.isArray(result.actions) ? result.actions.map(object) : [];
  const applied = typeof result.backupDirectory === "string";
  const lines = [applied ? "✓ Orbitkeep repair applied" : actions.length === 0 ? "✓ No repair is needed" : result.safe === false ? "! Repair requires manual attention" : "Orbitkeep repair plan", "", `Actions: ${actions.length}`];
  for (const action of actions.slice(0, 10)) lines.push(`- ${label(action.action)}: ${label(action.path)} — ${label(action.reason)}`);
  if (actions.length > 10) lines.push(`- …and ${actions.length - 10} more; use --verbose or --json for full details.`);
  if (!applied && actions.length > 0 && result.safe !== false) lines.push("", "Next: run `npx orbitkeep repair --apply`.");
  return lines;
}

function siloSummary(value: unknown): string[] {
  const result = object(value); const descriptor = object(result.descriptor); const instance = object(result.instance); const identity = object(result.identity);
  if (typeof result.previousSiloId === "string") return [
    "✓ New Silo identity derived", "", `Silo: ${label(descriptor.silo_id)}`, `Instance: ${label(instance.silo_instance_id)}`,
    `Derived from: ${result.previousSiloId}`, `Transaction: ${label(result.transactionId)}`, "", "Commit `.agent-workflow/silo.json` with the derived repository.",
  ];
  return [
    identity.valid === true ? "✓ Silo identity is valid" : "! Silo identity needs attention", "",
    `Silo: ${label(identity.siloId)}`, `Instance: ${label(identity.siloInstanceId)}`,
    `Administrative: ${label(result.administrativeState)}`, `Connectivity: ${label(result.connectivityState)}`,
    `Health: ${label(result.healthState)}`, `Display: ${label(result.displayState)}`,
  ];
}

function missionSummary(value: unknown): string[] {
  const result = object(value); const mission = object(result.mission); const job = object(result.job);
  if (result.code === "ASSIGNMENT_CLOSED" && Array.isArray(result.acceptedResults)) return [
    "✓ Mission Report accepted", "", `Mission: ${label(mission.objective, label(mission.missionId))}`, `Accepted reports: ${result.acceptedResults.length}`, "Mission lifecycle: closed",
  ];
  if (result.code === "MISSION_RUNNING_IN_BACKGROUND") return [
    "✓ Mission launched", "", `Objective: ${label(mission.objective)}`, `Provider: ${label(object(result.provider).name)}`,
    `Background job: ${label(job.state, "queued")}`, "", "You may close this terminal. The Mission will continue under the local Orbitkeep supervisor.",
    "Monitor: use `npx orbitkeep mission status` or `npx orbitkeep mission logs`.",
    `Stop this Mission: \`npx orbitkeep mission stop --provider ${label(object(result.provider).name, "claude|codex")}\`.`,
    "Supervisor control: use `npx orbitkeep supervisor status` or `npx orbitkeep supervisor stop`.",
  ];
  if (result.code === "MISSION_LOGS_AVAILABLE") {
    const events = Array.isArray(result.events) ? result.events : []; const activity = Array.isArray(result.activity) ? result.activity.map(object) : []; const work = Array.isArray(result.currentWork) ? result.currentWork.map(object) : [];
    const recent = activity.map((item) => `- ${label(item.label)}${typeof item.detail === "string" ? `: ${item.detail}` : ""}${typeof item.at === "string" ? ` (${item.at})` : ""}`);
    const current = work.map((item) => `- ${label(item.kind)} ${label(item.name)}${typeof item.detail === "string" ? ` — ${item.detail}` : ""}`);
    return ["✓ Mission activity loaded", "", `Objective: ${label(mission.objective)}`, `Job: ${label(job.state)}`, `Events retained in this view: ${events.length}`, ...(job.error ? [`Error: ${label(object(job.error).message)}`] : []), ...(current.length ? ["", "Currently running", ...current] : []), ...(recent.length ? ["", "Recent meaningful activity", ...recent] : []), ...(typeof result.result === "string" ? ["", "Mission result", result.result] : []), "", "Use --json for the normalized event stream or --limit N to change the view (maximum 1000)."];
  }
  const jobs = Array.isArray(result.jobs) ? result.jobs.map(object) : [];
  if (jobs.length > 0) {
    const latest = jobs[0]!;
    return ["✓ Mission status", "", `Objective: ${label(mission.objective, Array.isArray(result.missions) && result.missions.length === 1 ? label(object(result.missions[0]).objective) : "See --json for Mission details")}`, `Provider: ${label(result.provider, label(latest.provider))}`, `Latest job: ${label(latest.state)}`, `Events observed: ${String(latest.event_count ?? 0)}`, `Last activity: ${label(latest.last_activity_at, label(latest.updated_at))}`, ...(latest.pid !== undefined ? [`Provider process: PID ${String(latest.pid)}`] : []), ...(latest.error ? [`Error: ${label(object(latest.error).message)}`] : []), "", typeof result.nextStep === "string" ? result.nextStep : ["completed", "failed", "interrupted"].includes(String(latest.state)) ? "Use `npx orbitkeep mission logs` to review the final activity and result." : "The Mission is still running. Use `npx orbitkeep mission logs` to inspect current activity."];
  }
  return genericSummary("mission", value);
}

function supervisorSummary(value: unknown): string[] {
  const result = object(value); const supervisor = object(result.supervisor);
  if (Object.keys(supervisor).length > 0) {
    const active = Array.isArray(supervisor.activeMissions) ? supervisor.activeMissions.map(object) : [];
    const lines = [supervisor.running === true ? "✓ Orbitkeep supervisor is running" : "- Orbitkeep supervisor is stopped", "", ...(supervisor.pid !== undefined ? [`Supervisor process: PID ${String(supervisor.pid)}`] : []), `Active Missions: ${String(supervisor.activeJobs ?? 0)}`];
    if (active.length) {
      lines.push("", "Running work");
      for (const mission of active) {
        const process = object(mission.process); const work = Array.isArray(mission.currentWork) ? mission.currentWork.map(object) : []; const activity = Array.isArray(mission.activity) ? mission.activity.map(object) : [];
        lines.push(`- ${label(mission.objective, label(mission.missionId))}`, `  Provider: ${label(mission.provider)} | Flight Director: ${label(process.kind, "manager")} | PID: ${String(process.pid ?? "starting")} | State: ${label(process.state)}`, `  Events: ${String(mission.eventCount ?? 0)} | Last activity: ${label(mission.lastActivityAt)}`);
        for (const item of work) lines.push(`  Active ${label(item.kind)}: ${label(item.name)}${typeof item.detail === "string" ? ` — ${item.detail}` : ""}`);
        const latest = activity[0]; if (latest) lines.push(`  Latest: ${label(latest.label)}${typeof latest.detail === "string" ? ` — ${latest.detail}` : ""}`);
      }
    }
    lines.push("", supervisor.running === true ? "Stop safely with `npx orbitkeep supervisor stop`." : "It will start automatically when an approved Mission begins.");
    return lines;
  }
  if (result.status === "blocked") return ["! Orbitkeep supervisor remains running", "", `${label(result.code)}`, `Active Missions: ${Array.isArray(result.activeJobs) ? result.activeJobs.length : 0}`, "", "Stop individual Missions first, or use `npx orbitkeep supervisor stop --force`."];
  return [`✓ Orbitkeep supervisor: ${label(result.status, "stopped")}`, "", `${label(result.code, "SUPERVISOR_STOPPED")}`];
}

function providerSummary(value: unknown): string[] {
  const result = object(value); const activation = object(result.activation); const runtime = object(result.runtime); const authentication = object(result.authentication); const permissions = object(result.permissionControl);
  if (typeof result.provider !== "string") return genericSummary("provider", value);
  return [
    result.status === "ready" ? `✓ ${result.provider} is ready for Orbitkeep` : `! ${result.provider} needs attention`, "",
    `Integration: ${label(activation.status)}`,
    `CLI available: ${runtime.available === true ? "yes" : "no"}`,
    `Authentication: ${label(authentication.state)}`,
    `Permission control: ${label(permissions.state)}`,
    `Headless JSON stream: ${object(result.headlessExecution).supported === true ? "supported" : "unsupported"}`,
    "", label(authentication.reason),
    "Use --json for provider capabilities and complete diagnostic details.",
  ];
}

function genericSummary(command: string, value: unknown): string[] {
  const result = object(value);
  if (command === "version" && typeof result.version === "string") return [result.version];
  if (Array.isArray(result.commands)) return ["Orbitkeep commands", "", ...result.commands.map((item) => `  ${String(item)}`), "", "Use `npx orbitkeep <command> --help` or `npx orbitkeep <command> --json` for machine-readable output."];
  const status = label(result.status, label(result.code, "complete"));
  const lines = [`✓ Orbitkeep ${command || "command"}: ${status}`];
  for (const [key, display] of [["assignmentId", "Mission"], ["taskId", "Operation"], ["executionId", "Run"], ["transactionId", "Transaction"]] as const) if (typeof result[key] === "string") lines.push(`${display}: ${result[key]}`);
  if (typeof result.nextStep === "string") lines.push("", `Next: ${result.nextStep}`);
  lines.push("", "Use --verbose for details or --json for the complete machine-readable result.");
  return lines;
}

function errorSummary(command: string, value: unknown): string[] {
  const result = object(value); const code = label(result.code, "CLI_ERROR"); const message = label(result.message, "The command failed.");
  const lines = [`✗ Orbitkeep ${command || "command"} failed`, "", `${code}: ${message}`];
  if (code === "WSL_WINDOWS_NODE_MISMATCH") lines.push("", "In WSL, make sure `node`, `npm`, and `npx` resolve to Linux paths, then retry.");
  else if (message.includes("repair")) lines.push("", "Review the finding and run `npx orbitkeep repair --plan` when applicable.");
  lines.push("", "Use --json for structured error details.");
  return lines;
}

export function formatCliOutput(input: { command: string; value: unknown; mode: OutputMode; failed?: boolean }): FormattedOutput | undefined {
  if (input.mode === "quiet" && !input.failed) return undefined;
  if (input.mode === "json") return { stream: "stdout", text: `${JSON.stringify(input.value, null, 2)}\n` };
  const summary = input.failed ? errorSummary(input.command, input.value) : input.command === "setup" ? setupSummary(input.value) : input.command === "doctor" ? doctorSummary(input.value) : input.command === "init" || input.command === "install" ? installSummary(input.value) : input.command === "repair" ? repairSummary(input.value) : input.command === "silo" ? siloSummary(input.value) : input.command === "mission" ? missionSummary(input.value) : input.command === "supervisor" ? supervisorSummary(input.value) : input.command === "provider" ? providerSummary(input.value) : genericSummary(input.command, input.value);
  if (input.mode === "verbose" && !input.failed) summary.push("", "Details", JSON.stringify(input.value, null, 2));
  return { stream: input.failed ? "stderr" : "stdout", text: `${summary.join("\n")}\n` };
}
