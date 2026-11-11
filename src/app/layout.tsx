import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import "./globals.css";

// Served from our own domain with the page, so text never waits on Google. globals.css reads the variables.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-newsreader" });

export const metadata: Metadata = {
  title: { default: "PulseARR", template: "%s | PulseARR" },
  description: "Revenue you can trust.",
  applicationName: "PulseARR",
};

export const viewport: Viewport = { themeColor: "#000522" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full ${inter.variable} ${serif.variable}`}>
      <body className="min-h-full font-sans antialiased">{children}</body>
    </html>
  );
}
