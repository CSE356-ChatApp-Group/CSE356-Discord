/**
 * Migration entry for production builds: tsc emits dist/db/migrate.js, which loads
 * scripts/run-migrations.cjs (same implementation as `npm run migrate`).
 *
 * Local / CI: use `npm run migrate` → node scripts/run-migrations.cjs (no tsx/esbuild).
 */


const path = require('path');

require(path.join(__dirname, '..', '..', 'scripts', 'run-migrations.cjs'));
