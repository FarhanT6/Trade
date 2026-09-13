import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './app.js';
import { attachPersistence } from './persistence.js';

const cfg = loadConfig();
const rt = await createRuntime(cfg);
const app = buildApp(rt);
attachPersistence(rt, cfg).catch((e) => console.error('[persistence] disabled:', (e as Error).message));
rt.start();
app.listen({ port: cfg.port, host: '0.0.0.0' }).then(() => {
  console.log(`[meme-intel] api listening on :${cfg.port} (mode=${cfg.mode}${cfg.mode === 'simulation' ? `, speed=${cfg.simSpeed}x` : ''})`);
});
process.on('SIGINT', () => {
  rt.stop();
  app.close().then(() => process.exit(0));
});
