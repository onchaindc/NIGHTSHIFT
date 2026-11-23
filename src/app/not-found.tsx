import Link from "next/link";

import { Wordmark } from "@/components/explorer/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-night px-6 py-16 text-center">
      <Wordmark />
      <p className="x-tag mt-12">404 · NOT ON THE NETWORK</p>
      <h1 className="x-display-1 mt-4 max-w-[18ch] text-balance text-ink">This page isn&apos;t here.</h1>
      <p className="mt-4 max-w-md text-[14px] leading-relaxed text-ink-soft">
        The address may have moved with the network. The Explorer is the shortest way back.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/miners" className="btn-primary !min-h-10">
          Browse miners
        </Link>
        <Link href="/" className="btn-quiet !min-h-10">
          Front page
        </Link>
      </div>
    </main>
  );
}
