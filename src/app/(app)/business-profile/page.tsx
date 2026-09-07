import { redirect } from "next/navigation";

/** Legacy deep-link — Business Profile lives at /business-context. */
export default function BusinessProfileRedirectPage() {
  redirect("/business-context");
}
