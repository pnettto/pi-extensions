import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRoute,postItem,resolveDate} from './posting.mjs';

test('direct routes accept options, aliases and unclassified text invokes guide',()=>{
 assert.equal(parseRoute(['tasks','Call bank','--date','2026-11-16']).route,'task');
 assert.equal(parseRoute(['note','Hello','--title','Greeting']).title,'Greeting');
 assert.equal(parseRoute(['some','unclassified','text']).route,null);
 assert.equal(parseRoute([]).route,null);
 assert.throws(()=>parseRoute(['note','--oops']),/Unknown/);
 assert.throws(()=>parseRoute(['task','--date']),/Missing/);
 assert.equal(resolveDate('2026-11-16'),'2026-11-16');
 assert.throws(()=>resolveDate('2026-02-30'));
});
async function capture(item,verify){
 const original=globalThis.fetch;let call;
 globalThis.fetch=async(url,options)=>{call={url:String(url),...options};return new Response('{"success":true}');};
 try{await postItem('https://example.test','token',item);verify(call);}finally{globalThis.fetch=original;}
}
test('undated notes are private and separate from journal notes',async()=>{
 await capture({route:'note',title:'Title',content:'Body'},c=>{const b=JSON.parse(c.body);assert.equal(b.isPublic,false);assert.equal(b.day,undefined);assert.equal(b.content,'Body');assert.match(c.url,/api\/notes\/notes$/);});
 await capture({route:'journal',title:'Title',content:'Body',date:'2026-11-16'},c=>assert.equal(JSON.parse(c.body).day,'2026-11-16'));
});
test('tasks merge new entries without replacing the day',async()=>{
 await capture({route:'task',content:'- [ ] First\n- Second',date:'2026-11-16',time:'09:30'},c=>{
  assert.match(c.url,/api\/day\/tasks\?date=2026-11-16/);const b=JSON.parse(c.body);
  assert.deepEqual(b.upsert.map(t=>t.text),['First','Second']);assert.equal(b.upsert[0].done,false);assert.equal(b.upsert[0].time,'09:30');assert.equal(b.remove,undefined);
 });
 await assert.rejects(postItem('https://example.test','token',{route:'task',content:'X',date:'2026-11-16',time:'25:00'}),/HH:MM/);
});
test('notepad uses the daily note endpoint, not journal storage',async()=>{
 await capture({route:'notepad',title:'Pad',content:'# Text',date:'2026-11-16'},c=>{
  assert.match(c.url,/api\/day\/notes\?date=2026-11-16/);const b=JSON.parse(c.body);assert.equal(b.note.markdown,'# Text');assert.equal(b.baseRev,0);
 });
});
test('file upload uses raw bytes and required headers',async()=>{
 await capture({route:'file',name:'hello world.txt',mime:'text/plain',bytes:Buffer.from('abc')},c=>{
  assert.match(c.url,/api\/files$/);assert.equal(c.headers['content-length'],'3');assert.equal(c.headers['x-file-name'],'hello%20world.txt');assert.equal(c.body.toString(),'abc');assert.equal(c.headers.authorization,'Bearer token');
 });
});
test('file server failures surface without retry or duplicate upload',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:503});};
 try{await assert.rejects(postItem('https://example.test','token',{route:'file',name:'a.txt',bytes:Buffer.from('a')}),/HTTP 503/);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('empty or invalid posts are blocked before sending',async()=>{
 await assert.rejects(postItem('https://example.test','token',{route:'note',content:''}),/Content/);
 await assert.rejects(postItem('https://example.test','token',{route:'journal',content:'x',date:'bad'}),/YYYY-MM-DD/);
});
