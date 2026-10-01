import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "PostDrip", template: "%s · PostDrip" },
  description: "An AI-first social platform.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <WorkspaceProvider>
            <SiteHeader />
            <VerifyEmailBanner />
            <main className="flex flex-1 flex-col">{children}</main>
            <SiteFooter />
          </WorkspaceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
