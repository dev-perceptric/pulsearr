import type { Metadata } from "next";
import { AuthPage, NotReady } from "@/components/AuthPage";
import { clientConfig } from "../../_lib/config";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage() {
  const config = await clientConfig();
  return config ? <AuthPage config={config} /> : <NotReady />;
}
