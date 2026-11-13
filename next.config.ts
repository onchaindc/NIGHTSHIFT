import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@x402/evm", "@x402/fetch", "@x402/core"],
  async redirects() {
    return [
      // Legacy entry points that used to land on the workspace overview.
      // They now route into the console; / itself is the product landing.
      { source: "/overview", destination: "/console", permanent: true },
      // The landing page used to live here, reachable only by typing the URL.
      // It is the site root now; keep the old address working.
      { source: "/nightshift", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
