import Link from 'next/link';
import { withChatbot } from '@/lib/wizard-url';

// =============================================================================
// Fase 4 multi-instancia — el selector de chatbot de las pantallas del
// chatbot (canales, conocimiento, conversaciones).
//
// Mismo criterio que ReviewLocationPicker: **no se dibuja con un solo
// chatbot**, que es el caso de todos los clientes de hoy, y son enlaces y no
// un desplegable: cambiar de chatbot es navegar, y cada uno tiene su propia
// dirección.
// =============================================================================

export interface ChatbotPickerOption {
  clientProductId: string;
  name: string;
}

export function ChatbotPicker({
  chatbots,
  selectedId,
  basePath,
  description,
}: {
  chatbots: ChatbotPickerOption[];
  selectedId: string | null;
  /** La pantalla actual, sin query: el enlace añade `?clientProductId=`. */
  basePath: string;
  description: string;
}) {
  if (chatbots.length <= 1) return null;

  return (
    <section className="card space-y-3" aria-label="Tus chatbots" data-testid="chatbot-picker">
      <div>
        <p className="text-sm font-semibold">Tus chatbots</p>
        <p className="text-xs text-kairikos-muted">{description}</p>
      </div>

      <ul className="flex flex-wrap gap-2">
        {chatbots.map((chatbot) => {
          const isSelected = chatbot.clientProductId === selectedId;
          return (
            <li key={chatbot.clientProductId}>
              <Link
                href={withChatbot(basePath, chatbot.clientProductId)}
                aria-current={isSelected ? 'page' : undefined}
                data-testid="chatbot-picker-option"
                data-selected={isSelected ? 'true' : 'false'}
                className={`block rounded-xl border px-3.5 py-2 text-sm font-medium text-kairikos-text transition ${
                  isSelected
                    ? 'border-kairikos-accent bg-kairikos-accent/10'
                    : 'border-kairikos-border bg-kairikos-surface2 hover:border-kairikos-accent'
                }`}
              >
                {chatbot.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
