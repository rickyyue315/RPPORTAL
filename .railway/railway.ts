import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

/**
 * Railway Infrastructure as Code for the NDRF Portal.
 *
 * This file is read by the Railway CLI (`railway config plan` /
 * `railway config apply`), not by the running application or during deploys.
 *
 * The web service uses the repository's Dockerfile. Railway injects PORT, so
 * PORT is intentionally not set here.
 *
 * For Hong Kong traffic, create the project in asia-southeast1 (Singapore).
 * To pin placement in code, replace `replicas: 1` with a region map such as
 * `replicas: { "asia-southeast1-eqsg3a": 1 }`.
 */
export default defineRailway(() => {
  const db = postgres("postgres");

  const web = service("web", {
    source: github("rickyyue315/RPPORTAL", { branch: "main" }),
    // The app only starts listening after migrations complete, so allow the
    // default 5-minute Railway healthcheck window.
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: 1,
    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,

      ADMIN_USERNAME: "admin",
      // Secrets are created as Railway variables and are never committed.
      // Set their values in the Railway dashboard before/after the first apply.
      ADMIN_PASSWORD: preserve(),
      PORTAL_SHARED_PASSWORD: preserve(),

      SESSION_TTL_HOURS: "8",
      LOGIN_LOCK_THRESHOLD: "5",
      LOGIN_LOCK_MINUTES: "15",
      TRUST_PROXY: "true",
      TRUST_PROXY_HOPS: "1",
      APP_TIMEZONE: "Asia/Hong_Kong",

      IP_RETENTION_DAYS: "365",
      MAX_UPLOAD_MB: "5",
      MAX_IMPORT_ROWS: "1000",
      EXPORT_FILE_RETENTION_DAYS: "90",
      AUDIT_RETENTION_DAYS: "730",
      LOGIN_ATTEMPT_RETENTION_DAYS: "90",
      IMPORT_BATCH_RETENTION_DAYS: "730",
      EXPORT_BATCH_RETENTION_DAYS: "730",

      RETURN_SCHEDULE_PATH: "./return-schedule.json",
      RETURN_ENFORCEMENT_START: "2026-08-01",
      CORS_ORIGINS: "",

      PUBLIC_WRITE_SUSPENSION_ENABLED: "true",
      PUBLIC_WRITE_SUSPENSION_AT: "2026-08-11T23:59:59+08:00",
      NORMAL_NDRF_PORTAL_ENABLED: "true",
      NDRF_REJECT_COOLDOWN_HOURS: "720",
      NDRF_AUTO_APPROVE_ENABLED: "true",
      NDRF_AUTO_APPROVE_DAYS: "7",

      // Wait for PostgreSQL on first boot instead of crash-looping.
      DB_STARTUP_RETRIES: "20",
      DB_STARTUP_RETRY_MS: "2000",
      // The app closes within this budget; Railway drains the old deployment
      // for 30s and overlaps it with the new one for 10s.
      SHUTDOWN_TIMEOUT_MS: "25000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: "10",
    },
  });

  return project("NDRF Portal", {
    resources: [db, web],
  });
});
