import type { Metadata } from "next";
import { AccountSettings } from "./AccountSettings";

export const metadata: Metadata = { title: "Account settings" };

export default function AccountPage() {
  return <AccountSettings />;
}
