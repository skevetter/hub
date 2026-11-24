import { useCallback, useId, useMemo, useState } from "react";
import type { TeamMember } from "../../auth/organization-contract.js";
import { Combobox } from "../../components/app/combobox.js";
import { RecordList, RecordRow } from "../../components/app/record-list.js";
import { RowActions } from "../../components/app/row-actions.js";
import { SegmentedControl } from "../../components/app/segmented-control.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { TwoLine } from "../../components/app/two-line.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu.js";
import type { SessionSnapshot } from "../functions.js";
import type { ParticipantRole } from "../types.js";

export type Participant = SessionSnapshot["participants"][number];
export type ChangeParticipant = (userId: string, role: ParticipantRole | null) => void;

const ROLES = [
  { value: "viewer", label: "Viewer" },
  { value: "controller", label: "Controller" },
];

export function ParticipantPicker({
  members,
  participants,
  onChange,
  disabled = false,
}: {
  members: readonly TeamMember[];
  participants: readonly { userId: string }[];
  onChange: ChangeParticipant;
  disabled?: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState("");
  const options = useMemo(
    () =>
      members
        .filter((member) => !participants.some(({ userId }) => userId === member.userId))
        .map(({ userId, name, email }) => ({ value: userId, label: name, detail: email })),
    [members, participants],
  );
  const available = options.some(({ value }) => value === selected);
  const add = useCallback(() => {
    if (!available) return;
    onChange(selected, "viewer");
    setSelected("");
  }, [available, onChange, selected]);
  const choose = useCallback(({ value }: { value: string }) => setSelected(value), []);
  if (options.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <Combobox
          id={id}
          label="Add a participant"
          value={available ? selected : ""}
          options={options}
          onChange={choose}
          placeholder="Choose a team member"
          empty="No team members match."
          disabled={disabled}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={!available || disabled}
      >
        Add
      </Button>
    </div>
  );
}

export function ParticipantList({
  participants,
  startedBy,
  accountId,
  onChange,
  editing = false,
  disabled = false,
}: {
  participants: readonly Participant[];
  startedBy?: string | undefined;
  accountId: string;
  onChange?: ChangeParticipant | undefined;
  editing?: boolean;
  disabled?: boolean;
}) {
  return (
    <RecordList label="Session participants">
      {participants.map((participant) => (
        <ParticipantRow
          key={participant.userId}
          participant={participant}
          starter={participant.userId === startedBy}
          you={participant.userId === accountId}
          onChange={onChange}
          editing={editing}
          disabled={disabled}
        />
      ))}
    </RecordList>
  );
}

interface ParticipantRowProps {
  participant: Participant;
  starter: boolean;
  you: boolean;
  onChange: ChangeParticipant | undefined;
  editing: boolean;
  disabled: boolean;
}

function ParticipantRow({
  participant,
  starter,
  you,
  onChange,
  editing,
  disabled,
}: ParticipantRowProps) {
  const { userId, name, role } = participant;
  const change = useCallback(
    (value: string) => onChange?.(userId, value === "controller" ? "controller" : "viewer"),
    [onChange, userId],
  );
  const toggle = useCallback(
    () => onChange?.(userId, role === "controller" ? "viewer" : "controller"),
    [onChange, role, userId],
  );
  const remove = useCallback(() => onChange?.(userId, null), [onChange, userId]);
  const canChange = onChange !== undefined && !starter;
  const actions = useMemo(
    () =>
      canChange
        ? renderParticipantActions({ disabled, editing, name, remove, role, toggle })
        : null,
    [canChange, disabled, editing, name, remove, role, toggle],
  );
  const roleOptions = useMemo(
    () => (disabled ? ROLES.map((option) => ({ ...option, disabled })) : ROLES),
    [disabled],
  );
  const status = useMemo(
    () =>
      editing ? (
        <SegmentedControl
          label={`Role for ${name}`}
          value={role}
          options={roleOptions}
          onChange={change}
        />
      ) : (
        <StatusPill tone="neutral">{role === "controller" ? "Controller" : "Viewer"}</StatusPill>
      ),
    [change, editing, name, role, roleOptions],
  );
  const permission = role === "controller" ? "Can send messages" : "Read only";
  return (
    <RecordRow status={status} actions={actions}>
      <TwoLine
        primary={you ? `${name} (you)` : name}
        secondary={starter ? "Started the session" : permission}
      />
    </RecordRow>
  );
}

function renderParticipantActions({
  disabled,
  editing,
  name,
  remove,
  role,
  toggle,
}: {
  disabled: boolean;
  editing: boolean;
  name: string;
  remove: () => void;
  role: ParticipantRole;
  toggle: () => void;
}) {
  return (
    <RowActions label={`Actions for ${name}`}>
      {editing ? null : (
        <DropdownMenuItem disabled={disabled} onSelect={toggle}>
          Make {role === "controller" ? "viewer" : "controller"}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem disabled={disabled} onSelect={remove}>
        Remove
      </DropdownMenuItem>
    </RowActions>
  );
}
