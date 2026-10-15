import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getDb, initDatabase } from './db.js';

interface ImportStats {
  totalRead: number;
  inserted: number;
  skipped: number;
  durationMs: number;
}

interface ProductRecord {
  barcode: string;
  name: string;
  price?: number | null;
  category?: string;
}

function detectDelimiter(firstLine: string): string {
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes(';') && (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length) {
    return ';';
  }
  return ',';
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' || char === "'") {
      if (inQuotes && line[i + 1] === char) {
        current += char;
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function cleanPrice(val: any): number | null {
  if (typeof val === 'number' && !isNaN(val) && val > 0) return val;
  if (!val || typeof val !== 'string') return null;
  const num = parseFloat(val.replace(',', '.').replace(/[^\d.]/g, ''));
  return !isNaN(num) && num > 0 ? num : null;
}

/**
 * Imports barcode catalog records from CSV, TSV, JSON, or JSONL files into SQLite.
 */
export async function importBarcodeCatalog(
  filePath: string,
  options: { clear?: boolean; limit?: number; batchSize?: number } = {}
): Promise<ImportStats> {
  const startTime = Date.now();
  await initDatabase();
  const db = getDb();

  const fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  if (options.clear) {
    console.log('[import] Clearing existing products_catalog table...');
    await db.execute('DELETE FROM products_catalog');
  }

  const batchSize = options.batchSize || 500;
  let batch: ProductRecord[] = [];
  let totalRead = 0;
  let inserted = 0;
  let skipped = 0;

  async function flushBatch() {
    if (batch.length === 0) return;
    const statements = batch.map((item) => ({
      sql: `INSERT INTO products_catalog (barcode, name, price, category, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(barcode) DO UPDATE SET
              name = excluded.name,
              price = COALESCE(excluded.price, products_catalog.price),
              updated_at = CURRENT_TIMESTAMP`,
      args: [item.barcode, item.name, item.price ?? null, item.category || 'shopping'],
    }));

    await db.batch(statements, 'write');
    inserted += batch.length;
    batch = [];
  }

  const ext = path.extname(fullPath).toLowerCase();

  if (ext === '.json') {
    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    let items: any[] = [];
    try {
      items = JSON.parse(rawContent);
    } catch {
      // Could be JSON lines
      items = rawContent
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }

    if (!Array.isArray(items)) {
      throw new Error('Expected JSON file to contain an array of objects or JSON lines.');
    }

    for (const raw of items) {
      if (options.limit && totalRead >= options.limit) break;
      totalRead++;

      const barcode = String(raw.barcode || raw.code || raw.ean || raw.ean13 || raw.gtin || '').trim();
      const name = String(raw.name || raw.title || raw.product_name || raw.description || '').trim();
      const price = cleanPrice(raw.price || raw.cost);

      if (!barcode || !name) {
        skipped++;
        continue;
      }

      batch.push({ barcode, name, price, category: raw.category });
      if (batch.length >= batchSize) {
        await flushBatch();
        if (inserted % 5000 === 0) {
          console.log(`[import] Processed ${inserted} items...`);
        }
      }
    }
    await flushBatch();
  } else {
    // Process CSV or TSV streaming line-by-line
    const fileStream = fs.createReadStream(fullPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let delimiter = ',';
    let barcodeIdx = -1;
    let nameIdx = -1;
    let priceIdx = -1;
    let categoryIdx = -1;
    let isFirstLine = true;

    for await (const line of rl) {
      if (options.limit && totalRead >= options.limit) break;
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFirstLine) {
        isFirstLine = false;
        delimiter = detectDelimiter(trimmed);
        const headers = parseCsvLine(trimmed, delimiter).map((h) => h.toLowerCase());

        barcodeIdx = headers.findIndex((h) => ['barcode', 'ean', 'code', 'gtin', 'upc', 'ean13', 'штрихкод'].includes(h));
        nameIdx = headers.findIndex((h) => ['name', 'title', 'product_name', 'product', 'item', 'description', 'label', 'товар', 'название'].includes(h));
        priceIdx = headers.findIndex((h) => ['price', 'cost', 'rub', 'rubles', 'цена', 'стоимость'].includes(h));
        categoryIdx = headers.findIndex((h) => ['category', 'cat', 'категория'].includes(h));

        // If no recognizable headers, assume col 0 is barcode, col 1 is name, col 2 is price
        if (barcodeIdx === -1 || nameIdx === -1) {
          barcodeIdx = 0;
          nameIdx = 1;
          priceIdx = headers.length > 2 ? 2 : -1;
          // Also process first line as data row if it contains digits
          if (/\d{6,}/.test(headers[0])) {
            totalRead++;
            const cols = parseCsvLine(trimmed, delimiter);
            const b = cols[0];
            const n = cols[1];
            if (b && n) {
              batch.push({ barcode: b, name: n, price: cleanPrice(cols[2]) });
            }
          }
        }
        continue;
      }

      totalRead++;
      const cols = parseCsvLine(trimmed, delimiter);
      const barcode = barcodeIdx >= 0 && cols[barcodeIdx] ? cols[barcodeIdx].replace(/\D/g, '') : '';
      const name = nameIdx >= 0 && cols[nameIdx] ? cols[nameIdx].trim() : '';
      const price = priceIdx >= 0 ? cleanPrice(cols[priceIdx]) : null;
      const category = categoryIdx >= 0 && cols[categoryIdx] ? cols[categoryIdx].trim() : undefined;

      if (!barcode || !name) {
        skipped++;
        continue;
      }

      batch.push({ barcode, name, price, category });
      if (batch.length >= batchSize) {
        await flushBatch();
        if (inserted % 5000 === 0) {
          console.log(`[import] Imported ${inserted} items...`);
        }
      }
    }
    await flushBatch();
  }

  const durationMs = Date.now() - startTime;
  console.log(`\n🎉 Import Complete!`);
  console.log(`   Total read: ${totalRead}`);
  console.log(`   Imported/Updated: ${inserted}`);
  console.log(`   Skipped invalid: ${skipped}`);
  console.log(`   Time taken: ${(durationMs / 1000).toFixed(2)}s\n`);

  return { totalRead, inserted, skipped, durationMs };
}

// CLI entry point
if (process.argv[1] && (process.argv[1].endsWith('import-barcodes.ts') || process.argv[1].endsWith('import-barcodes.js'))) {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    console.log(`
Usage: npm run import:barcodes <path-to-file> [--clear] [--limit=N]

Supported formats:
  - JSON (.json) array of { barcode, name, price?, category? }
  - CSV (.csv) with headers: barcode, name, price
  - TSV (.tsv) with tab-delimited columns

Examples:
  npm run import:barcodes assets/starter_catalog.json
  npm run import:barcodes dumps/russian_barcodes.csv --clear
  npm run import:barcodes dumps/large_dump.tsv --limit=50000
`);
    process.exit(1);
  }

  const clear = args.includes('--clear');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

  importBarcodeCatalog(filePath, { clear, limit })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Import failed:', err);
      process.exit(1);
    });
}
