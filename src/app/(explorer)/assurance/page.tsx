import { redirect } from "next/navigation";

/** /assurance lives on as the Deal Desk. */
export default function AssuranceRedirect() {
  redirect("/desk");
}
