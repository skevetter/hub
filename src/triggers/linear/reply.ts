import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { LinearOutputContextSchema } from "./provider.js";

const LinearReplyArgsSchema = z.object({ content: z.string().min(1) });

/** Emits a normal Linear issue comment, suitable for a concise eligibility result or draft PR URL. */
export function createLinearReplyExecutor(options: {
  client: Pick<LinearApiClient, "createComment">;
}): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const context = LinearOutputContextSchema.parse(input.outputContext);
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: args.content,
    });
  };
}
