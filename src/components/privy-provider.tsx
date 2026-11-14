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
        appearance: { theme: "light", accentColor: "#0f766e" },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
