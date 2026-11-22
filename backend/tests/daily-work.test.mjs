import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyWork } from '../src/daily-work.ts';

const at = n => new Date(Date.UTC(2026,10,18,2,n)).toISOString();
const screen = (minute,activityEvidence,extra={}) => ({
  id:'row'+minute, at:at(minute), source:'automatic', taskId:null, summary:'可见材料记录 ' + minute, activityEvidence, ...extra,
});
const turn = (minute, conversationId, metadata={}) => ({
  from:at(minute), to:at(minute+1), appName:'ChatGPT', runId:'r'+minute, conversationId,
  title:'网页对话', state:'finished', ...metadata,
});

test('daily work aggregates every verified item per material, independently of the task list', () => {
  const homework = {kind:'work',subject:'数学',title:'作业 3.pdf'};
  const rows = Array.from({length:16},(_,i) => screen(i,{...homework,completedItems:['Q1','Q10']}));
  rows.push(screen(16,{...homework,completedItems:['q1','Q3']}));
  rows.push(screen(17,{...homework,title:'作业 4.pdf',completedItems:['Q1']}));
  rows.push(screen(18,undefined,{summary:'模型提到作业完成了 10 道题。',pageTitle:'数学作业'}));
  const [activity] = dailyWork(rows,[turn(20,'math',{userExcerpt:'我把数学作业 Q99 做完了，该怎么验算？'})]);
  assert.equal(activity.title,'数学');
  assert.deepEqual(activity.completedItems.map(x=>[x.document,x.label]),[
    ['作业 3.pdf','Q1'],['作业 3.pdf','Q10'],['作业 3.pdf','Q3'],['作业 4.pdf','Q1'],
  ]);
  assert.deepEqual(activity.events.map(e=>e.at),[0,16,17,20].map(at));
  assert.equal(activity.events[0].evidence,rows[0].summary);
});

test('preserves material → GPT → material sequence with and without a predefined reading task', () => {
  for (const taskId of [null,'review-math']) {
    const slides = {kind:'reading',subject:'线性代数',title:'Chapter One.pptx',section:'矩阵乘法'};
    const rows = [screen(1,slides,{taskId}), screen(5,slides,{taskId})];
    const chats = [
      turn(2,'math',{userExcerpt:'矩阵乘法的维度如何判断？',assistantExcerpt:'两矩阵的内维必须一致。'}),
      turn(3,'trip',{conversationTitle:'下周出行',userExcerpt:'酒店怎么订？'}),
      turn(4,'math',{userExcerpt:'Chapter One.pptx 为什么要求内维相同？'}),
    ];
    const [math,trip] = dailyWork(rows,chats);
    assert.deepEqual(math.events.map(e=>e.kind),['reading','discussion','discussion','reading']);
    assert.equal(math.completedItems.length,0);
    assert.match(math.events[1].evidence,/矩阵乘法.*\n回复：两矩阵/);
    assert.match(math.events[2].text,/内维相同/);
    assert.equal(trip.title,'下周出行');
  }
});

test('ambiguous and generic aliases do not silently attach conversations to a document', () => {
  const rows = [
    screen(1,{kind:'reading',title:'Lecture.pdf',subject:'art',section:'Introduction'}),
    screen(2,{kind:'reading',title:'Lecture.pdf',subject:'calculus',section:'Limits'}),
  ];
  const chats = [
    turn(3,'ambiguous',{userExcerpt:'Please explain Lecture.pdf'}),
    turn(4,'unrelated',{userExcerpt:'Cartesian coordinates in the Introduction'}),
    turn(5,'two',{conversationTitle:'art',userExcerpt:'How do limits work in calculus?'}),
  ];
  const activities = dailyWork(rows,chats);
  assert.deepEqual(activities.map(a=>a.events.length),[1,1,1,1,1]);
  assert.deepEqual(activities.slice(2).map(a=>a.events[0].kind),['discussion','discussion','discussion']);
});

test('reads verified legacy positions, accepts manual notes, and supports a chat-only day without inventing content', () => {
  const slides = screen(1,undefined,{taskId:'paper',readingDocument:'Measure Theory',readingSection:'Integration',readingPosition:{page:2,total:15}});
  const abstract = screen(2,undefined,{paper:{id:'1706.03762',view:'abstract',title:'Attention Is All You Need'}});
  const pdf = screen(3,undefined,{paper:{id:'1706.03762',view:'pdf',position:{page:2,total:15}}});
  const manual = screen(4,undefined,{source:'manual',summary:'调整了海报的字号。'});
  const activities = dailyWork([slides,abstract,pdf,manual],[]);
  assert.match(activities[0].events[0].text,/Integration.*第 2 \/ 15 页/);
  assert.deepEqual(activities[1].events.map(e=>e.kind),['reading','reading']);
  assert.match(activities[1].events[1].text,/Attention Is All You Need.*第 2 \/ 15 页/);
  assert.equal(activities[2].events[0].source,'手动确认');
  const result = dailyWork([],[
    turn(5,'empty'), turn(6,'generic',{conversationTitle:'New chat'}),
    turn(7,'content',{conversationTitle:'色彩对比',userExcerpt:'怎样使用互补色？'}),
    turn(8,'title',{conversationTitle:'纸张尺寸'}),
  ]);
  assert.deepEqual(result.map(a=>a.title),['色彩对比','纸张尺寸']);
  assert.match(result[0].events[0].text,/互补色/);
  assert.equal(result[1].events[0].text,'对话《纸张尺寸》');
});

test('separates visible answers from completion marks per document and preserves the order they appeared', () => {
  const sheet = {kind:'work', title:'Worksheet A', subject:'Math'};
  const rows = [
    screen(1,{...sheet,answeredItems:['Q1','Q10']}),
    screen(2,{...sheet,answeredItems:['Q1','Q10']}),
    screen(3,{...sheet,completedItems:['Question 1'],answeredItems:['Q 1','Q10']}),
    screen(4,{...sheet,answeredItems:['Q1']}),
    screen(5,{...sheet,title:'Worksheet B',answeredItems:['Q1']}),
  ];
  const [work] = dailyWork(rows,[turn(6,'math',{userExcerpt:'I answered Q99 in Math. Did I hand it in?'})]);
  assert.deepEqual(work.completedItems,[{document:'Worksheet A',label:'Question 1'}]);
  assert.deepEqual(work.answeredItems,[{document:'Worksheet A',label:'Q10'},{document:'Worksheet B',label:'Q1'}]);
  assert.deepEqual(work.events.map(e=>e.at), [1,3,4,5,6].map(at));
  assert.match(work.events[0].text,/可见作答：Q1、Q10/);
  assert.match(work.events[1].text,/有完成标记：Question 1 · 可见作答：Q10$/);
  assert.doesNotMatch(work.events[1].text,/已提交|当天完成|可见作答：Q 1/);
  const [allMarked] = dailyWork([rows[0],screen(8,{...sheet,completedItems:['Q1','Q10']})],[]);
  assert.equal(allMarked.answeredItems,undefined);
});
