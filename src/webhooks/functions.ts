import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";

export const webhookSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<{ baseUrl: string }>> => {
    try {
      const application = await getApplication();
      const baseUrl = new URL(application.publicBaseUrl ?? getRequest().url).origin;
      return respondOk({ baseUrl });
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "webhooks.settings", component: "webhooks" },
        {
          fallback: "Hub couldn't load the webhook address. Reload the page.",
        },
      );
    }
  },
);
