// Deterministic corpus of realistic agent answers, 1,500 to 3,500 characters each.
const blocks: Array<(n: number) => string> = [
  (n) =>
    `### \`src/retry${n}.ts\`\n\n\`\`\`ts\nexport async function retry${n}<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (error) {\n      if (i === attempts - 1) throw error;\n    }\n  }\n  throw new Error("unreachable");\n}\n\`\`\`\n`,
  (n) =>
    `\`\`\`rust\nfn load${n}<T: Deserialize>(path: &Path) -> Result<Vec<T>, Error> {\n    let raw = fs::read_to_string(path)?;\n    let items: Vec<T> = serde_json::from_str(&raw)?;\n    Ok(items.into_iter().filter(|x| x.ok()).collect())\n}\n\`\`\`\n`,
  (n) =>
    `\`\`\`go\nfunc Handle${n}(w http.ResponseWriter, r *http.Request) {\n\tif err := process(r.Context(), r.Body); err != nil {\n\t\thttp.Error(w, err.Error(), 500)\n\t\treturn\n\t}\n\tw.WriteHeader(http.StatusNoContent)\n}\n\`\`\`\n`,
  (n) =>
    `\`\`\`python\ndef group${n}(rows: list[dict[str, int]]) -> dict[str, list[int]]:\n    out: dict[str, list[int]] = {}\n    for row in rows:\n        for key, value in row.items():\n            out.setdefault(key, []).append(value)\n    return out\n\`\`\`\n`,
  (n) =>
    `\`\`\`sql\nSELECT o.id, count(*) AS lines\nFROM orders o\nJOIN order_lines l ON l.order_id = o.id\nWHERE o.created_at > now() - interval '${n} days'\nGROUP BY o.id\nHAVING count(*) > 1;\n\`\`\`\n`,
  (n) =>
    `Run the checks from the repo root:\n\n\`\`\`sh\nnpm ci && npm run typecheck\nnpx vitest run --maxWorkers=1 src/part${n} 2>&1 | tail -n 20\nfor f in $(git diff --name-only); do echo "$f"; done\n\`\`\`\n`,
  (n) =>
    `\`\`\`json\n{\n  "name": "pkg-${n}",\n  "scripts": { "build": "tsc -p .", "test": "vitest run" },\n  "dependencies": { "zod": "^3.${n}.0" }\n}\n\`\`\`\n`,
  (n) =>
    `The failure came from here:\n\n\`\`\`\nTypeError: Cannot read properties of undefined (reading 'id')\n    at lookup${n} (/app/src/store.ts:${n + 10}:21)\n    at async Promise.all (index ${n})\n    at run (/app/src/engine.ts:88:5)\n\`\`\`\n`,
  (n) =>
    `| File | Change | Lines |\n| --- | --- | ---: |\n| \`src/a${n}.ts\` | Added guard | ${n} |\n| \`src/b${n}.ts\` | Removed dead code | -${n * 3} |\n| \`docs/x${n}.md\` | Updated | 3 |\n| \`test/y${n}.test.ts\` | New cases for \`Map<string, number>\` | ${n * 7} |\n`,
  (n) =>
    `- Changed \`parse${n}\` to return \`Result<T, E>\`.\n  - Callers now match on \`ok\`.\n  - The old \`throw\` path is gone.\n- Updated the docs at [the guide](https://example.com/docs/guide_${n}_(draft)).\n- Kept **${n}** retries and the _default_ timeout.\n    1. First nested step with \`a < b && c > d\`.\n    2. Second nested step.\n`,
  (n) =>
    `> Note: the cache key includes the tenant id, so \`get<K>(key: K)\` is safe across tenants (run ${n}).\n\n1. Check the flag.\n2. Restart the worker with \`PORT=${3000 + n}\`.\n3. Watch the log for \`ready\`.\n`,
  (n) =>
    `I checked the arrow functions \`(a, b) => a + b\` and \`x => x * ${n}\` in \`utils.ts\`. They return the same values as the loops, so I replaced them. The \`snake_case_name_${n}\` identifiers stay as they are. See https://github.com/acme/app/pull/${100 + n} and the file src/util_${n}.ts for the diff.\n`,
  (n) =>
    `\`\`\`diff\n--- a/src/config${n}.ts\n+++ b/src/config${n}.ts\n@@ -${n},3 +${n},4 @@\n-const limit = 10;\n+const limit = Number(process.env.LIMIT ?? 10);\n+export const names: Array<string | null> = [];\n\`\`\`\n`,
  (n) =>
    `\`\`\`tsx\nexport function Row${n}({ items }: { items: Array<{ id: string; label: string }> }) {\n  return (\n    <ul>\n      {items.map((item) => (\n        <li key={item.id}>{item.label}</li>\n      ))}\n    </ul>\n  );\n}\n\`\`\`\n`,
  (n) =>
    `Tracked in [issue ${n} on Linear](https://linear.app/acme/issue/ENG-${n}/fix-login-redirect-loop?comment=xyz). CI: [run ${n}](https://github.com/getpaseo/hub/actions/runs/19283746${n}/job/54839201).\n`,
];

const intros = [
  "I fixed the bug and added tests. Here is what changed.",
  "Done. The change is small and the tests pass locally.",
  "The cause was a missing null check. Summary below.",
  "I traced the failure to the retry path and patched it.",
];

const outros = [
  "Next step: review the diff and run the full suite.",
  "I did not run the integration tests here.",
  "Tell me if you want the helper moved to its own module.",
];

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function realisticAnswers(count: number): string[] {
  const answers: string[] = [];
  for (let index = 0; answers.length < count; index += 1) {
    const next = random(9_000 + index);
    // Aim anywhere from 1,500 to 3,400 characters so long answers are well covered.
    const target = 1_500 + Math.floor(next() * 1_900);
    let text = `${intros[Math.floor(next() * intros.length)]}\n\n`;
    for (let guard = 0; text.length < target && guard < 60; guard += 1) {
      const block = blocks[Math.floor(next() * blocks.length)]!(index + guard);
      if (text.length + block.length < 3_350) text += `${block}\n`;
    }
    text += outros[Math.floor(next() * outros.length)];
    if (text.length >= 1_500 && text.length <= 3_500) answers.push(text);
  }
  return answers;
}
