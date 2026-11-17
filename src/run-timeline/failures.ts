import { decodeEntitlementDenialFailureReason } from "../entitlements/denial.js";

const PHRASES = {
  idle_timeout: "the agent was idle too long",
  run_timeout: "the run reached its time limit",
  agent_interrupted: "the agent stopped before it finished",
  agent_failed: "the agent run failed",
  host_unavailable: "the host could not be reached",
  launch_failed: "the agent could not be started",
  credentials_unavailable: "access for the run was not available",
  configuration_error: "the trigger configuration could not be applied",
  limit_reached: "the organization's run limit was reached",
  script_timeout: "the script reached its time limit",
  script_interrupted: "the script was interrupted by a restart",
  script_unavailable: "this Hub cannot run scripts",
  failed: "the run failed",
} as const;

type FixedFailureCode = keyof typeof PHRASES;
export type TimelineFailurePhrase =
  | { code: FixedFailureCode; phrase: (typeof PHRASES)[FixedFailureCode] }
  | { code: "script_failed"; phrase: `the script exited with code ${number}` };

const REASONS: Readonly<Record<string, FixedFailureCode>> = {
  step_idle_timeout: "idle_timeout",
  step_hard_timeout: "run_timeout",
  workflow_timed_out: "run_timeout",
  agent_interrupted: "agent_interrupted",
  agent_execution_failed: "agent_failed",
  daemon_disconnected: "host_unavailable",
  daemon_unreachable: "host_unavailable",
  daemon_not_registered: "host_unavailable",
  daemon_timeout: "host_unavailable",
  launch_failed: "launch_failed",
  workflow_environment_unavailable: "launch_failed",
  execution_credentials_unavailable: "credentials_unavailable",
  execution_authority_stopped: "credentials_unavailable",
  tenant_authority_mismatch: "credentials_unavailable",
  workflow_configuration_revision_required: "configuration_error",
  workflow_value_evaluation_failed: "configuration_error",
  workflow_condition_evaluation_failed: "configuration_error",
  "script interrupted: Hub restarted while it was running": "script_interrupted",
  "This Hub cannot run scripts: it has no daemon terminal channel.": "script_unavailable",
};

function fixed(code: FixedFailureCode): TimelineFailurePhrase {
  return { code, phrase: PHRASES[code] };
}

export function failurePhrase(
  reason: unknown,
  status?: "running" | "succeeded" | "failed" | "timed_out",
): TimelineFailurePhrase {
  if (status === "timed_out") return fixed("run_timeout");
  if (typeof reason !== "string") return fixed("failed");
  if (Object.hasOwn(REASONS, reason)) return fixed(REASONS[reason]!);
  const exit = /^script exited ([0-9]+)$/u.exec(reason);
  if (exit !== null && exit[0] === reason) {
    const code = Number(exit[1]);
    if (code <= 255)
      return { code: "script_failed", phrase: `the script exited with code ${code}` };
  }
  if (reason.startsWith("script timed out")) return fixed("script_timeout");
  if (decodeEntitlementDenialFailureReason(reason) !== undefined) return fixed("limit_reached");
  return fixed("failed");
}
