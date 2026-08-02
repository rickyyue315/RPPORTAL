import { seedStoresFromFile } from '../services/stores.js';
import { config } from '../config.js';

seedStoresFromFile(config.storesCsvPath)
  .then((count) => {
    console.log(`[seed] imported ${count} stores`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
