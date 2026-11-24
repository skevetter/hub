export const TOKEN_REVOKE_BUDGET_MS = 9_000;
// Leave room for scheduling skew so the watchdog outlasts the provider's budget.
export const TOKEN_REVOKE_WATCHDOG_MS = TOKEN_REVOKE_BUDGET_MS + 1_000;
