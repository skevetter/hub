import { useCallback } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { StateBlock } from "../components/app/state-block.js";
import { TwoLine } from "../components/app/two-line.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  canRevokeWebhookKey,
  canRotateWebhookKey,
  webhookKeyState,
  webhookKeyStatus,
  type WebhookKeyRecord,
} from "./webhook-keys-model.js";

export const WEBHOOK_KEY_COLUMNS = [
  { header: "Status", lead: true },
  { header: "Name", fill: true },
  { header: "Actor" },
  { header: "Expires" },
  { header: "Last used" },
  { header: "", align: "end" as const },
];

const EMPTY = {
  title: "No webhook keys",
  description:
    "Create a key so a sender can call this trigger. The key works for this trigger only.",
};

interface WebhookKeyTableProps {
  records: readonly WebhookKeyRecord[];
  now: number;
  busy: boolean;
  onRotate: (record: WebhookKeyRecord) => void;
  onRevoke: (id: string) => void;
}

export function WebhookKeyTable({ records, now, busy, onRotate, onRevoke }: WebhookKeyTableProps) {
  return (
    <DataTable
      label="Webhook keys"
      columns={WEBHOOK_KEY_COLUMNS}
      isEmpty={records.length === 0}
      empty={EMPTY}
    >
      {records.map((record) => (
        <WebhookKeyRow
          key={record.id}
          record={record}
          now={now}
          busy={busy}
          onRotate={onRotate}
          onRevoke={onRevoke}
        />
      ))}
    </DataTable>
  );
}

function WebhookKeyRow({
  record,
  now,
  busy,
  onRotate,
  onRevoke,
}: { record: WebhookKeyRecord } & Omit<WebhookKeyTableProps, "records">) {
  const status = webhookKeyStatus(record, now);
  const rotate = useCallback(() => onRotate(record), [onRotate, record]);
  const revoke = useCallback(() => onRevoke(record.id), [onRevoke, record.id]);
  const canRotate = canRotateWebhookKey(status);
  const canRevoke = canRevokeWebhookKey(status);
  return (
    <DataRow>
      <DataCell>
        <StateBlock state={webhookKeyState(status)} />
      </DataCell>
      <DataCell>
        <TwoLine primary={record.name} secondary={record.prefix} mono />
      </DataCell>
      <DataCell muted>{record.actor ?? "none"}</DataCell>
      <DataCell muted>
        {record.expiresAt === null ? "Never" : <RelativeTime value={record.expiresAt} />}
      </DataCell>
      <DataCell muted>
        {record.lastUsedAt === null ? "Never" : <RelativeTime value={record.lastUsedAt} />}
      </DataCell>
      <DataCell>
        {canRotate || canRevoke ? (
          <RowActions label={`Actions for ${record.name}`}>
            {canRotate ? (
              <DropdownMenuItem disabled={busy} onSelect={rotate}>
                Rotate key
              </DropdownMenuItem>
            ) : null}
            {canRevoke ? (
              <ConfirmMenuItem
                label="Revoke"
                destructive
                title={`Revoke ${record.name}?`}
                description="Any sender using this key stops working immediately. This cannot be undone."
                confirmLabel="Revoke key"
                cancelLabel="Cancel"
                busy={busy}
                onConfirm={revoke}
              />
            ) : null}
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}
