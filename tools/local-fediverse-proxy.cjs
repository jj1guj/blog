'use strict';

// ローカル連合確認用の HTTP プロキシです（docs/local-federation.md を参照）。
// 127.0.0.1 だけで待ち受け、http://BLOG_DOMAIN への通信だけを Caddy の CADDY_PORT へ転送します。
// ブラウザーの通常の HTTP プロキシ要求と、Misskey などが送る CONNECT の両方を扱います。

const http = require('node:http');
const net = require('node:net');

function readPort(name) {
  const port = Number(process.env[name]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port number`);
  }
  return port;
}

const domain = process.env.BLOG_DOMAIN;
const caddyPort = readPort('CADDY_PORT');
const proxyPort = readPort('LOCAL_PROXY_PORT');
const blogUrl = new URL(process.env.BLOG_URL);

if (
  blogUrl.protocol !== 'http:' ||
  !domain ||
  blogUrl.host !== domain ||
  blogUrl.username ||
  blogUrl.password ||
  blogUrl.pathname !== '/' ||
  blogUrl.search ||
  blogUrl.hash
) {
  throw new Error('BLOG_URL must be http://BLOG_DOMAIN without a port');
}

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    response.writeHead(400).end();
    return;
  }

  if (
    url.origin !== blogUrl.origin ||
    url.username ||
    url.password
  ) {
    response.writeHead(403).end();
    return;
  }

  const headers = { ...request.headers, host: domain };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: caddyPort,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers,
  }, (upstreamResponse) => {
    if (upstreamResponse.statusCode == null) {
      console.error('Caddy response has no status code');
      response.writeHead(502).end();
      upstreamResponse.resume();
      return;
    }
    response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', (error) => {
    console.error(`HTTP request to Caddy failed: ${error.message}`);
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
});

server.on('connect', (request, client, head) => {
  if (request.url !== `${domain}:80`) {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  const upstream = net.createConnection({ host: '127.0.0.1', port: caddyPort });
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on('error', (error) => {
    console.error(`CONNECT tunnel to Caddy failed: ${error.message}`);
    client.destroy();
  });
  client.on('error', (error) => {
    console.error(`Client connection failed: ${error.message}`);
    upstream.destroy();
  });
});

server.on('error', (error) => {
  console.error(`Failed to start proxy: ${error.message}`);
  process.exitCode = 1;
});

server.listen(proxyPort, '127.0.0.1', () => {
  console.log(`Local proxy listening on 127.0.0.1:${proxyPort}`);
});
