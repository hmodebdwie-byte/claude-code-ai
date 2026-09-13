"use strict";
/**
 * Synthetic local fixtures for the workbench database.
 * Creates (once): a funded demo trader, 20 local NPC traders, and the NPC simulator "desired ON" flag.
 * Refuses to run against anything but the local 127.0.0.1 Postgres/Redis with the reserved test accounts.
 * Run from the backend repo root after `seed:admin`:  node ../tools/fixtures.cjs
 */
const path = require("node:path");
const FIXTURE_KEY = "ticktrade_local_fixtures_v1";
const DEMO_EMAIL = "local-demo@ticktrade.test";
const ADMIN_EMAIL = "local-admin@ticktrade.test";
const NPC_ACTIVE_KEY = "ticktrade:npc:simulator:active";
const FUNDS = "100000.00";
const NPC_NAMES = Array.from({ length: 20 }, (_, i) => "LocalLabNPC" + String(i + 1).padStart(2, "0"));

function checkEnvironment(env) {
  if (env.TICKTRADE_LOCAL_FIXTURES !== "1" || env.NODE_ENV !== "development")
    throw new Error("Synthetic fixtures require TICKTRADE_LOCAL_FIXTURES=1 and NODE_ENV=development.");
  const db = new URL(env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL);
  const localHost = (h) => ["127.0.0.1", "localhost"].includes(h);
  if (!localHost(db.hostname) || db.pathname !== "/ticktrade_local" || !localHost(redis.hostname))
    throw new Error("Synthetic fixtures refuse non-local database or Redis destinations.");
  if (env.SEED_ADMIN_EMAIL !== ADMIN_EMAIL || (env.SEED_DEMO_EMAIL && env.SEED_DEMO_EMAIL !== DEMO_EMAIL))
    throw new Error("Synthetic fixtures use reserved local test accounts only.");
  if (typeof env.SEED_DEMO_PASSWORD !== "string" || env.SEED_DEMO_PASSWORD.length < 12)
    throw new Error("SEED_DEMO_PASSWORD must be a random string of at least 12 characters.");
}

function req(name) {
  const root = process.cwd();
  for (const base of [root, path.join(root, "apps/api"), path.join(root, "packages/shared")]) {
    try { return require(require.resolve(name, { paths: [base] })); } catch (_) { /* next */ }
  }
  throw new Error(`cannot resolve ${name} from ${root} — run pnpm install first`);
}

async function main() {
  checkEnvironment(process.env);
  const { PrismaClient } = req("@prisma/client");
  const bcrypt = req("bcryptjs");
  const Redis = req("ioredis");
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const passwordHash = await bcrypt.hash(process.env.SEED_DEMO_PASSWORD, 10);
    const summary = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(771921, 440112)`;
      const marker = await tx.systemSetting.findUnique({ where: { settingKey: FIXTURE_KEY } });
      const admin = await tx.user.findUnique({ where: { email: ADMIN_EMAIL } });
      if (!admin || admin.role !== "ADMIN") throw new Error("Run seed:admin first (reserved local administrator missing).");
      await tx.user.update({ where: { id: admin.id }, data: { emailVerified: true, emailVerifiedAt: admin.emailVerifiedAt || new Date() } });
      if (marker) {
        const existing = await tx.user.findUnique({ where: { email: DEMO_EMAIL } });
        const npcCount = await tx.npcTrader.count({ where: { username: { in: NPC_NAMES } } });
        return { created_user: false, created_npcs: 0, demo_account_present: !!existing, npc_count: npcCount };
      }
      if ((await tx.user.findUnique({ where: { email: DEMO_EMAIL } })) || (await tx.npcTrader.count({ where: { username: { in: NPC_NAMES } } })))
        throw new Error("Reserved fixture accounts already exist without their initialization record; nothing was reset.");
      const ts = new Date();
      const user = await tx.user.create({ data: { email: DEMO_EMAIL, password: passwordHash, name: "Local Demo Trader (synthetic)", role: "USER",
        emailVerified: true, emailVerifiedAt: ts, isGuest: false, isRpc: false, balance: FUNDS, kycStatus: "VERIFIED", kycVerifiedAt: ts } });
      await tx.ledger.create({ data: { userId: user.id, type: "deposit", amount: FUNDS, balanceAfter: FUNDS,
        description: "Synthetic local starting funds. No real payment.", referenceId: "local-fixtures:v1:demo-funds" } });
      const npcIds = [];
      for (let i = 0; i < NPC_NAMES.length; i++) {
        const npc = await tx.npcTrader.create({ data: { username: NPC_NAMES[i], email: `local-npc${i + 1}@ticktrade.test`, winRate: "0.00", streak: 0, xp: 0, level: 1,
          aggressiveness: 35 + (i * 7) % 50, volumeProfile: 30 + (i * 11) % 60, isActive: true, rotationPaused: false, balance: FUNDS, totalDeposit: FUNDS, createdAt: ts, updatedAt: ts } });
        await tx.npcFundingEvent.create({ data: { npcId: npc.id, amount: FUNDS, source: "local_fixture" } });
        npcIds.push(npc.id);
      }
      await tx.systemSetting.create({ data: { settingKey: FIXTURE_KEY, settingValue: JSON.stringify({ version: 1, demoUserId: user.id, npcIds }),
        description: "Synthetic local fixture initialization marker." } });
      return { created_user: true, created_npcs: NPC_NAMES.length, demo_account_present: true, npc_count: NPC_NAMES.length };
    }, { maxWait: 10000, timeout: 30000 });
    const initialized = await redis.set(NPC_ACTIVE_KEY, "1", "NX");
    console.log(JSON.stringify({ fixture_version: 1, ...summary, npc_desired_state_initialized: initialized === "OK", demo_email: DEMO_EMAIL }));
  } finally {
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
  }
}
main().catch((e) => { console.error("[fixtures] " + (e && e.message ? e.message : e)); process.exit(1); });
