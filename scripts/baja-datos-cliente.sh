#!/bin/sh
# =============================================================================
# Baja de los datos de un cliente: chat, llamadas o solicitudes (RGPD,
# encargo del tratamiento, PR 5a). Procedimiento completo en
# portal/docs/runbooks/baja-datos-cliente.md: léelo antes de usar esto.
#
# Se lanza desde el equipo del operador. Entra por SSH en la VPS y llama a
# POST /api/internal/client-data-exit desde el contenedor del scheduler, que
# ya tiene CRON_SECRET: el secreto no sale de la VPS ni pasa por aquí.
#
#   VPS=root@<ip> scripts/baja-datos-cliente.sh estado  --cliente <id> --producto chatbot|recall|leads
#   VPS=root@<ip> scripts/baja-datos-cliente.sh avisar  --cliente <id> --producto ... --operador <tu email>
#   VPS=root@<ip> scripts/baja-datos-cliente.sh borrar  --cliente <id> --producto ... --operador <tu email>             # modo de prueba
#   VPS=root@<ip> scripts/baja-datos-cliente.sh borrar  --cliente <id> --producto ... --operador <tu email> --confirmar # borra
#
# Opcional: SSH_KEY=<ruta de la clave> (si no, la de tu ~/.ssh/config).
# =============================================================================

set -eu

usage() {
  sed -n '11,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ $# -ge 1 ] || usage
ACTION="$1"
shift
case "$ACTION" in
  estado | avisar | borrar) ;;
  *) usage ;;
esac

CLIENT=""
PRODUCT=""
OPERATOR=""
CONFIRM="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --cliente) CLIENT="${2:-}"; shift 2 ;;
    --producto) PRODUCT="${2:-}"; shift 2 ;;
    --operador) OPERATOR="${2:-}"; shift 2 ;;
    --confirmar) CONFIRM="true"; shift ;;
    *) usage ;;
  esac
done

: "${VPS:?Falta VPS=usuario@host}"

# Los valores viajan dentro de un JSON y de una línea de ssh: solo se
# aceptan los caracteres que la ruta acepta, así no hay nada que escapar.
echo "$CLIENT" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || { echo "--cliente no válido" >&2; exit 2; }
case "$PRODUCT" in chatbot | recall | leads) ;; *) echo "--producto: chatbot, recall o leads" >&2; exit 2 ;; esac
if [ "$ACTION" != "estado" ]; then
  echo "$OPERATOR" | grep -Eq '^[A-Za-z0-9._@+-]{2,120}$' || { echo "--operador obligatorio (tu email)" >&2; exit 2; }
fi
if [ "$CONFIRM" = "true" ] && [ "$ACTION" != "borrar" ]; then
  echo "--confirmar solo vale con borrar" >&2
  exit 2
fi

BODY="{\"clientId\":\"$CLIENT\",\"product\":\"$PRODUCT\",\"action\":\"$ACTION\",\"operator\":\"$OPERATOR\",\"confirm\":$CONFIRM}"

if [ "$CONFIRM" = "true" ]; then
  printf 'Vas a BORRAR los datos de %s del cliente %s. No se puede deshacer. Escribe "borrar" para seguir: ' "$PRODUCT" "$CLIENT"
  read -r answer
  [ "$answer" = "borrar" ] || { echo "Cancelado."; exit 1; }
fi

set -- -o BatchMode=yes -o ConnectTimeout=15
[ -n "${SSH_KEY:-}" ] && set -- "$@" -i "$SSH_KEY"

printf '%s' "$BODY" | ssh "$@" "$VPS" "docker exec -i kairikos-portal-scheduler sh -c 'curl -sS --max-time 120 -w \"\\nHTTP %{http_code}\\n\" -H \"Authorization: Bearer \$CRON_SECRET\" -H \"content-type: application/json\" --data-binary @- \"\${SCHEDULER_TARGET_URL:-http://app:3000}/api/internal/client-data-exit\"'"
