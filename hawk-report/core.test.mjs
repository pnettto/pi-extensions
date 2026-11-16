import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bounds,yesterday,claim,readState,saveState} from '../shared/report-state.mjs';
import {collect} from '../report/core.mjs';
import {publish} from './core.mjs';

test('yesterday respects local calendar/month boundaries',()=>{
 assert.equal(yesterday(new Date(2026,10,1,1)),'2026-10-31');
 const [a,b]=bounds('2026-11-16');assert.equal(a.getHours(),0);assert.equal(b.getDate(),17);
 assert.throws(()=>bounds('2026-02-30'));
});
test('only one process can claim a day, released locks can retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hawk-test-'));
 try {const release=await claim(dir,'2026-11-16');assert.ok(release);assert.equal(await claim(dir,'2026-11-16'),null);await release();const retry=await claim(dir,'2026-11-16');assert.ok(retry);await retry();}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('state is durable and absence differs from published',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hawk-test-'));
 try {assert.equal(await readState(dir,'2026-11-16'),null);await saveState(dir,'2026-11-16',{status:'published'});assert.equal((await readState(dir,'2026-11-16')).status,'published');}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('collect filters timestamps, deduplicates forks, excludes reports but keeps later work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hawk-test-'));
 const entry=(hour,role,text)=>({type:'message',timestamp:new Date(2026,10,16,hour).toISOString(),message:{role,content:text}});
 const rows=[{type:'session',cwd:'/project'},entry(9,'user','Implement feature'),entry(10,'assistant','Done'),entry(11,'user','Create my Pi report for day, using preferences'),entry(11,'assistant','report'),entry(12,'user','Implement automation'),entry(12,'assistant','Implemented')];
 try {
  await mkdir(join(dir,'project'));await writeFile(join(dir,'project','old-session.jsonl'),rows.map(JSON.stringify).join('\n'));
  await writeFile(join(dir,'fork.jsonl'),rows.map(JSON.stringify).join('\n'));
  const data=await collect(dir,'2026-11-16');assert.equal(data.flatMap(s=>s.messages).length,4);
  assert.deepEqual(await collect(dir,'2026-11-15'),[]);
 } finally{await rm(dir,{recursive:true,force:true});}
});
test('publish never overwrites an existing or trashed note',async()=>{
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,opts)=>{calls.push(opts.method);return new Response(JSON.stringify({id:'pi-report-2026-11-16',deletedAt:123}));};
 try{assert.equal((await publish('https://example.test','token','2026-11-16','report')).existing,true);assert.deepEqual(calls,['GET']);}
 finally{globalThis.fetch=original;}
});
test('publish creates a private journal note for the requested date',async()=>{
 const original=globalThis.fetch;let body;
 globalThis.fetch=async(url,opts)=>{if(opts.method==='GET')return new Response('',{status:404});body=JSON.parse(opts.body);return new Response('{"success":true}');};
 try{await publish('https://example.test','token','2026-11-16','## Pi report');assert.equal(body.day,'2026-11-16');assert.equal(body.isPublic,false);assert.equal(body.baseRev,0);assert.equal(body.id,'pi-report-2026-11-16');}
 finally{globalThis.fetch=original;}
});
test('today snapshots use a separate private note and preserve the final report ID',async()=>{
 const original=globalThis.fetch;const bodies=[];
 globalThis.fetch=async(url,opts)=>{if(opts.method==='GET')return new Response('',{status:404});bodies.push(JSON.parse(opts.body));return new Response('{"success":true}');};
 try{
  await publish('https://example.test','token','2026-11-16','## Pi report',undefined,true);
  await publish('https://example.test','token','2026-11-16','## Pi report');
  assert.equal(bodies[0].id,'pi-report-2026-11-16-snapshot');
  assert.equal(bodies[0].day,'2026-11-16');assert.equal(bodies[0].isPublic,false);
  assert.match(bodies[0].title,/so far/);assert.equal(bodies[1].id,'pi-report-2026-11-16');
 }finally{globalThis.fetch=original;}
});
test('API failures reject rather than report success',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('',{status:401});
 try{await assert.rejects(publish('https://example.test','bad','2026-11-16','report'),/HTTP 401/);}
 finally{globalThis.fetch=original;}
});
