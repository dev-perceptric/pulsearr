import { AppShell } from "@/components/AppShell";
import { NotReady } from "@/components/AuthPage";
import { clientConfig } from "../_lib/config";

// Every signed-in page: the settings are read on the server when the page is asked for, then the client shell takes
// over (session, boot, sidebar).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const config = await clientConfig();
  if (!config) return <NotReady />;
  return <AppShell config={config}>{children}</AppShell>;
}
