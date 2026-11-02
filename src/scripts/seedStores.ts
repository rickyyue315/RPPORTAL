import { syncStoresFromFile } from '../services/stores.js';
import { config } from '../config.js';

syncStoresFromFile(config.storesCsvPath)
  .then((result) => {
    console.log(
      `[seed] imported ${result.count} stores` +
        (result.added.length ? ` (new: ${result.added.join(', ')})` : '') +
        (result.removed.length ? ` (missing from file: ${result.removed.join(', ')})` : ''),
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
