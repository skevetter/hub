// Opt-in generated-document runs with wall-clock checks. Run on a quiet machine:
//   npm run test:replies:fuzz            (3,000 documents per generator)
//   HUB_REPLY_FUZZ_DOCS=15000 npm run test:replies:fuzz
import { describe, it } from "vitest";
import {
  checkFenceTrickDocuments,
  checkNestedDocuments,
  checkStackedDocuments,
} from "./test-utils/nesting.js";

const count = Number(process.env["HUB_REPLY_FUZZ_DOCS"] ?? 3_000);

describe.skipIf(process.env["HUB_REPLY_FUZZ"] !== "1")("reply formatting fuzz", () => {
  it(
    "renders stacked-container documents safely",
    () => checkStackedDocuments({ seed: 7_101, count, timing: true }),
    600_000,
  );
  it.each([9_101, 9_202, 9_303])(
    "renders fence tricks and tab markers the same way every call, in time (seed %i)",
    (seed) => checkFenceTrickDocuments({ seed, count, timing: true }),
    600_000,
  );
  it.each([8_101, 8_202, 8_303])(
    "renders cross-line nesting the same way every call, in time (seed %i)",
    (seed) => checkNestedDocuments({ seed, count, timing: true }),
    600_000,
  );
});
