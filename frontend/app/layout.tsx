import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import AppShell from "@/components/AppShell";
import { Providers } from "../lib/query";
import "./globals.css";

/**
 * SEO: o painel é local (127.0.0.1:3100), então metadataBase aponta para o
 * endereço canônico local — troque se um dia for publicado num domínio.
 * As imagens OG/Twitter saem das convenções de arquivo (opengraph-image.png).
 */
export const metadata: Metadata = {
  metadataBase: new URL("http://127.0.0.1:3100"),
  title: {
    default: "Nebula Home — Painel local para dispositivos Tuya",
    template: "%s · Nebula Home",
  },
  description:
    "Painel local para dispositivos Tuya: lâmpadas e tomadas por LAN (protocolo 3.3/3.5) ou nuvem, blaster IR, câmera via P2P/RTSP decodificada localmente, cenas, energia e gestão das chaves no navegador.",
  applicationName: "Nebula Home",
  generator: "Next.js",
  keywords: [
    "Tuya", "smart home", "casa inteligente", "painel local", "dashboard",
    "lâmpada inteligente", "tomada inteligente", "controle IR", "infravermelho",
    "câmera P2P", "RTSP", "WebRTC", "LAN", "protocolo Tuya 3.3", "protocolo Tuya 3.5",
    "localKey", "energia", "automação residencial", "Nebula Home",
  ],
  authors: [{ name: "Nebula Home" }],
  creator: "Nebula Home",
  publisher: "Nebula Home",
  category: "smart home",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    url: "/",
    siteName: "Nebula Home",
    title: "Nebula Home — Painel local para dispositivos Tuya",
    description:
      "Controle Tuya direto na LAN ou pela nuvem, blaster IR, câmera P2P, cenas e energia — com as chaves guardadas só no seu navegador.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Nebula Home — Painel local para dispositivos Tuya",
    description:
      "Controle Tuya direto na LAN ou pela nuvem, blaster IR, câmera P2P, cenas e energia — com as chaves guardadas só no seu navegador.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: "#0f131c",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
