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
  expect(activityStatusLabel("unsuccessful")).toBe("Did not finish or rejected");
  expect(activityStatusLabel("did_not_finish")).toBe("Did not finish");
  expect(activityStatusLabel("rejected")).toBe("Rejected");
  expect(activityStatusLabel("canceled")).toBe("Canceled");
  expect(activitySearchSchema.parse({ status: "failed" }).status).toBeUndefined();
});
