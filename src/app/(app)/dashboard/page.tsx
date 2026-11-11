import type { Metadata } from "next";
import { DashboardScreen } from "./DashboardScreen";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <DashboardScreen />;
}
