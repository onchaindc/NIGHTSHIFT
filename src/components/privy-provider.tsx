"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { base } from "viem/chains";

/**
 * The app's Privy configuration. THE root cause of the buyer transaction
 * failure lived here: with `walletChainType: "ethereum-only"` and NO
 * defaultChain, Privy initialized embedded wallets on Ethereum mainnet
 * (chain 1) — so the buyer's very first signature put a Base ACP
 * transaction on chain 1, where the wallet had no gas ("insufficient
 * funds for gas"). NIGHTSHIFT's commerce runs on Base and nothing else:
 * the wallet is initialized on Base, Base is the only offered chain, and
 * the runtime guard (wallet-chain.ts) still verifies `eth_chainId` before
 * every signature — including for external wallets that arrive on
 * Ethereum mainnet.
 */
export function AppPrivyProvider({
  appId,
  children,
}: {
  appId: string | undefined;
  children: React.ReactNode;
}) {
  if (!appId) {
    return <>{children}</>;
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#0f766e",
          walletChainType: "ethereum-only",
        },
        // NIGHTSHIFT is Base-only: embedded wallets initialize on Base
        // (chain 8453) and Base is the only chain the app offers.
        defaultChain: base,
        supportedChains: [base],
        // Google is not enabled in the Privy dashboard for this app.
        // Offering it produces "Login with Google not allowed".
        loginMethods: ["email", "wallet"],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
