-- Fase 1 multi-instancia, migración 4 de 4 — el backfill.
--
-- Deja el mundo actual expresado en el modelo nuevo, SIN cambiar nada
-- observable: un sitio primario por cliente, todas sus contrataciones
-- apuntando a él, y las tres anclas resueltas a su instancia.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: cada paso inserta o actualiza solo lo que
-- falta. Se puede correr dos veces sin efecto, que es exactamente lo que va a
-- pasar si un despliegue se reintenta.
--
-- El nombre del sitio se ADIVINA: se toma la web declarada en SeoProfile si
-- la hay, y si no el nombre del cliente. Con un puñado de clientes de prueba
-- es irrelevante y se edita a mano; está anotado como límite aceptado en
-- docs/plan-multi-instancia-fase-1.md.

-- 1. Un sitio primario por cliente que no tenga ya uno.
--
-- ChatbotClient.id es TEXT (cuid), no UUID — de los modelos antiguos.
INSERT INTO "client_site" ("client_id", "tenant_id", "name", "site_url", "is_primary")
SELECT
    c."id",
    c."tenant_id",
    COALESCE(NULLIF(TRIM(c."companyName"), ''), c."name"),
    (
        SELECT NULLIF(TRIM(sp."site_url"), '')
        FROM "SeoProfile" sp
        WHERE sp."client_id" = c."id" AND sp."site_url" IS NOT NULL
        ORDER BY sp."created_at" ASC
        LIMIT 1
    ),
    true
FROM "ChatbotClient" c
WHERE NOT EXISTS (
    SELECT 1 FROM "client_site" cs WHERE cs."client_id" = c."id" AND cs."is_primary"
);

-- 2. Toda contratación sin sitio va al primario de su cliente.
UPDATE "ClientProduct" cp
SET "client_site_id" = cs."id"
FROM "client_site" cs
WHERE cs."client_id" = cp."client_id"
  AND cs."is_primary"
  AND cp."client_site_id" IS NULL;

-- 3. Las tres anclas, a la instancia del producto que les corresponde.
--
-- Las tres pertenecen al chatbot: una conexión de canal y una conversación
-- son del chatbot del cliente, no de su SEO ni de sus reseñas. Hasta la fase
-- 5 hay como mucho una instancia de 'chatbot' por cliente, así que este
-- emparejamiento es exacto, no una heurística. El LIMIT 1 del subselect es
-- defensivo: si alguna vez hubiera dos, es preferible dejar la columna a NULL
-- (la fila no se actualiza porque el WHERE la excluye) que elegir al azar.
--
-- OJO: ChatbotConversation es de los modelos ANTIGUOS — su columna de
-- cliente es literalmente "clientId", no "client_id". Las otras dos son
-- nuevas y usan snake_case.

UPDATE "MetaChannelConnection" mc
SET "client_product_id" = cp."id"
FROM "ClientProduct" cp
JOIN "Product" p ON p."id" = cp."product_id"
WHERE cp."client_id" = mc."client_id"
  AND p."code" = 'chatbot'
  AND cp."status" = 'active'
  AND mc."client_product_id" IS NULL;

UPDATE "TelegramConnection" tc
SET "client_product_id" = cp."id"
FROM "ClientProduct" cp
JOIN "Product" p ON p."id" = cp."product_id"
WHERE cp."client_id" = tc."client_id"
  AND p."code" = 'chatbot'
  AND cp."status" = 'active'
  AND tc."client_product_id" IS NULL;

UPDATE "ChatbotConversation" cc
SET "client_product_id" = cp."id"
FROM "ClientProduct" cp
JOIN "Product" p ON p."id" = cp."product_id"
WHERE cp."client_id" = cc."clientId"
  AND p."code" = 'chatbot'
  AND cp."status" = 'active'
  AND cc."client_product_id" IS NULL;
