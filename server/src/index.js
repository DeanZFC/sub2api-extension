import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { assertRuntimeConfig, loadConfig } from './config.js';
import { createApplication } from './app.js';

try {
  loadEnvFile('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const config = loadConfig();
assertRuntimeConfig(config);
const application = createApplication(config);
const server = createServer(application.handler);

server.listen(config.port, config.host, () => {
  application.startBackgroundJobs();
  console.log(`sub2api-extension server listening on ${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => {
    application.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
