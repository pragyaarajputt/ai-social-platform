import type { Metadata } from "next";
import { BrandVoiceForm } from "@/components/ai/BrandVoiceForm";

export const metadata: Metadata = { title: "Brand voice" };

export default function BrandVoicePage() {
  return <BrandVoiceForm />;
}
