import Shell from "@/components/shell";

/**
 * Console route group: every signed-in destination shares the operations
 * shell (sidebar, header, mobile drawer). The landing page lives in the
 * sibling (site) group and renders without the shell.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
