/**
 * Live, unpaid verification of the Minds capability matrix.
 *
 *   bun scripts/verify-minds-coverage.ts
 *
 * Runs the same `probeMindCoverage` adapter the API uses, for every Mind.
 * A valid canonical request returns the node's 402 x402 challenge; nothing is
 * signed and nothing is paid. Exit code 1 if any Mind has zero routable
 * supported dimensions (that would mean the matrix or the node regressed).
 */
import { MINDS } from "../src/lib/minds/registry";
import { probeMindCoverage } from "../src/lib/minds/capability-runner";

let failures = 0;
for (const mind of MINDS) {
  const coverage = await probeMindCoverage(mind.slug);
  const rejected = coverage.dimensions.filter((d) => d.status === "rejected" || d.status === "unavailable");
  console.log(
    `${mind.slug.padEnd(30)} routable ${coverage.routable}/${coverage.considered - coverage.gaps}  gaps ${coverage.gaps}  planned $${(coverage.plannedCostUsdCents / 100).toFixed(2)}`,
  );
  for (const failure of rejected) {
    console.log(`  ! ${failure.dimension}: ${failure.detail.slice(0, 160)}`);
  }
  if (coverage.routable === 0) failures += 1;
}
if (failures > 0) {
  console.error(`\n${failures} Mind(s) had no routable dimension`);
  process.exit(1);
}
console.log("\nAll Minds have at least one routable dimension. No payment was signed.");
