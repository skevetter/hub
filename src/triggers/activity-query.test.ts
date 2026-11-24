import { expect, it } from "vitest";
import {
  activityPageRequest,
  activitySearchSchema,
  activityStatusLabel,
} from "./activity-query.js";

it("keeps the combined unsuccessful filter in the URL and page request", () => {
  const search = activitySearchSchema.parse({ status: "unsuccessful", range: "7d" });
  expect(search.status).toBe("unsuccessful");
  expect(activityPageRequest("team", search)).toMatchObject({
    status: "unsuccessful",
    range: "7d",
  });
  expect(activityStatusLabel("unsuccessful")).toBe("Failed, timed out or rejected");
  expect(activityStatusLabel("failed")).toBe("Failed");
});
