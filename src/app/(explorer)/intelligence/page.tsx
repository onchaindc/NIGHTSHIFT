import { redirect } from "next/navigation";

/** The intelligence hub retired: the Network page IS the catalog now, and the
    Deal Desk is a first-class destination in the header. */
export default function IntelligenceRedirect() {
  redirect("/miners");
}
