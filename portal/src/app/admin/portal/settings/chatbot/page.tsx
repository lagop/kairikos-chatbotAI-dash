import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getChatbotMessageCaps } from '@/lib/chatbot-settings';
import { ChatbotSettingsPanel } from '@/components/portal/ChatbotSettingsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chatbot · Admin',
  description: 'Configuración operativa del chatbot — tope de mensajes al mes por tarifa.',
  alternates: { canonical: '/admin/portal/settings/chatbot' },
  robots: { index: false, follow: false },
};

export default async function AdminChatbotSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/chatbot');
  }

  const caps = await getChatbotMessageCaps();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Chatbot"
        description="Cuánto puede llegar a costar un chatbot al mes. Es el único freno entre un bucle o un abuso y la factura del modelo."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <ChatbotSettingsPanel initialCaps={caps} />
    </div>
  );
}
