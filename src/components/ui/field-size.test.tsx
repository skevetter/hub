import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { Combobox } from "../app/combobox.js";
import { ListFilterSelect } from "../app/list-filters.js";
import { Input } from "./input.js";
import { Select, SelectTrigger } from "./select.js";

const NOOP = () => {};
const FILTER_OPTIONS = [{ value: "on", label: "Enabled" }];
const AGENT_OPTIONS = [{ value: "a", label: "A" }];
const hasClass = (markup: string, name: string) =>
  [...markup.matchAll(/class="([^"]*)"/gu)].some(([, value]) => value?.split(" ").includes(name));

describe("field phone size", () => {
  it("lifts an input to 44 px on a phone and keeps its 32 px desktop height", () => {
    const markup = renderToStaticMarkup(<Input aria-label="Name" />);
    assert.ok(hasClass(markup, "h-8"));
    assert.ok(hasClass(markup, "max-md:h-11"));
  });

  it("lifts the default and small Select triggers to 44 px on a phone", () => {
    for (const size of ["default", "sm"] as const) {
      const markup = renderToStaticMarkup(
        <Select>
          <SelectTrigger size={size} aria-label="Role" />
        </Select>,
      );
      assert.ok(hasClass(markup, `max-md:data-[size=${size}]:h-11`), size);
    }
  });

  it("lifts a native filter select to 44 px on a phone", () => {
    const markup = renderToStaticMarkup(
      <ListFilterSelect
        label="State"
        name="state"
        allLabel="All states"
        options={FILTER_OPTIONS}
        value={undefined}
        onChange={NOOP}
      />,
    );
    assert.ok(hasClass(markup, "h-8"));
    assert.ok(hasClass(markup, "max-md:h-11"));
  });

  it("leaves the combobox trigger to the button's 44 px phone minimum", () => {
    const markup = renderToStaticMarkup(
      <Combobox
        id="agent"
        label="Agent"
        value=""
        options={AGENT_OPTIONS}
        placeholder="Pick"
        empty="None"
        onChange={NOOP}
      />,
    );
    assert.ok(hasClass(markup, "max-md:min-h-11"));
    assert.ok(!hasClass(markup, "max-md:min-h-8"));
  });
});
