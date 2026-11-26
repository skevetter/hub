import type { ProgressCredentialCooldown } from "../run-timeline/store.js";
import type { CredentialLocator, ProgressCall } from "./types.js";

export const MAX_RETRY_AFTER = 900_000;
export const CREDENTIAL_CIRCUIT_MS = 600_000;
const MAX_IN_FLIGHT = 4;
const WRITE_SPACING_MS = 1_000;

export function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const value = /^\d+$/u.test(retryAfter)
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - now;
    if (!Number.isNaN(value)) return clampRetryAfter(value);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/u.test(reset)) {
      return clampRetryAfter(Number(reset) * 1000 - now);
    }
  }
  return undefined;
}

function clampRetryAfter(ms: number): number {
  return Number.isNaN(ms) ? 0 : Math.min(MAX_RETRY_AFTER, Math.max(0, ms));
}

type Admission = { release: () => void } | { waitUntil: number } | { rejected: true };

interface CredentialState {
  busy: boolean;
  writeAfter: number;
  retryAfter: number;
  rejectedUntil: number;
  sequentialFailures: number;
}

function missingState(property: keyof CredentialState, action: "reading" | "setting"): TypeError {
  const operation = action === "reading" ? "read" : "set";
  return new TypeError(`Cannot ${operation} properties of undefined (${action} '${property}')`);
}

function readState(
  state: CredentialState | undefined,
  property: keyof CredentialState,
): CredentialState {
  if (state === undefined) throw missingState(property, "reading");
  return state;
}

function writeState(
  state: CredentialState | undefined,
  property: "writeAfter" | "retryAfter" | "sequentialFailures",
  value: number,
): void {
  if (state === undefined) throw missingState(property, "setting");
  state[property] = value;
}

function retryAt(state: CredentialState, shared?: ProgressCredentialCooldown): number {
  return Math.max(state.writeAfter, state.retryAfter, shared?.retryAt?.getTime() ?? 0);
}

export class CredentialBackoff {
  private readonly states = new Map<string, CredentialState>();
  private inFlight = 0;

  constructor(private readonly random = Math.random) {}

  admit(locator: CredentialLocator, now: number, shared?: ProgressCredentialCooldown): Admission {
    const key = JSON.stringify(locator);
    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        busy: false,
        writeAfter: 0,
        retryAfter: 0,
        rejectedUntil: 0,
        sequentialFailures: 0,
      };
      this.states.set(key, state);
    }
    if (Math.max(state.rejectedUntil, shared?.rejectedUntil?.getTime() ?? 0) > now)
      return { rejected: true };
    const waitUntil = retryAt(state, shared);
    if (waitUntil > now) return { waitUntil };
    if (state.busy || this.inFlight >= MAX_IN_FLIGHT) return { waitUntil: now + 250 };

    state.busy = true;
    this.inFlight += 1;
    return {
      release: () => {
        state.busy = false;
        this.inFlight -= 1;
      },
    };
  }

  sent(locator: CredentialLocator, now: number): void {
    writeState(this.states.get(JSON.stringify(locator)), "writeAfter", now + WRITE_SPACING_MS);
  }

  result(
    locator: CredentialLocator,
    now: number,
    result: ProgressCall | "transient",
    reportRejected: () => void,
  ): number {
    const state = this.states.get(JSON.stringify(locator));
    if (result === "transient" || (result.status === "retry" && result.transient)) {
      const current = readState(state, "sequentialFailures");
      const base = Math.min(600_000, 30_000 * 2 ** current.sequentialFailures);
      const jitter = 0.8 + 0.4 * this.random();
      current.sequentialFailures += 1;
      current.retryAfter = now + Math.min(600_000, Math.round(base * jitter));
    } else if (result.status === "retry") {
      writeState(state, "retryAfter", now + clampRetryAfter(result.afterMs));
    } else if (result.status === "unavailable" && result.code === "credential_rejected") {
      const current = readState(state, "rejectedUntil");
      if (current.rejectedUntil <= now) reportRejected();
      current.rejectedUntil = now + CREDENTIAL_CIRCUIT_MS;
    } else if (result.status === "ok") {
      writeState(state, "sequentialFailures", 0);
    }
    return readState(state, "retryAfter").retryAfter;
  }
}
