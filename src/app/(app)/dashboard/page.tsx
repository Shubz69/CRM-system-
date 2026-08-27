import { redirect } from "next/navigation";

/** Legacy overview → Home command centre. */
export default function DashboardRedirectPage() {
  redirect("/home");
}
