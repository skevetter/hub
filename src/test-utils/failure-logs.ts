import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { z } from "zod";

export class FailureLogStream extends Writable {
  private readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    done();
  }

  text(): string {
    return this.chunks.join("");
  }

  records(): Record<string, unknown>[] {
    return this.text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
  }

  /** Records that carry an error, leaving out ordinary lifecycle logs. */
  failures(): Record<string, unknown>[] {
    return this.records().filter((record) => "err" in record);
  }
}

export function assertOneFailure(
  stream: FailureLogStream,
  expected: {
    operation: string;
    component: string;
    failureKind?: string;
    level?: number;
    canary: string;
  },
): Record<string, unknown> {
  const records = stream.failures();
  assert.equal(records.length, 1);
  const [record] = records;
  assert(record);
  assert.equal(record["operation"], expected.operation);
  assert.equal(record["component"], expected.component);
  assert.equal(record["failureKind"], expected.failureKind ?? "internal");
  assert.equal(record["level"], expected.level ?? 50);
  const error = z
    .object({ type: z.string(), stack: z.string().min(1) })
    .loose()
    .parse(record["err"]);
  assert.match(error.type, /Error$/u);
  assert.equal(stream.text().includes(expected.canary), false);
  return record;
}
