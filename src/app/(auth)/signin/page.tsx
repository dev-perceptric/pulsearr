import type { Metadata } from "next";
import { AuthPage, NotReady } from "@/components/AuthPage";
import { clientConfig } from "../../_lib/config";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const config = await clientConfig();
  return config ? <AuthPage config={config} /> : <NotReady />;
}
