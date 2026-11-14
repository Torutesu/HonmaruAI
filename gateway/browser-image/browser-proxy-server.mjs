import {createBrowserEgressProxy} from './browser-proxy.mjs';

const proxy=createBrowserEgressProxy({timeoutMs:20000});
await proxy.listen(3128);
console.log('Browser egress proxy is ready.');
const stop=async()=>{await proxy.close();process.exit(0);};
process.once('SIGTERM',stop);
process.once('SIGINT',stop);
