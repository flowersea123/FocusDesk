import { readFile, writeFile } from 'node:fs/promises';
import { analyzeMail } from '../analyze.mjs';

const endpoint = process.env.FOCUSDESK_MODEL_URL ?? 'http://127.0.0.1:18187';
const suite = process.argv[3] === 'second' ? './second-set.json' : './cases.json';
const cases = JSON.parse(await readFile(new URL(suite, import.meta.url), 'utf8'));
const modelName = process.env.FOCUSDESK_MODEL_NAME ?? 'focusdesk-mail';
const measurements = [];
for (const sample of cases) {
  const images = sample.image ? [{ mime: 'image/png', data: await readFile(new URL(sample.image, import.meta.url)) }] : [];
  const mail = { subject: sample.subject, body: sample.body, receivedAt: '2026-11-14T01:00:00Z', images };
  const started = performance.now();
  try {
    const result = await analyzeMail(mail, { endpoint, model: modelName });
    const observed = result.deadlines.map(d => d.due_local).sort();
    const correct = JSON.stringify(observed) === JSON.stringify([...sample.expect].sort());
    measurements.push({ id: sample.id, image: Boolean(sample.image), correct, seconds: (performance.now() - started) / 1000, observed, result });
    console.log(sample.id, correct ? 'PASS' : 'MISS', JSON.stringify(observed));
  } catch (error) {
    measurements.push({ id: sample.id, image: Boolean(sample.image), correct: false, seconds: (performance.now() - started) / 1000, error: error.message });
    console.log(sample.id, 'ERROR', error.message);
  }
}
const scored = measurements.filter(x => x.correct).length;
console.log(`Exact deadline lists: ${scored}/${cases.length}.`);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(measurements, null, 2) + '\n');
if (measurements.some(x => x.error)) process.exitCode = 1;
