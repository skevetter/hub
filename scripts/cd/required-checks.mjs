const flags = ["ui", "e2e", "workflows"];

export function requiredChecks(needs, nightly) {
  const changes = needs.changes;
  if (changes?.result !== "success") return false;
  if (!flags.every((name) => ["true", "false"].includes(changes.outputs?.[name]))) return false;
  const expected = {
    static: !nightly,
    "docker-smoke": !nightly,
    unit: !nightly,
    browser: nightly || changes.outputs.ui === "true",
    "hub-e2e": nightly || changes.outputs.e2e === "true",
    "workflow-lint": !nightly && changes.outputs.workflows === "true",
  };
  return Object.entries(expected).every(([name, required]) => {
    const result = needs[name]?.result;
    return result === "success" || (!required && result === "skipped");
  });
}

if (
  import.meta.main &&
  !requiredChecks(JSON.parse(process.env.NEEDS), process.env.NIGHTLY === "true")
) {
  console.error("A required job did not succeed or an optional job was not explicitly excluded");
  process.exitCode = 1;
}
