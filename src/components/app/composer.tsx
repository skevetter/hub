import {
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";
import { FailureAlert } from "./failure-alert.js";
import { FormField } from "./form-field.js";

export const MAX_COMPOSER_BYTES = 16 * 1024;
const OVER_LIMIT = "Message is over 16 KiB.";

/** The counter shows once the draft is within this many bytes of the limit. */
const COUNTER_FROM = 1024;

const ENCODER = new TextEncoder();

const STEER_PERMISSION_MESSAGE =
  "The agent is waiting for a permission answer, so Steer now is unavailable. Queue still works.";
const STEER_NOTE =
  "Steer now sends at once. If the agent cannot take it mid-step, it may restart the step.";

export type ComposerAgentState = "idle" | "running" | "waiting_permission";

type Action = { enabled: true } | { enabled: false; reason: string };

export type ComposerActions =
  | { mode: "single"; send: Action }
  | { mode: "split"; steer: Action; queue: Action };

export function messageBytes(text: string): number {
  return ENCODER.encode(text).length;
}

function blockReason(busy: boolean, bytes: number): string | null {
  if (busy) return "Sending.";
  if (bytes === 0) return "Write a message first.";
  if (bytes > MAX_COMPOSER_BYTES) return OVER_LIMIT;
  return null;
}

function counterNote(used: number, disabledReason: string | undefined): string | undefined {
  if (used > MAX_COMPOSER_BYTES) return OVER_LIMIT;
  const left = MAX_COMPOSER_BYTES - used;
  if (left <= COUNTER_FROM) return `${left} bytes left`;
  return disabledReason;
}

/** Which buttons exist for an agent state, and which of them can be pressed right now. */
export function composerActions(
  agentState: ComposerAgentState,
  busy: boolean,
  bytes: number = 1,
): ComposerActions {
  const blocked = blockReason(busy, bytes);
  const gate = (reason: string | null): Action =>
    reason === null ? { enabled: true } : { enabled: false, reason };
  if (agentState === "idle") return { mode: "single", send: gate(blocked) };
  return {
    mode: "split",
    steer: gate(agentState === "waiting_permission" && !busy ? STEER_PERMISSION_MESSAGE : blocked),
    queue: gate(blocked),
  };
}

export function composerKeyIntent(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): "submit" | "none" {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) ? "submit" : "none";
}

/**
 * The reply box. Presentational: a handler resolves `true` when the message was accepted, which
 * clears the draft, and `false` when it was not, which keeps it. The caller shows why in `error`.
 */
export function Composer({
  agentState,
  busy = false,
  disabledReason,
  error,
  initialDraft = "",
  messageLabel = "Message",
  primaryLabel = "Send",
  placeholder,
  hint,
  secondaryAction,
  onSteer,
  onQueue,
  onStop,
}: {
  agentState: ComposerAgentState;
  /** A send is in flight. */
  busy?: boolean;
  /** The session cannot take messages at all; says why. */
  disabledReason?: string | undefined;
  error?: string | undefined;
  initialDraft?: string;
  messageLabel?: string;
  primaryLabel?: string;
  placeholder?: string;
  hint?: string | undefined;
  secondaryAction?: ReactNode;
  /** In `idle` this is the one Send. */
  onSteer: (text: string) => Promise<boolean>;
  onQueue: (text: string) => Promise<boolean>;
  onStop?: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(initialDraft);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bytes = messageBytes(draft.trim());
  const used = messageBytes(draft);
  const locked = disabledReason !== undefined;
  const actions = composerActions(agentState, busy || locked, bytes);
  const over = used > MAX_COMPOSER_BYTES;

  const submit = useCallback(
    async (send: (text: string) => Promise<boolean>) => {
      const accepted = await send(draft.trim());
      if (accepted) setDraft("");
      textarea.current?.focus();
    },
    [draft],
  );
  const primary = actions.mode === "single" ? actions.send : actions.steer;
  const steer = useCallback(() => void submit(onSteer), [submit, onSteer]);
  const queue = useCallback(() => void submit(onQueue), [submit, onQueue]);
  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    [],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composerKeyIntent(event) === "none") return;
      event.preventDefault();
      if (primary.enabled) steer();
    },
    [primary.enabled, steer],
  );
  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (primary.enabled) steer();
    },
    [primary.enabled, steer],
  );
  const description = counterNote(used, disabledReason) ?? hint;

  return (
    <form className="grid min-w-0 gap-3" onSubmit={onSubmit}>
      {error === undefined ? null : (
        <FailureAlert title="Message not sent" error={error} fallback="Message not sent." />
      )}
      <FormField
        id={fieldId}
        label={messageLabel}
        {...(description === undefined ? {} : { description })}
        {...(over ? { error: OVER_LIMIT } : {})}
      >
        {(control) => (
          <Textarea
            {...control}
            ref={textarea}
            rows={3}
            placeholder={placeholder}
            value={draft}
            disabled={locked}
            onChange={onChange}
            onKeyDown={onKeyDown}
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        {actions.mode === "single" ? (
          <Button type="submit" disabled={!actions.send.enabled}>
            {primaryLabel}
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={!actions.steer.enabled}>
              Steer now
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!actions.queue.enabled}
              onClick={queue}
            >
              Queue for next turn
            </Button>
          </>
        )}
        {secondaryAction}
        {onStop === undefined ? null : (
          <Button type="button" variant="outline" onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
      {actions.mode === "split" ? (
        <p className="text-xs text-muted-foreground">
          {agentState === "waiting_permission" ? STEER_PERMISSION_MESSAGE : STEER_NOTE}
        </p>
      ) : null}
    </form>
  );
}
