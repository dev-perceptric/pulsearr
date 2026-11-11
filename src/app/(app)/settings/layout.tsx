"use client";

import { usePathname, useRouter } from "next/navigation";
import { Settings, UserIcon, Users } from "@/components/Icons";
import { SettingsLayout } from "@/components/SettingsLayout";
import { sectionOf, type SettingsSectionId } from "@/components/shellState";
import { Page } from "@/components/ui";

// Settings: the section list on the left and one section at a time, each at its own address (/settings/team).
const GROUPS = [
  {
    items: [
      { value: "workspace" as SettingsSectionId, label: "Workspace", icon: <Settings size={16} /> },
      { value: "team" as SettingsSectionId, label: "Team", icon: <Users size={16} /> },
      { value: "account" as SettingsSectionId, label: "Account", icon: <UserIcon size={16} /> },
    ],
  },
];

export default function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <Page title="Settings" flush>
      <SettingsLayout label="Settings" groups={GROUPS} value={sectionOf(pathname)} onPick={(s) => router.push(`/settings/${s}`)}>
        {children}
      </SettingsLayout>
    </Page>
  );
}
