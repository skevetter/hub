const TIMER_NAMES = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
] as const;

export function assertRealTimersRestored(): void {
  for (const name of TIMER_NAMES) {
    if (Object.hasOwn(globalThis[name], "clock"))
      throw new Error(`Leaked fake timer at worker file boundary: ${name}`);
  }
}

assertRealTimersRestored();
