import type { Metadata } from "next";
import { TeamSettings } from "./TeamSettings";

export const metadata: Metadata = { title: "Team settings" };

export default function TeamPage() {
  return <TeamSettings />;
}
