import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useEffect, useRef, type ReactNode, type Ref } from "react";

import type { Result } from "../../contract/respond.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { PageAlert } from "./page-alert.js";

// One element per glyph, created once: an alert's icon never changes, and a fresh element on
// every render is a new prop identity for no reason.
const WARNING_GLYPH = <TriangleAlert />;
const SUCCESS_GLYPH = <CircleCheck />;
const NEUTRAL_GLYPH = <Info />;

/**
 * Everything a failed request can hand a screen. A query gives back a `Result` that may or may
 * not have failed, or nothing at all when the transport itself failed; a thrown error gives an
 * `Error`; a hand-built message gives a string.
 */
export type Failure = Result<unknown> | Error | string | null | undefined;

/**
 * The message the reader should see, given whatever the request left behind. The server's own
 * words win when there are any. Everything else — a transport failure, a request that never
 * answered, a result that did not fail at all — is the fallback, because the only thing known
 * in those cases is what the screen was trying to do.
 */
export function failureMessage(error: Failure, fallback: string): string {
  if (error === null || error === undefined) return fallback;
  if (typeof error === "string") return error.trim() === "" ? fallback : error;
  if (error instanceof Error) return error.message.trim() === "" ? fallback : error.message;
  if (error.status === "error") {
    return error.error.message.trim() === "" ? fallback : error.error.message;
  }
  return fallback;
}

/**
 * The one way a screen reports that a request failed: what could not be done, why, and — when
 * trying again is a real option — the way to try again. The message derivation lives here, so
 * no screen writes `status === "error" ? … : …` beside its own copy of the transport sentence.
 */
export function FailureAlert({
  title,
  error,
  fallback,
  details,
  onRetry,
  retryRef,
  focusOnArrival = false,
  passive = false,
  page = false,
}: {
  title: string;
  error: Failure;
  /** What to say when the failure carries no message of its own. Name the thing that failed. */
  fallback: string;
  /** Everything the one-line message cannot carry, e.g. the list of values that were refused. */
  details?: ReactNode;
  onRetry?: () => void;
  retryRef?: Ref<HTMLButtonElement>;
  /**
   * Take the keyboard every time this alert arrives, including when it arrives carrying a
   * different failure than the one already on screen. Submitting disables the form, which blurs
   * the button that was pressed, so without this the keyboard lands on the document body — and a
   * second failed attempt leaves it there, because React reuses the alert rather than remounting
   * it. The alert carries the focus itself; a focusable wrapper around it is a second node with
   * no name.
   */
  focusOnArrival?: boolean;
  passive?: boolean;
  /** Set when the alert stands in a page stack rather than inside a form, dialog, or section. */
  page?: boolean;
}) {
  const alert = useRef<HTMLDivElement>(null);
  const message = failureMessage(error, fallback);
  useEffect(() => {
    if (focusOnArrival) alert.current?.focus();
  }, [focusOnArrival, title, message]);
  const retry =
    onRetry === undefined ? null : (
      <Button ref={retryRef} type="button" size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    );
  const focus = focusOnArrival ? { tabIndex: -1 } : {};
  const role = passive ? undefined : "alert";
  if (page) {
    return (
      <PageAlert ref={alert} role={role} title={title} {...focus}>
        <p>{message}</p>
        {details}
        {retry}
      </PageAlert>
    );
  }
  return (
    <Alert
      ref={alert}
      variant="destructive"
      role={role}
      icon={WARNING_GLYPH}
      title={title}
      {...focus}
    >
      <p>{message}</p>
      {details}
      {retry}
    </Alert>
  );
}

/**
 * Something that went right, or something the reader should know about where they are, in the
 * same box a failure would have used. It is announced politely rather than urgently: nothing
 * here interrupts what the reader is doing, and `role="status"` is what makes an activation or
 * a return from a provider portal reach a screen reader without being read as an alarm.
 */
export function NoticeAlert({
  tone,
  title,
  children,
}: {
  tone: "neutral" | "success";
  title?: string;
  children: ReactNode;
}) {
  return (
    <Alert
      role="status"
      variant={tone === "success" ? "success" : "default"}
      icon={tone === "success" ? SUCCESS_GLYPH : NEUTRAL_GLYPH}
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </Alert>
  );
}

/**
 * Something the reader should know before they act, that does not stop them acting, inside a
 * form or a section. A page's own warnings are `PageAlert`. Every inline alert is the same shape — glyph, title, message, optional trailing control — and
 * only the colour and the glyph say which kind it is.
 */
export function WarningAlert({
  title,
  action,
  passive = false,
  children,
}: {
  title?: string;
  /** The way out of the warning, at the far edge: a link to the page that resolves it. */
  action?: ReactNode;
  /** Set for warnings derived from the page snapshot. */
  passive?: boolean;
  children: ReactNode;
}) {
  return (
    <Alert
      variant="warning"
      role={passive ? undefined : "alert"}
      icon={WARNING_GLYPH}
      {...(title === undefined ? {} : { title })}
      {...(action === undefined ? {} : { action })}
    >
      {children}
    </Alert>
  );
}
