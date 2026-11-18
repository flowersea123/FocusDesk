import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperReader, paperFromHeader } from '../src/foreground-mac/paper-reader.ts';

const box = (text, x, y, height = 16) => ({text, x, y, height});
const title = '[1706.03762] Attention Is All You Need';
const pdf = box('https://arxiv.org/pdf/1706.03762#page=2', 130, 55);
const toolbar = [box('5', 502, 97), box('/ 15', 530, 99), box('100%', 600, 97)];

test('requires a visible arXiv address and reads the PDF viewer page and total as a pair', () => {
  assert.deepEqual(paperFromHeader(title, [pdf, ...toolbar]), {id:'1706.03762', view:'pdf', position:{page:5, total:15}});
  assert.deepEqual(paperFromHeader(title, [pdf]), {id:'1706.03762', view:'pdf'});
  assert.deepEqual(paperFromHeader(title, [pdf, box('5 / 15', 124, 190), toolbar[2]]), {id:'1706.03762', view:'pdf'});
  assert.deepEqual(paperFromHeader(title, [pdf, box('22 / 15  100%', 600, 97)]), {id:'1706.03762', view:'pdf'});
  assert.equal(paperFromHeader(title, [box(pdf.text, 130, 300)]), undefined);
  assert.equal(paperFromHeader(title, [box('example.com/arxiv.org/pdf/1706.03762', 130, 55)]), undefined);
  assert.equal(paperFromHeader(title, []), undefined);
});

test('matches abstract titles to the actual identifier, including legacy and versioned addresses', () => {
  assert.deepEqual(paperFromHeader(title, [box('arxiv.org/abs/1706.03762', 130, 55)]),
    {id:'1706.03762', view:'abstract', title:'Attention Is All You Need'});
  assert.deepEqual(paperFromHeader(title, [box('https://arxiv.org/abs/math.GT/0309136v3', 130, 55)]),
    {id:'math.GT/0309136v3', view:'abstract'});
});

test('drops a Chrome translation panel; recognizes the restored foreground and caches identical frames', async () => {
  let requests = 0;
  const read = createPaperReader(async image => {
    ++requests;
    const prompt = box('Translate this page?', 520, 120);
    if (image === 'with-overlay') return [pdf, prompt];
    return image === 'beside-toolbar' ? [pdf, ...toolbar, prompt] : [pdf, ...toolbar];
  });
  const original = {pageKey:'front', app:'Google Chrome', pageTitle:title, image:'original'};
  assert.equal(await read({...original, pageTitle:'翻译此页？'}), null);
  assert.equal(requests, 0);
  assert.equal(await read({...original, image:'with-overlay'}), null);
  assert.equal(await read({...original, image:'with-overlay'}), null);
  assert.equal(requests, 1);
  assert.deepEqual((await read(original)).paper.position, {page:5, total:15});
  assert.deepEqual((await read(original)).paper.position, {page:5, total:15});
  await read({...original, app:'Safari'});
  assert.equal(requests, 2);
  assert.deepEqual((await read({...original, image:'beside-toolbar'})).paper.position, {page:5, total:15});
  assert.equal(requests, 3);
});

test('a failed OCR attempt leaves ordinary recording available and throttles immediate retries', async () => {
  let requests = 0;
  const read = createPaperReader(async () => { ++requests; return undefined; });
  const frame = {app:'Google Chrome', pageKey:'front', image:'frame'};
  assert.equal(await read(frame), frame);
  assert.equal(await read(frame), frame);
  assert.equal(requests, 1);
});
