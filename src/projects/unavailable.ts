export const ORGANIZATION_UNAVAILABLE = "Organization unavailable.";
export const PROJECT_UNAVAILABLE = "Project unavailable.";

const READ_RETRIES = 2;

/**
 * The server answered, and the answer is that this address names nothing the reader can open.
 * Asking again returns the same answer, so the read stops at once instead of backing off.
 */
export function shouldRetryTenantRead(failureCount: number, message: string | null): boolean {
  if (message === ORGANIZATION_UNAVAILABLE || message === PROJECT_UNAVAILABLE) return false;
  return failureCount < READ_RETRIES;
}
