import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'firmware/experiments/focusdesk_provisioning_poc');
const configuration = path.join(directory, 'private_config.h');
const cardDirectory = path.join(root, '.cache/p1-local');
const card = path.join(cardDirectory, 'connection.txt');
try {
  await access(configuration);
  console.log('Local PoC configuration already exists; kept unchanged.');
  console.log(`Read the existing local connection card: ${card}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  if (alphabet.length !== 32) throw Error('Invalid Base32 alphabet');
  const secret = Array.from(randomBytes(16), byte => alphabet[byte & 31]).join('');
  await mkdir(directory, { recursive: true });
  await mkdir(cardDirectory, { recursive: true });
  // Exclusive writes preserve any existing local configuration and connection card.
  await writeFile(card, `FocusDesk independent provisioning PoC\r\n\r\nSSID: FocusDesk-Setup-<device suffix>\r\nWPA2 password: ${secret}\r\nBrowser: http://192.168.4.1\r\n\r\nThis card is private. Do not share it or include it in test logs.\r\nThe device's SSID suffix is visible in your phone's Wi-Fi list.\r\nThe setup window lasts 10 minutes; press RST to reopen it.\r\nRouter credentials stay in RAM and are lost after reset.\r\n`, { flag: 'wx' });
  try {
    await writeFile(configuration, `// Local test secret; generated once. Do not commit.\n#pragma once\n#define FOCUSDESK_POC_AP_PASSWORD "${secret}"\n`, { flag: 'wx' });
  } catch (error) {
    await unlink(card);
    throw error;
  }
  console.log('Created an independent random WPA2 test password without printing it.');
  console.log(`Local connection card: ${card}`);
  console.log(`Arduino sketch: ${path.join(directory, 'focusdesk_provisioning_poc.ino')}`);
}
