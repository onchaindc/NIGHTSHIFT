import { describe, expect, it } from "vitest";

import { handleAcpEntry } from "@/lib/acp/lifecycle";
import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import { MockAcpTransport } from "@/lib/acp/transport";
import { getAcpJob } from "@/lib/acp/store";
import { acpJobKey } from "@/lib/acp/store";
import type { AcpSessionRef } from "@/lib/acp/types";

/**
 * The buyer-wallet compatibility path: an ACP wallet that is NOT registered
 * on the ACP server cannot authenticate the job-room chat, so the requirement
 * rides the job's on-chain description. The provider must intake from it —
 * validate, price (setBudget), and wait for funding — exactly as it would
 * from the room message. Nothing is simulated on the money side: the mock
 * transport stands in for the network events only, and the assertions check
 * the REAL lifecycle decisions.
 */

const OFFERING = ACP_OFFERINGS[0];
const REQUIRED = Object.fromEntries(OFFERING.inputs.filter((i) => i.required).map((i) => [i.name, "Test Subject Ltd"]));

function ref(): AcpSessionRef {
  return { chainId: 8453, jobId: `${Date.now()}${Math.floor(Math.random() * 1000)}` };
}

async function startMock(): Promise<MockAcpTransport> {
  const transport = new MockAcpTransport();
  await transport.start({
    onEntry: async (r, entry) => {
      await handleAcpEntry(transport, r, entry);
    },
  });
  return transport;
}

describe("provider intake from the on-chain job description", () => {
  it("prices a job whose requirement arrived only via the description (unregistered buyer wallet)", async () => {
    const transport = await startMock();
    const r = ref();
    const requirement = JSON.stringify({ offering: OFFERING.id, inputs: REQUIRED });
    // The wallet transacted on-chain; no room message ever arrives.
    await transport.buyerJob(r, requirement, "0xunregistered", "description");

    const job = await getAcpJob(acpJobKey(r));
    expect(job).not.toBeNull();
    expect(job?.status).toBe("accepted");
    expect(job?.priceUsdCents).toBe(OFFERING.priceUsdCents);
    expect(job?.rawRequirement).toBe(requirement);
    expect(job?.requirement).toEqual(REQUIRED);
    // The provider named its price on the transport — the buyer can fund now.
    expect(transport.callsOf("setBudget")).toHaveLength(1);
    expect(transport.callsOf("setBudget")[0].amountUsdCents).toBe(OFFERING.priceUsdCents);
    await transport.stop();
  });

  it("still prefers the room message when the wallet can use the chat API", async () => {
    const transport = await startMock();
    const r = ref();
    const requirement = JSON.stringify({ offering: OFFERING.id, inputs: REQUIRED });
    await transport.buyerJob(r, requirement, "0xregistered", "message");

    const job = await getAcpJob(acpJobKey(r));
    expect(job?.status).toBe("accepted");
    expect(job?.priceUsdCents).toBe(OFFERING.priceUsdCents);
    await transport.stop();
  });

  it("a description that is not a requirement payload never prices anything", async () => {
    const transport = await startMock();
    const r = ref();
    await transport.buyerJob(r, "just a human note about this job", "0xunregistered", "description");

    const job = await getAcpJob(acpJobKey(r));
    expect(job?.status).toBe("received");
    expect(job?.priceUsdCents).toBeNull();
    expect(transport.callsOf("setBudget")).toHaveLength(0);
    await transport.stop();
  });
});

describe("handleAcpEntry stays idempotent when both channels deliver", () => {
  it("a room message after a description intake cannot price twice", async () => {
    const transport = await startMock();
    const r = ref();
    const requirement = JSON.stringify({ offering: OFFERING.id, inputs: REQUIRED });
    await transport.buyerJob(r, requirement, "0xdual", "description");
    // A redelivered/late room message lands on an already-priced job.
    await handleAcpEntry(transport, r, { kind: "message", contentType: "requirement", content: requirement });

    expect(transport.callsOf("setBudget")).toHaveLength(1);
    await transport.stop();
  });
});
