import { ShortlinkService } from '../src/shortlinks.js';
import { route } from '../src/worker.js';

export function fresh() {
  const service = new ShortlinkService();
  return { service, call: (req) => route(req, service) };
}

export function postJSON(path, body) {
  return new Request(`https://shortlinks.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function get(path) {
  return new Request(`https://shortlinks.example${path}`, { method: 'GET' });
}
