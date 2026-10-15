import { initDatabase, clearProductCatalog } from './db.js';

async function main() {
  await initDatabase();
  const withoutReseed = process.argv.includes('--empty');
  const reseed = !withoutReseed;

  const result = await clearProductCatalog(reseed);
  console.log(`\n🧹 Local product catalog cleaned:`);
  console.log(`   Deleted cached records: ${result.deleted}`);
  if (reseed) {
    console.log(`   Reseeded starter products: ${result.reseeded}`);
  } else {
    console.log(`   Catalog left completely empty.`);
  }
  console.log('✅ Done.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to clean catalog:', err);
  process.exit(1);
});
