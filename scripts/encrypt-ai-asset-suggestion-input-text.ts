// One-shot migration: encrypt `ai_asset_suggestion.inputText` column
// in place. Idempotent — skips rows where the column already looks
// encrypted.
//
// Confidentiality TSC. Run AFTER:
//   1. FIELD_ENCRYPTION_KEY is set in the target environment
//   2. The extension is deployed with AiAssetSuggestion.inputText in
//      ENCRYPTED_COLUMNS
//
// Usage:
//   FIELD_ENCRYPTION_KEY=$(grep FIELD_ .env.local | cut -d= -f2) \
//     npx tsx scripts/encrypt-ai-asset-suggestion-input-text.ts
//
// Paginated by id ASC. Conservative batch size because inputText can
// be a multi-paragraph blob.

import { PrismaClient } from "@prisma/client";
import {
  encryptField,
  looksEncrypted,
} from "../src/lib/soc2/field-encryption";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  // Raw client — bypass the extension so we write ciphertext directly.
  const prisma = new PrismaClient();
  console.log("[migrate] starting backfill of confidential column");

  let total = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedEmpty = 0;
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.aiAssetSuggestion.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
      select: { id: true, inputText: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      lastId = row.id;
      if (!row.inputText) {
        skippedEmpty++;
        continue;
      }
      if (looksEncrypted(row.inputText)) {
        skippedAlready++;
        continue;
      }
      const ct = encryptField(row.inputText);
      if (!ct) {
        skippedEmpty++;
        continue;
      }
      await prisma.aiAssetSuggestion.updateMany({
        where: { id: row.id, inputText: row.inputText },
        data: { inputText: ct },
      });
      encrypted++;
    }
    if (total % 500 === 0) {
      console.log(
        `[migrate] scanned ${total} rows; ${encrypted} encrypted, ${skippedAlready} already done, ${skippedEmpty} empty`
      );
    }
  }

  console.log(
    `[migrate] complete. total=${total} encrypted=${encrypted} skipped_already=${skippedAlready} skipped_empty=${skippedEmpty}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
