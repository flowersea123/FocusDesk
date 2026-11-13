import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

type Interfaces = ReturnType<typeof networkInterfaces>;
const API_PATH = '/api/v1/daily-overview';

function isUsable(address: string) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254);
}

function rank(name: string, address: string) {
  const [a, b] = address.split('.').map(Number);
  const privateAddress = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const virtual = /vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|vpn|tailscale|zerotier|loopback|tunnel|\btun\d|\btap/i.test(name);
  return (virtual ? 10 : 0) + (privateAddress ? 0 : 1);
}

/** A fresh address snapshot, not device discovery or proof of LAN reachability. */
export function getServerInfo(listenHost: string, port: number, interfaces: Interfaces = networkInterfaces()) {
  const loopback = listenHost.startsWith('127.');
  const localHost = listenHost === '0.0.0.0' ? '127.0.0.1' : loopback ? listenHost : null;
  const seen = new Set<string>();
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter(entry => !entry.internal && entry.family === 'IPv4' && isUsable(entry.address))
      .map(entry => ({ interface: name, address: entry.address })))
    .filter(entry => {
      if (loopback || (listenHost !== '0.0.0.0' && entry.address !== listenHost) || seen.has(entry.address)) return false;
      seen.add(entry.address); return true;
    })
    .sort((a, b) => rank(a.interface, a.address) - rank(b.interface, b.address) || a.interface.localeCompare(b.interface, 'en') || a.address.localeCompare(b.address, 'en', { numeric: true }))
    .map(entry => ({ ...entry, dashboard_url: `http://${entry.address}:${port}/`, device_api_url: `http://${entry.address}:${port}${API_PATH}` }));
  return {
    service: 'FocusDesk', port, listen_host: listenHost,
    local_url: localHost ? `http://${localHost}:${port}/` : null,
    connection_url: localHost ? `http://${localHost}:${port}/connect` : null,
    addresses,
  };
}
