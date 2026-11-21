import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { useCallback } from "react";
import { LIST_RESULT_ACTION } from "../../src/components/app/list-result-announcement.js";
import { Pagination } from "../../src/components/app/pagination.js";

let runs = 1;
let reads = 0;
const client = new QueryClient();
const route = createRootRoute({
  component: Fixture,
  validateSearch: (search: Record<string, unknown>) => ({
    status: typeof search["status"] === "string" ? search["status"] : undefined,
  }),
});
const router = createRouter({ routeTree: route, history: createMemoryHistory() });

function addRun() {
  runs = 2;
}

function Fixture() {
  const navigate = route.useNavigate();
  const { data } = useQuery({
    queryKey: ["activity-fixture"],
    queryFn: () => Promise.resolve({ runs, reads: ++reads }),
    refetchInterval: 250,
  });
  const filter = useCallback(
    () => void navigate({ search: { status: "failed" }, state: LIST_RESULT_ACTION }),
    [navigate],
  );
  const count = data?.runs ?? 0;
  return (
    <>
      <h1 id="activity-title">Activity</h1>
      <button type="button" onClick={filter}>
        Filter runs
      </button>
      <button type="button" onClick={addRun}>
        Add run before next poll
      </button>
      <div data-testid="poll-reads">{data?.reads}</div>
      <Pagination
        label="Activity pages"
        position=""
        fallbackFocusId="activity-title"
        summary={`${count} visible`}
        announcement={count === 1 ? "1 run" : `${count} runs`}
        newer={null}
        older={null}
      />
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
