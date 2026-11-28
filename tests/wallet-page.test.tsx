import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Wallet destination contract:
 *
 *  · exactly ONE wallet summary card, no matter how many wallets exist —
 *    the duplicate presentation (embedded card + external card + payer card,
 *    each repeating balances) is what this page used to be;
 *  · one token story: Telegraph USDC is the token asks spend, ETH is gas;
 *    the irrelevant Circle USDC read and the deployment rail are gone;
 *  · the long transaction history is OFF this page entirely (user call:
 *    noise) — the page is summary + spending, short on mobile.
 */

const privy = vi.hoisted(() => ({
  ready: true,
  authenticated: true,
  wallets: [] as Array<{ address: string; walletClientType: string }>,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: privy.ready,
    authenticated: privy.authenticated,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  useWallets: () => ({ wallets: privy.wallets }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
  useCreateWallet: () => ({ createWallet: vi.fn() }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
}));

import FundsPage from "@/app/(explorer)/funds/page";

const EMBEDDED = { address: "0x1111111111111111111111111111111111111111", walletClientType: "privy" };
const EXTERNAL = { address: "0x2222222222222222222222222222222222222222", walletClientType: "walletConnect" };

function src(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Wallet page — exactly one summary card", () => {
  it("renders one summary card when only the in-app wallet exists", () => {
    privy.wallets = [EMBEDDED];
    const html = renderToStaticMarkup(<FundsPage />);
    expect(html).toContain('aria-label="Wallet summary"');
    // The big Telegraph USDC readout appears exactly once — no duplicate
    // balance cards — and the irrelevant Circle USDC read is gone.
    expect(html.split("Telegraph USDC · pays your asks").length - 1).toBe(1);
    expect(html).not.toContain("USDC (Circle)");
    expect(html).toContain("In-app wallet");
  });

  it("collapses a second wallet into a compact row, never a second card", () => {
    privy.wallets = [EMBEDDED, EXTERNAL];
    const html = renderToStaticMarkup(<FundsPage />);
    expect(html.split("Telegraph USDC · pays your asks").length - 1).toBe(1);
    expect(html).toContain("Also connected");
    expect(html).toContain("external wallet");
    // The user's spend credit is the first-class spending strip, in plain words.
    expect(html).toContain("Spend credit · the prepaid balance every ask is paid from");
    // The deployment's own wallet is not the user's business — rail removed.
    expect(html).not.toContain("Deployment settlement rail");
  });

  it("with no wallet at all, offers create/connect in one honest panel", () => {
    privy.wallets = [];
    const html = renderToStaticMarkup(<FundsPage />);
    expect(html.split("USDC (Circle)").length - 1).toBe(0);
    expect(html).toContain("No wallet connected yet");
    expect(html).toContain("Create in-app wallet");
    expect(html).toContain("Connect wallet");
  });
});

describe("Wallet page — organized sections backed by the real ledgers", () => {
  it("carries the summary and spending sections; the long history is gone", () => {
    privy.wallets = [EMBEDDED];
    const html = renderToStaticMarkup(<FundsPage />);
    expect(html).toContain('aria-label="Spending controls"');
    // The transaction/receipt history no longer stacks on the wallet page.
    expect(html).not.toContain('aria-label="Wallet activity"');
  });

  it("the spending panel reads the enforced standing endpoint, not invented numbers", () => {
    const allowance = src("src/components/wallet/spend-allowance.tsx");
    expect(allowance).toContain('"/api/spend/standing"');
  });

  it("dialogs fit the viewport and scroll internally", () => {
    const page = src("src/app/(explorer)/funds/page.tsx");
    expect(page).toContain("x-modal-panel");
    // Both modals use the shared containment class.
    expect(page.split("x-modal-panel").length - 1).toBeGreaterThanOrEqual(2);
  });
});
