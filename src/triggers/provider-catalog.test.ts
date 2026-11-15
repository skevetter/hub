import { describe, expect, it } from "vitest";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import {
  selectedProviderModel,
  unattendedAgentOptions,
  unattendedModeOptions,
} from "./provider-catalog.js";
import { unattendedModeRefusal } from "./configuration/unattended.js";

const entries: HubProviderSnapshotEntry[] = [
  {
    provider: "codex",
    label: "Codex",
    status: "ready",
    enabled: true,
    defaultModeId: "full-access",
    modes: [
      { id: "read-only", label: "Read only" },
      { id: "full-access", label: "Full access" },
    ],
    models: [
      { provider: "codex", id: "small", label: "Small", isSelectable: false },
      {
        provider: "codex",
        id: "gpt-5.4",
        aliases: ["latest"],
        label: "GPT-5.4",
        isDefault: true,
        thinkingOptions: [{ id: "xhigh", label: "Extra high" }],
      },
    ],
  },
];

const ompEntry: HubProviderSnapshotEntry = {
  provider: "omp",
  label: "omp",
  status: "ready",
  enabled: true,
  modes: [
    { id: "ask", label: "Ask" },
    { id: "write", label: "Write" },
    { id: "full", label: "Full" },
  ],
  models: [{ provider: "omp", id: "acme/model", label: "Model" }],
};

const geminiEntry: HubProviderSnapshotEntry = {
  provider: "gemini",
  label: "Gemini",
  status: "ready",
  enabled: true,
  modes: [{ id: "default", label: "Default" }],
  models: [{ provider: "gemini", id: "pro", label: "Pro" }],
};

describe("trigger provider catalog", () => {
  it("offers omp and the other unattended providers, and leaves out the rest", () => {
    expect(
      unattendedAgentOptions([...entries, ompEntry, geminiEntry]).map((option) => option.value),
    ).toEqual(["codex/gpt-5.4", "omp/acme/model"]);
  });

  it("offers only mode full for omp and every reported mode for codex", () => {
    expect(unattendedModeOptions(ompEntry)).toEqual([{ value: "full", label: "Full" }]);
    expect(unattendedModeOptions(entries[0]).map((mode) => mode.value)).toEqual([
      "read-only",
      "full-access",
    ]);
    expect(unattendedModeOptions(undefined)).toEqual([]);
  });

  it("refuses an omp mode that prompts, or no mode, and accepts full", () => {
    expect(unattendedModeRefusal("omp", "full")).toBeUndefined();
    expect(unattendedModeRefusal("omp", "write")).toMatch(/only in mode 'full'/u);
    expect(unattendedModeRefusal("omp", undefined)).toMatch(/No mode is set.*only in mode 'full'/u);
    expect(unattendedModeRefusal("codex", undefined)).toBeUndefined();
  });

  it("resolves aliases to the model-specific thinking catalog", () => {
    expect(selectedProviderModel(entries, "codex/latest").model?.thinkingOptions).toEqual([
      { id: "xhigh", label: "Extra high" },
    ]);
  });

  it("leaves configured values that are absent from the snapshot unresolved", () => {
    expect(selectedProviderModel(entries, "codex/retired")).toEqual({
      entry: entries[0],
      model: undefined,
    });
  });
});
