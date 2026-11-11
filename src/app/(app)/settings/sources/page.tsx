import type { Metadata } from "next";
import { SourcesSettings } from "./SourcesSettings";

export const metadata: Metadata = { title: "Sources" };

export default function SourcesPage() {
  return <SourcesSettings />;
}
