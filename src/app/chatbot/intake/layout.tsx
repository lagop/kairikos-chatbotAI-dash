import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Configura tu chatbot — Kairikos",
  description:
    "Responde 7 preguntas y configuramos tu chatbot personalizado para tu sector. Sin compromiso, en menos de 5 minutos.",
  openGraph: {
    title: "Configura tu chatbot — Kairikos",
    description:
      "Responde 7 preguntas y configuramos tu chatbot personalizado para tu sector. Sin compromiso, en menos de 5 minutos.",
    type: "website",
    locale: "es_ES",
    siteName: "Kairikos",
  },
  twitter: {
    card: "summary_large_image",
    title: "Configura tu chatbot — Kairikos",
    description:
      "Responde 7 preguntas y configuramos tu chatbot personalizado para tu sector. Sin compromiso, en menos de 5 minutos.",
  },
  alternates: {
    canonical: "https://www.kairikos.com/chatbot/intake",
  },
};

export default function IntakeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
