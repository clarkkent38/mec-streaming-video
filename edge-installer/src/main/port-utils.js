'use strict';
const net = require('net');

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(startFrom = 5001) {
  let port = startFrom;
  while (port < 65535) {
    if (await isPortFree(port)) return port;
    port++;
  }
  throw new Error('No free port found above ' + startFrom);
}

module.exports = { isPortFree, findFreePort };
