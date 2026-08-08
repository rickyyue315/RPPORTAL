/**
 * Ops helper: verifies that the return schedule covers the current year and
 * prints the enforceable windows. Run with: npm run schedule:check
 */
process.env.DATABASE_URL ??= 'postgres://local:local@localhost:5432/local';

const { config } = await import('../config.js');
const { RETURN_SCHEDULE, RETURN_WINDOWS, getActiveReturnWindow } = await import('../lib/returnSchedule.js');

const currentYear = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
}).format(new Date());

console.log(`Return schedule: ${config.returnSchedulePath}`);
console.log(`Enforcement start: ${config.returnEnforcementStart}`);
console.log(`Configured windows: ${RETURN_SCHEDULE.length} (${RETURN_SCHEDULE[0]?.key} - ${RETURN_SCHEDULE.at(-1)?.key})`);
console.log(`Current year (${currentYear}) windows: ${RETURN_SCHEDULE.filter((w) => w.key.startsWith(`${currentYear}-`)).length}`);

const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const active = getActiveReturnWindow(today);
console.log(`Today (${today}): ${active ? `inside window ${active.key}` : 'no active application window'}`);
console.log(`Enforceable windows: ${RETURN_WINDOWS.map((w) => w.key).join(', ') || '(none)'}`);

const missingCurrentYear = !RETURN_SCHEDULE.some((w) => w.key.startsWith(`${currentYear}-`));
if (missingCurrentYear) {
  console.error(`\n[WARN] No windows configured for ${currentYear}. The application will refuse to start after the last window of ${RETURN_SCHEDULE.at(-1)?.key ?? 'the schedule'} ends.`);
  process.exitCode = 1;
}
