import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import RouteError from "@/app/error";
import GlobalError from "@/app/global-error";

/**
 * The error boundaries — the app previously had NONE, so any client render
 * exception dead-ended the page. The boundary contract: say what happened,
 * say what it is NOT (a transaction problem — nothing on Base moved), offer
 * recovery, and expose the raw error only inside the technical section.
 */
const ERR = Object.assign(new Error("cannot read properties of undefined (reading 'map')"), { digest: "abc123" });

describe("RouteError (src/app/error.tsx)", () => {
  const html = renderToStaticMarkup(<RouteError error={ERR} reset={() => undefined} />);

  it("names the failure and the money-truth", () => {
    expect(html).toContain("unexpected error");
    expect(html).toContain("not a transaction problem");
    expect(html).toContain("untouched");
  });

  it("offers recovery — retry and the storefront", () => {
    expect(html).toContain("Try again");
    expect(html).toContain("/buyer");
  });

  it("keeps the raw error behind the technical section", () => {
    expect(html).toContain("Technical details");
    // The raw message is NOT part of the initial static markup — it renders
    // only inside the expandable technical section.
    expect(html).not.toContain("cannot read properties of undefined");
  });
});

describe("GlobalError (src/app/global-error.tsx)", () => {
  const html = renderToStaticMarkup(<GlobalError error={Object.assign(new Error("layout exploded"), { digest: "g42" })} reset={() => undefined} />);

  it("renders a standalone recovery page without the app layout", () => {
    expect(html).toContain("<html");
    expect(html).toContain("failed to start");
    expect(html).toContain("Try again");
    expect(html).toContain("digest g42");
    expect(html).toContain("Base are untouched");
  });
});
