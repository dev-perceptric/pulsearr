import { redirect } from "next/navigation";
import { HOME } from "@/lib/signin";

// The app's front door opens the dashboard; signed out, the shell sends it on to /signin.
export default function Home() {
  redirect(HOME);
}
