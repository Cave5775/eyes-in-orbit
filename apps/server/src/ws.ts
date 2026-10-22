import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@eio/core';
import type { Hub } from './hub';

const PING_MS = 25_000;
const HEALTH_THROTTLE_MS = 2000;
const MAX_TOPICS = 16;

/** `/stream`: JSON ServerMessage out, ClientMessage in (subscribe/unsubscribe topics, currently `iss`). */
export async function registerStream(app: FastifyInstance, hub: Hub): Promise<void> {
  await app.register(websocket);

  const clients = new Map<WebSocket, { topics: Set<string>; alive: boolean }>();
  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage, topic?: string) => {
    const text = JSON.stringify(msg);
    for (const [ws, c] of clients) if (ws.readyState === ws.OPEN && (!topic || c.topics.has(topic))) ws.send(text);
  };

  hub.on('entities.changed', ({ ids, at }: { ids: string[]; at: number }) => broadcast({ type: 'entities.changed', ids, at }));
  hub.on('launches', (launches) => broadcast({ type: 'launches', launches }));
  hub.on('news', (articles) => broadcast({ type: 'news', articles }));
  hub.on('dsn', (snapshot) => broadcast({ type: 'dsn', snapshot }));
  hub.on('iss.fix', (fix) => broadcast({ type: 'iss.fix', fix }, 'iss'));
  hub.on('iss.telemetry', (points) => broadcast({ type: 'iss.telemetry', points }, 'iss'));
  hub.on('iss.arrays', (arrays) => broadcast({ type: 'iss.arrays', arrays }, 'iss'));

  let healthTimer: NodeJS.Timeout | undefined;
  hub.on('health', () => {
    healthTimer ??= setTimeout(() => {
      healthTimer = undefined;
      broadcast({ type: 'health', connectors: hub.healthList() });
    }, HEALTH_THROTTLE_MS);
  });

  const pinger = setInterval(() => {
    for (const [ws, c] of clients) {
      if (!c.alive) ws.terminate();
      else {
        c.alive = false;
        ws.ping();
      }
    }
  }, PING_MS);
  app.addHook('onClose', async () => {
    clearInterval(pinger);
    clearTimeout(healthTimer);
    for (const ws of clients.keys()) ws.terminate();
  });

  app.get('/stream', { websocket: true }, (ws) => {
    const client = { topics: new Set<string>(), alive: true };
    clients.set(ws, client);
    ws.on('pong', () => (client.alive = true));
    ws.on('error', () => ws.terminate());

    send(ws, { type: 'hello', serverTime: Date.now(), entityCount: hub.graph.size });
    send(ws, { type: 'health', connectors: hub.healthList() });
    if (hub.launches.length) send(ws, { type: 'launches', launches: hub.launches });
    if (hub.articles.length) send(ws, { type: 'news', articles: hub.articles });
    if (hub.dsn.links.length) send(ws, { type: 'dsn', snapshot: hub.dsn });

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg?.topics)) return;
      for (const topic of msg.topics.filter((t) => typeof t === 'string' && t.length <= 64)) {
        if (msg.op === 'subscribe' && !client.topics.has(topic) && client.topics.size < MAX_TOPICS) {
          client.topics.add(topic);
          hub.subscribe(topic);
          if (topic === 'iss') {
            if (hub.issFix) send(ws, { type: 'iss.fix', fix: hub.issFix });
            if (hub.telemetry.size) send(ws, { type: 'iss.telemetry', points: [...hub.telemetry.values()] });
            if (hub.issArrays) send(ws, { type: 'iss.arrays', arrays: hub.issArrays });
          }
        } else if (msg.op === 'unsubscribe' && client.topics.delete(topic)) hub.unsubscribe(topic);
      }
    });

    ws.on('close', () => {
      for (const topic of client.topics) hub.unsubscribe(topic);
      clients.delete(ws);
    });
  });
}
