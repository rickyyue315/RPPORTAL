import { migrate } from './db/migrate.js';

migrate()
  .then(() => {
    console.log('[migrate] done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[migrate] failed', err);
    process.exit(1);
  });
