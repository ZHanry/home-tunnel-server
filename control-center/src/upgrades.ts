import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
const dispatchers = new WeakMap<Server, Map<string, UpgradeHandler>>();
export function registerUpgrade(server: Server, path: string, handler: UpgradeHandler) {
  let routes = dispatchers.get(server);
  if (!routes) {
    routes = new Map();
    dispatchers.set(server, routes);
    const registry = routes;
    server.on("upgrade", (request, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://internal").pathname;
      } catch {
        socket.destroy();
        return;
      }
      const target = registry.get(pathname);
      if (target) target(request, socket, head);
      else {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
  }
  if (routes.has(path)) throw new Error(`Duplicate WebSocket path: ${path}`);
  routes.set(path, handler);
  return () => routes.delete(path);
}
