import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { AppPrivyProvider } from "@/components/privy-provider";

import { SITE_DESCRIPTION, SITE_URL } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

/** Editorial display voice for heroes and page statements. */
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "NIGHTSHIFT — see who answers, know what it costs",
    template: "%s · NIGHTSHIFT",
  },
  description: SITE_DESCRIPTION,
  applicationName: "NIGHTSHIFT",
  openGraph: {
    type: "website",
    siteName: "NIGHTSHIFT",
    title: "See who answers. Know what it costs.",
    description: SITE_DESCRIPTION,
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "See who answers. Know what it costs.",
    description: SITE_DESCRIPTION,
  },
};

// The browser's own chrome (status bar, tab strip on iOS/Android) follows the
// active theme instead of flashing the platform default over the paper/night
// surfaces.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#14120f" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("nightshift-theme");var d=t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full"><AppPrivyProvider appId={process.env.PRIVY_APP_ID}>{children}</AppPrivyProvider></body>
    </html>
  );
}
