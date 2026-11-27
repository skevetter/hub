import { z } from "zod";

const PgErrorCodeSchema = z
  .object({
    code: z.string().optional(),
  })
  .loose();

export class DatabaseUnavailableError extends Error {
  constructor(message = "database unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseUnavailableError";
  }
}

export class ConnectionAccessDeniedError extends Error {
  constructor() {
    super("connection access denied");
    this.name = "ConnectionAccessDeniedError";
  }
}

export class ConnectionConflictError extends Error {
  constructor() {
    super("connection already exists");
    this.name = "ConnectionConflictError";
  }
}

export class ConnectionAttemptUnavailableError extends Error {
  readonly code = "invalidInput";

  constructor() {
    super("connection attempt is invalid, expired, or already used");
    this.name = "ConnectionAttemptUnavailableError";
  }
}

/** A name the author chose is already taken. `code` lets the failure boundary report it as a conflict. */
export class TriggerNameConflictError extends Error {
  readonly code = "conflict";

  constructor() {
    super("trigger name already exists");
    this.name = "TriggerNameConflictError";
  }
}

/** The trigger an author asked to change is gone, or belongs to another organization. */
export class OrganizationTriggerNotFoundError extends Error {
  readonly code = "notFound";

  constructor() {
    super("organization trigger not found");
    this.name = "OrganizationTriggerNotFoundError";
  }
}

/** A project already holds this slug in the organization. */
export class ProjectSlugConflictError extends Error {
  readonly code = "conflict";

  constructor() {
    super("project slug already exists");
    this.name = "ProjectSlugConflictError";
  }
}

const UniqueViolationSchema = z
  .object({ code: z.string(), constraint: z.string().optional() })
  .loose();

/** Matches by constraint name, never by message text. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const parsed = UniqueViolationSchema.safeParse(error);
  return parsed.success && parsed.data.code === "23505" && parsed.data.constraint === constraint;
}

export function isDatabaseUnavailableError(error: unknown): error is DatabaseUnavailableError {
  return error instanceof DatabaseUnavailableError;
}

export function toDatabaseError(error: unknown): Error {
  if (error instanceof DatabaseUnavailableError) {
    return error;
  }

  if (isUnavailablePgError(error)) {
    return new DatabaseUnavailableError("database unavailable", { cause: error });
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isUnavailablePgError(error: unknown): boolean {
  const parsed = PgErrorCodeSchema.safeParse(error);

  if (!parsed.success) {
    return false;
  }

  const code = parsed.data.code;

  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "57014" ||
    code === "57P01" ||
    (typeof code === "string" && code.startsWith("08"))
  );
}

const MAX_CAUSE_DEPTH = 5;
const TRANSIENT_CODES = new Set(["ECONNRESET", "57P01", "40001", "40P01"]);
const TRANSIENT_MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|connection reset|econnreset/iu;

/**
 * An infrastructure failure that a later attempt can get past: the pool had no free connection
 * in time, the connection was reset or terminated, or PostgreSQL rolled the transaction back for
 * a serialization failure or a deadlock. Anything else, such as a constraint violation or a bug,
 * is not transient and must not be retried.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    // A failure that already used up its attempts stays failed, however its cause reads.
    if (current.name === "RetryExhaustedError") return false;
    if (current instanceof DatabaseUnavailableError) return true;
    const parsed = PgErrorCodeSchema.safeParse(current);
    if (parsed.success && parsed.data.code !== undefined) {
      const code = parsed.data.code;
      if (TRANSIENT_CODES.has(code) || code.startsWith("08")) return true;
    }
    if (TRANSIENT_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
