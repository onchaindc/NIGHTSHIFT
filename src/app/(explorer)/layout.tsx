import type { Metadata } from "next";

import { ExplorerHeader } from "@/components/explorer/explorer-header";
import { MobileTabBar } from "@/components/explorer/mobile-tab-bar";
import { SiteFooter } from "@/components/explorer/site-footer";

export const metadata: Metadata = {
  title: {
    default: "NIGHTSHIFT Explorer",
    template: "%s · NIGHTSHIFT",
  },
  description:
    "A clear, real-time view of the Telegraph network: who the participants are, what they do, and how to engage with them.",
};

export default function ExplorerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-night">
      <ExplorerHeader />
      <main className="x-page flex-1">{children}</main>
      {/* Inside the app the page ends at its own content; the front page closes
          with a slim reference band. */}
      <SiteFooter />
      <MobileTabBar />
    </div>
  );
}
