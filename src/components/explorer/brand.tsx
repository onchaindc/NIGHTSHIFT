import Link from "next/link";

/** The mark: a moon in an ink tile, sized to read as a logo rather than a badge. */
export function Wordmark({ hideTextBelow }: { hideTextBelow?: "lg" } = {}) {
  return (
    <Link href="/" aria-label="NIGHTSHIFT home" className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-ink text-night"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      </span>
      {/* Between phone and desktop the five-tab row needs the width: the mark
          alone keeps the wordmark legible without squeezing the tabs. */}
      <span
        className={`text-[12.5px] font-bold tracking-[0.22em] text-ink ${
          hideTextBelow === "lg" ? "hidden lg:inline" : ""
        }`}
      >
        NIGHTSHIFT
      </span>
    </Link>
  );
}
