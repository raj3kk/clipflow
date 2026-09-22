import { Space_Grotesk, Inter } from "next/font/google";
import AppShell from "./components/AppShell";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const SITE_URL = "https://clipflow-webbuilder1.vercel.app";

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ClipFlow — Apne Phone Se Clipping Automate Karo",
    template: "%s — ClipFlow",
  },
  description:
    "ClipFlow + AutoClip app: apne phone se clipping automate karo. Campaign chuno, schedule lagao, phone khud Instagram pe post karega — aur online time par coins kamao.",
  keywords: ["clipping", "automation", "Instagram reels", "Whop", "AutoClip", "ClipFlow", "content rewards", "coin rewards"],
  authors: [{ name: "ClipFlow" }],
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "ClipFlow",
    url: SITE_URL,
    title: "ClipFlow — Apne Phone Se Clipping Automate Karo",
    description:
      "App install karo, campaign chuno, phone khud post karega. Online time par coins kamao.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ClipFlow — CF ribbon logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipFlow — Apne Phone Se Clipping Automate Karo",
    description:
      "App install karo, campaign chuno, phone khud post karega. Online time par coins kamao.",
    images: ["/og-image.png"],
  },
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hi" className={`${display.variable} ${sans.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
