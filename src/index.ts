import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { RealmApiClient } from './realm-api.js';
import { StateStore } from './store.js';
import { RealmMonitor, type MonitorNotifier } from './monitor.js';
import { DiscordService } from './discord.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.dataDir);
  await store.load();
  const api = new RealmApiClient(config, logger);

  let discord: DiscordService;
  const notifier: MonitorNotifier = {
    notifyPresence: (change) => discord.notifyPresence(change),
    notifyRealmEvent: (event) => discord.notifyRealmEvent(event),
  };
  const monitor = new RealmMonitor(config, api, store, notifier, logger);
  discord = new DiscordService(config, api, monitor, store, logger);

  await discord.start();
  await monitor.start();
  logger.info('Bedrock Realms Discord Bot started', {
    realms: config.realms.map((realm) => realm.id),
    presenceSource: config.presenceSource,
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}; shutting down`);
    monitor.stop();
    await discord.stop();
    await store.flush();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Bot failed to start', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
