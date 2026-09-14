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
    for (const [name, state] of providers) lines.push(`${state.status === "active" ? "✓" : state.status === "off" ? "-" : "!"} ${name}: ${label(state.status)}`);
  }
  const created = Array.isArray(install.created) ? install.created.length : 0; const preserved = Array.isArray(install.preserved) ? install.preserved.length : 0;
  lines.push("", `Files: ${created} created, ${preserved} preserved`);
  if (install.legacyDetected === true) lines.push("! Legacy workflow records were detected and preserved.");
  const errors = Array.isArray(health.errors) ? health.errors : []; const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  for (const message of errors.slice(0, 5)) lines.push(`✗ ${String(message)}`);
  for (const message of warnings.slice(0, 5)) lines.push(`! ${String(message)}`);
  lines.push("", ready ? "Next: run `orbitkeep doctor` at any time to verify health." : "Next: run `orbitkeep repair --plan` after reviewing the findings.");
  return lines;
}

function doctorSummary(value: unknown): string[] {
  const report = object(value); const healthy = report.healthy === true && report.activation !== "blocked" && report.activation !== "repair_required";
  const lines = [healthy ? "✓ Orbitkeep health check passed" : "! Orbitkeep needs attention", "", `Activation: ${label(report.activation)}`];
  const providers = entries(report.providerActivation);
  if (providers.length) {
    lines.push("", "Providers");
    for (const [name, state] of providers) lines.push(`${state.status === "active" ? "✓" : state.status === "off" ? "-" : "!"} ${name}: ${label(state.status)} — ${label(state.reason, "No reason reported")}`);
  }
  const errors = Array.isArray(report.errors) ? report.errors : []; const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (errors.length) { lines.push("", "Errors"); for (const message of errors) lines.push(`✗ ${String(message)}`); }
  if (warnings.length) { lines.push("", "Warnings"); for (const message of warnings) lines.push(`! ${String(message)}`); }
  if (!healthy) lines.push("", "Next: run `orbitkeep repair --plan`.");
  return lines;
}

function installSummary(value: unknown): string[] {
  const result = object(value); const created = Array.isArray(result.created) ? result.created.length : 0; const preserved = Array.isArray(result.preserved) ? result.preserved.length : 0;
  return ["✓ Orbitkeep installation complete", "", `Files: ${created} created, ${preserved} preserved`, result.legacyDetected === true ? "! Legacy workflow records were detected and preserved." : "Legacy records: none detected", "", "Next: run `orbitkeep doctor`."];
}

function repairSummary(value: unknown): string[] {
  const result = object(value); const actions = Array.isArray(result.actions) ? result.actions.map(object) : [];
  const applied = typeof result.backupDirectory === "string";
  const lines = [applied ? "✓ Orbitkeep repair applied" : actions.length === 0 ? "✓ No repair is needed" : result.safe === false ? "! Repair requires manual attention" : "Orbitkeep repair plan", "", `Actions: ${actions.length}`];
  for (const action of actions.slice(0, 10)) lines.push(`- ${label(action.action)}: ${label(action.path)} — ${label(action.reason)}`);
  if (actions.length > 10) lines.push(`- …and ${actions.length - 10} more; use --verbose or --json for full details.`);
  if (!applied && actions.length > 0 && result.safe !== false) lines.push("", "Next: run `orbitkeep repair --apply`.");
  return lines;
}

function genericSummary(command: string, value: unknown): string[] {
  const result = object(value);
  if (Array.isArray(result.commands)) return ["Orbitkeep commands", "", ...result.commands.map((item) => `  ${String(item)}`), "", "Use `orbitkeep <command> --help` or `orbitkeep <command> --json` for machine-readable output."];
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
  else if (message.includes("repair")) lines.push("", "Review the finding and run `orbitkeep repair --plan` when applicable.");
  lines.push("", "Use --json for structured error details.");
  return lines;
}

export function formatCliOutput(input: { command: string; value: unknown; mode: OutputMode; failed?: boolean }): FormattedOutput | undefined {
  if (input.mode === "quiet" && !input.failed) return undefined;
  if (input.mode === "json") return { stream: "stdout", text: `${JSON.stringify(input.value, null, 2)}\n` };
  const summary = input.failed ? errorSummary(input.command, input.value) : input.command === "setup" ? setupSummary(input.value) : input.command === "doctor" ? doctorSummary(input.value) : input.command === "init" || input.command === "install" ? installSummary(input.value) : input.command === "repair" ? repairSummary(input.value) : genericSummary(input.command, input.value);
  if (input.mode === "verbose" && !input.failed) summary.push("", "Details", JSON.stringify(input.value, null, 2));
  return { stream: input.failed ? "stderr" : "stdout", text: `${summary.join("\n")}\n` };
}
