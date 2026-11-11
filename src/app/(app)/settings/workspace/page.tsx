import type { Metadata } from "next";
import { WorkspaceSettings } from "./WorkspaceSettings";

export const metadata: Metadata = { title: "Workspace settings" };

export default function WorkspacePage() {
  return <WorkspaceSettings />;
}
