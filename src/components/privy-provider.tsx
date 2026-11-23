"use client";

import { PrivyProvider } from "@privy-io/react-auth";

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
