"use client";

import { useState } from "react";
import { useShell } from "@/components/AppShell";
import { LogOut } from "@/components/Icons";
import { Loader } from "@/components/Loader";
import { SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui";

export function AccountSettings() {
  const { user, signOut } = useShell();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SettingsSection title="Email" sub="The address you sign in with">
        <p className="text-[14px] wrap-anywhere text-ink">{user.email}</p>
      </SettingsSection>
      <SettingsSection
        title="Sign out"
        sub="Ends your session on this browser"
        action={
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await signOut();
            }}
          >
            {busy ? <Loader size={4} /> : <LogOut size={16} />}
            Sign out
          </Button>
        }
      />
    </>
  );
}
