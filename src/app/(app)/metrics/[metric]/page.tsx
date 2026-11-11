import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { metricOf } from "@/lib/metrics";
import { MetricScreen } from "./MetricScreen";

type Props = { params: Promise<{ metric: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = metricOf((await params).metric);
  return { title: m?.label ?? "Metric" };
}

export default async function MetricPage({ params }: Props) {
  const m = metricOf((await params).metric);
  if (!m) notFound();
  return <MetricScreen id={m.id} />;
}
