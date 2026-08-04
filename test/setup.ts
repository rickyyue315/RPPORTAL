import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.test'), quiet: true });

const defaults: Record<string, string> = {
  DATABASE_URL: 'postgres://ndrf:ndrf@localhost:5432/ndrf',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'test-password',
  NODE_ENV: 'test',
};

for (const [k, v] of Object.entries(defaults)) {
  if (!process.env[k]) process.env[k] = v;
}
