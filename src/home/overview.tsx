import type { HomeSnapshot } from "./dashboard.js";
import { HomeNeedsYou } from "./needs-you-figures.js";
import { HomeRuns } from "./runs-chart.js";

/** What the page is for: does anything need a person, and how are runs going. */
export function HomeOverview({ data, base }: { data: HomeSnapshot; base: string }) {
  return (
    <>
      <HomeNeedsYou data={data} base={base} />
      <HomeRuns days={data.runDays} />
    </>
  );
}
