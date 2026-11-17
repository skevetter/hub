import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createLogger } from "../logger.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import { RunStream } from "./index.js";
import { access, createStreamHarness, settings } from "./test-utils.js";

const subjectId = "00000000-0000-4000-8000-000000000123";
const syntheticSecret = "paseo_pk_fixture-only-private-secret-never-an-id";

describe("run stream structured closure logs", () => {
  it.each(["apiKey", "cliCredential", "session"] as const)(
    "keeps %s identity visible without logging its secret",
    async (kind) => {
      const harness = await createStreamHarness("memory");
      const sink = new FailureLogStream();
      const logger = createLogger(sink);
      const service = new RunStream({
        database: harness.database,
        auth: harness.auth,
        bus: harness.bus,
        reconciler: harness.reconciler,
        settings,
        logger,
        credentials: {
          authorize: async (request) => {
            assert.equal(request.headers.get("authorization"), `Bearer ${syntheticSecret}`);
            return {
              status: "authorized",
              access: {
                ...access,
                kind: kind === "session" ? "apiKey" : kind,
                credentialId: subjectId,
              },
            };
          },
          reauthorize: async () => true,
        },
      });
      try {
        const run = await harness.createRun();
        const request = new Request(
          `http://localhost/api/v1/runs/${run.id}/events?organization=stream`,
          {
            headers:
              kind === "session"
                ? { cookie: "session=member" }
                : { authorization: `Bearer ${syntheticSecret}` },
          },
        );
        const response = await service.handle(request, run.id);
        assert.equal(response.status, 200);
        await response.body!.cancel();
        const records = sink.records();
        assert.equal(records.length, 1);
        const record = records[0]!;
        assert.equal(record["operation"], "run.stream.closed");
        assert.equal(record["authKind"], kind);
        assert.equal(record["authSubjectId"], kind === "session" ? "stream-member" : subjectId);
        assert.equal(record["reason"], "abort");
        assert.equal(record["triggerRunId"], run.id);
        assert.equal(sink.text().includes(syntheticSecret), false);
        logger.info(
          { credentialId: syntheticSecret, authorization: `Bearer ${syntheticSecret}` },
          "redaction remains enabled",
        );
        assert.equal(sink.text().includes(syntheticSecret), false);
        const redacted = sink.records()[1]!;
        assert.equal(redacted["credentialId"], "[Redacted]");
        assert.equal(redacted["authorization"], "[Redacted]");
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      } finally {
        await service.beginShutdown();
        await harness.close();
      }
    },
  );
});
