-- CreateTable
CREATE TABLE "ChatbotClient" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'starter',
    "stripeCustomerId" TEXT,
    "goLiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotClientUser" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "nextAuthEmail" TEXT NOT NULL,

    CONSTRAINT "ChatbotClientUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotActivity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "ChatbotActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotConversation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "outcome" TEXT,
    "transcript" JSONB,

    CONSTRAINT "ChatbotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatbotClient_email_key" ON "ChatbotClient"("email");

-- CreateIndex
CREATE INDEX "ChatbotClient_stripeCustomerId_idx" ON "ChatbotClient"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "ChatbotClient_tier_idx" ON "ChatbotClient"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "ChatbotClientUser_nextAuthEmail_key" ON "ChatbotClientUser"("nextAuthEmail");

-- CreateIndex
CREATE INDEX "ChatbotClientUser_clientId_idx" ON "ChatbotClientUser"("clientId");

-- CreateIndex
CREATE INDEX "ChatbotActivity_clientId_completedAt_idx" ON "ChatbotActivity"("clientId", "completedAt");

-- CreateIndex
CREATE INDEX "ChatbotConversation_clientId_startedAt_idx" ON "ChatbotConversation"("clientId", "startedAt");

-- CreateIndex
CREATE INDEX "ChatbotConversation_clientId_outcome_idx" ON "ChatbotConversation"("clientId", "outcome");

-- AddForeignKey
ALTER TABLE "ChatbotClientUser" ADD CONSTRAINT "ChatbotClientUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatbotActivity" ADD CONSTRAINT "ChatbotActivity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatbotConversation" ADD CONSTRAINT "ChatbotConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
