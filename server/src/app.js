import { openDatabase } from './db.js';
import { Sub2ApiClient } from './sub2api-client.js';
import { SessionStore } from './sessions.js';
import { SyncService } from './sync.js';
import { LotteryService } from './lotteries.js';
import { OutboxService } from './outbox.js';
import { GroupEntitlementService } from './group-entitlements.js';
import { ActivityService } from './activities.js';
import { registerRoutes, Router } from './http.js';
import { RateLimiter } from './rate-limiter.js';
import { RequestLogService } from './request-logs.js';

export function createApplication(config, options = {}) {
  const db = options.db || openDatabase(config.databaseUrl || config.dbPath);
  const client = options.client || new Sub2ApiClient(config, options.fetchImpl);
  const sessionStore = new SessionStore(db, config);
  const syncService = new SyncService(db, client, config);
  const lotteries = new LotteryService(db, syncService, config);
  const outbox = new OutboxService(db, client, config);
  const groupEntitlements = new GroupEntitlementService(db, client, syncService, config);
  const activities = new ActivityService(db, client, syncService, lotteries, groupEntitlements, config);
  const rateLimiter = new RateLimiter(config);
  const requestLogs = new RequestLogService(db, config);
  const services = {
    config, db, client, sessionStore, syncService, lotteries, outbox, groupEntitlements,
    activities, rateLimiter, requestLogs
  };
  const router = new Router({ config, sessionStore, syncService, rateLimiter, requestLogs });
  registerRoutes(router, services);
  let cleanupTimer = null;

  function startBackgroundJobs() {
    outbox.start();
    lotteries.startAutoDraws();
    groupEntitlements.startExpiryRevocations();
    if (!cleanupTimer) {
      cleanupTimer = setInterval(() => {
        try {
          sessionStore.cleanup();
          requestLogs.cleanup();
        } catch { /* cleanup retries on the next interval */ }
      }, Math.min(config.sessionTtlMs, 3_600_000));
      cleanupTimer.unref?.();
    }
  }

  function close() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    lotteries.stopAutoDraws();
    groupEntitlements.stopExpiryRevocations();
    outbox.stop();
    requestLogs.close();
    db.close();
  }

  return { handler: router.handler(), services, startBackgroundJobs, close };
}
