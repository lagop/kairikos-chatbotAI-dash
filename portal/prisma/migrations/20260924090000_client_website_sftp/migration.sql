-- Producto Web, Fase 1 · El sitio de un cliente y su publicación por SFTP.
--
-- Tres tablas: el sitio, su auditoría (append-only, como todo lo que escribe
-- un cliente) y la credencial de SFTP cifrada. Nombres en PascalCase y
-- columnas snake_case por @map, igual que el resto de modelos nuevos.

CREATE TABLE IF NOT EXISTS "ClientWebsite" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "business_name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "primary_type" TEXT,
    "theme_key" TEXT NOT NULL,
    "copy" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "form_token" TEXT NOT NULL,
    "publish_target" TEXT NOT NULL DEFAULT 'sftp',
    "slug" TEXT,
    "custom_domain" TEXT,
    "last_published_at" TIMESTAMP(3),
    "last_publish_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientWebsite_pkey" PRIMARY KEY ("id")
);

-- Una fila por UNIDAD contratada, no por cliente: 'web' es multi-instancia
-- porque la segunda web cuesta dinero cada mes.
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsite_client_product_id_key"
    ON "ClientWebsite"("client_product_id");
-- El testigo del formulario de la web publicada: aleatorio y público por
-- definición, porque viaja en el HTML que vive en el servidor del cliente.
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsite_form_token_key"
    ON "ClientWebsite"("form_token");
CREATE INDEX IF NOT EXISTS "ClientWebsite_client_id_idx" ON "ClientWebsite"("client_id");
CREATE INDEX IF NOT EXISTS "ClientWebsite_tenant_id_idx" ON "ClientWebsite"("tenant_id");

CREATE TABLE IF NOT EXISTS "ClientWebsiteAudit" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientWebsiteAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ClientWebsiteAudit_website_id_changed_at_idx"
    ON "ClientWebsiteAudit"("website_id", "changed_at");
CREATE INDEX IF NOT EXISTS "ClientWebsiteAudit_client_id_changed_at_idx"
    ON "ClientWebsiteAudit"("client_id", "changed_at");
CREATE INDEX IF NOT EXISTS "ClientWebsiteAudit_tenant_id_idx" ON "ClientWebsiteAudit"("tenant_id");

-- La contraseña va cifrada en tres columnas (ciphertext, iv, tag), AES-256-GCM,
-- igual que el resto de credenciales del portal y con su propia clave.
CREATE TABLE IF NOT EXISTS "WebsitePublishCredential" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "remote_path" TEXT NOT NULL,
    "password_ciphertext" BYTEA NOT NULL,
    "password_iv" BYTEA NOT NULL,
    "password_tag" BYTEA NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsitePublishCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebsitePublishCredential_website_id_key"
    ON "WebsitePublishCredential"("website_id");

ALTER TABLE "ClientWebsite"
    ADD CONSTRAINT "ClientWebsite_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientWebsite"
    ADD CONSTRAINT "ClientWebsite_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientWebsite"
    ADD CONSTRAINT "ClientWebsite_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ClientWebsiteAudit"
    ADD CONSTRAINT "ClientWebsiteAudit_website_id_fkey"
    FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientWebsiteAudit"
    ADD CONSTRAINT "ClientWebsiteAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientWebsiteAudit"
    ADD CONSTRAINT "ClientWebsiteAudit_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WebsitePublishCredential"
    ADD CONSTRAINT "WebsitePublishCredential_website_id_fkey"
    FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Alojamiento propio: slug en la URL y dominio del cliente apuntando aquí.
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsite_slug_key" ON "ClientWebsite"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsite_custom_domain_key" ON "ClientWebsite"("custom_domain");

-- Cada publicación guarda su contenido: volver atrás es restaurar una versión
-- y volver a publicar, no deshacer nada.
CREATE TABLE IF NOT EXISTS "ClientWebsiteRelease" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "copy" JSONB NOT NULL,
    "theme_key" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,

    CONSTRAINT "ClientWebsiteRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsiteRelease_website_id_version_key"
    ON "ClientWebsiteRelease"("website_id", "version");
CREATE INDEX IF NOT EXISTS "ClientWebsiteRelease_website_id_published_at_idx"
    ON "ClientWebsiteRelease"("website_id", "published_at");
ALTER TABLE "ClientWebsiteRelease"
    ADD CONSTRAINT "ClientWebsiteRelease_website_id_fkey"
    FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los archivos, cuando el sitio se aloja en nuestra infraestructura.
CREATE TABLE IF NOT EXISTS "ClientWebsiteFile" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientWebsiteFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsiteFile_website_id_path_key"
    ON "ClientWebsiteFile"("website_id", "path");
ALTER TABLE "ClientWebsiteFile"
    ADD CONSTRAINT "ClientWebsiteFile_website_id_fkey"
    FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
