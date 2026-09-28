// =============================================================================
// Revisión de seguridad del 22/09/2026 — de dónde puede venir una grabación.
//
// whisper.ts descarga CallEvent.recordingUrl añadiendo la autenticación
// Basic de la cuenta de Twilio (accountSid:authToken). Si esa URL apuntara a
// cualquier otro sitio, el token de la cuenta viajaría a ese servidor. Hoy
// solo la escribe el webhook de grabación, que verifica la firma de Twilio;
// esto es la segunda línea: la URL se comprueba al guardarla y otra vez
// antes de descargarla, para que un fallo futuro en la primera (otra ruta
// que escriba la columna, un import de datos) no se convierta en una fuga de
// credenciales.
//
// Solo https y solo el host de la API de Twilio, sin puerto ni credenciales
// incrustadas: la forma de las RecordingUrl que manda Twilio
// (https://api.twilio.com/2010-04-01/Accounts/AC…/Recordings/RE…). La ruta
// no se comprueba: lo que protege el token es a qué host se manda.
// =============================================================================

const TWILIO_API_HOST = 'api.twilio.com';

export function isTwilioRecordingUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === TWILIO_API_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}
