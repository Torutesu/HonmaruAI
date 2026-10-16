import { gatewayClient, serve } from './client.mjs';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const call = gatewayClient(process.env.HONMARU_API_URL || '', process.env.HONMARU_GATEWAY_TOKEN);
  console.log('Honmaru execution node started. One isolated job at a time; no inbound port.');
  await serve(call, { signal: controller.signal, once: process.argv.includes('--once'), onError: status => console.error(`Execution polling failed (${status}); retrying.`) });
} catch (error) { console.error(error.message); process.exitCode = 1; }
