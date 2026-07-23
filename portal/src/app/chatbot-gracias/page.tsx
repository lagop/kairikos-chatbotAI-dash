import type { Metadata } from "next";
import Script from "next/script";

const SITE_URL = "https://www.kairikos.com";
const PAGE_PATH = "/chatbot-gracias";

export const metadata: Metadata = {
  title: "¡Gracias! Revisa tu email — Kairikos",
  description:
    "Te hemos enviado un email con el enlace mágico para activar tu portal Kairikos. Sigue los siguientes pasos para acceder a tu área de cliente.",
  openGraph: {
    title: "¡Gracias! Revisa tu email — Kairikos",
    description:
      "Te hemos enviado un email con el enlace mágico para activar tu portal Kairikos.",
    type: "website",
    locale: "es_ES",
    siteName: "Kairikos",
    url: `${SITE_URL}${PAGE_PATH}`,
  },
  twitter: {
    card: "summary_large_image",
    title: "¡Gracias! Revisa tu email — Kairikos",
    description:
      "Te hemos enviado un email con el enlace mágico para activar tu portal Kairikos.",
  },
  alternates: {
    canonical: `${SITE_URL}${PAGE_PATH}`,
  },
};

type SearchParams = {
  ref?: string | string[];
  intake_id?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default function ChatbotGraciasPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const ref = firstParam(searchParams.ref);
  const intakeId = firstParam(searchParams.intake_id);

  const refCopy =
    ref === "intake"
      ? "Tu configuración del chatbot"
      : ref
        ? "Tu solicitud"
        : "Tu solicitud";

  const trackingPayload = JSON.stringify({
    event: "chatbot_gracias_view",
    ref,
    intake_id: intakeId,
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
          Kairikos
        </p>

        <div className="mt-4 flex h-14 w-14 items-center justify-center rounded-full bg-kairikos-success/15 text-kairikos-success">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1
          className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl"
          data-testid="gracias-title"
        >
          ¡Gracias! Te hemos enviado un email con el enlace mágico para activar
          tu portal.
        </h1>

        <p className="mt-3 text-sm text-kairikos-muted sm:text-base">
          {refCopy} ha sido recibida correctamente. En los próximos minutos
          recibirás un correo con un enlace mágico para activar tu portal de
          cliente y empezar a configurar tu chatbot.
        </p>

        <ol className="mt-6 space-y-3 text-sm text-kairikos-text">
          <li className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-kairikos-accent/15 text-xs font-semibold text-kairikos-accent"
              aria-hidden="true"
            >
              1
            </span>
            <span>Revisa tu bandeja de entrada (y la carpeta de spam).</span>
          </li>
          <li className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-kairikos-accent/15 text-xs font-semibold text-kairikos-accent"
              aria-hidden="true"
            >
              2
            </span>
            <span>
              Pulsa el enlace mágico del email para activar tu portal y crear
              tu contraseña.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-kairikos-accent/15 text-xs font-semibold text-kairikos-accent"
              aria-hidden="true"
            >
              3
            </span>
            <span>
              Una vez dentro, sigue los pasos del wizard para terminar de
              configurar tu chatbot.
            </span>
          </li>
        </ol>

        <div className="mt-8 flex flex-col gap-2 sm:flex-row">
          <a
            href="https://kairikos.com/portal/login"
            className="btn-primary"
            data-testid="gracias-cta-login"
          >
            Ir al portal
          </a>
          <a
            href="https://kairikos.com"
            className="btn-ghost"
            data-testid="gracias-cta-home"
          >
            Volver a la web
          </a>
        </div>

        <p className="mt-6 text-xs text-kairikos-muted">
          ¿No has recibido el email en 10 minutos? Escríbenos a{" "}
          <a className="underline" href="mailto:hola@kairikos.com">
            hola@kairikos.com
          </a>{" "}
          y te lo reenviamos.
        </p>
      </div>

      <p className="mt-6 text-center text-xs text-kairikos-muted">
        Kairikos · Chatbots de IA para negocios en español
      </p>

      <Script id="gracias-tracking" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || []; window.dataLayer.push(${trackingPayload});`}
      </Script>
    </div>
  );
}
