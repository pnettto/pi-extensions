import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sendHawk} from './manual.mjs';
const ctx=confirm=>({hasUI:true,cwd:tmpdir(),ui:{confirm}});

test('no UI fails closed without authentication',async()=>{
 let auth=0;await assert.rejects(sendHawk({ctx:{hasUI:false},input:{action:'note',content:'x'},login:async()=>auth++}),/approval/);assert.equal(auth,0);
});
test('denied confirmation neither authenticates nor posts',async()=>{
 let auth=0;const result=await sendHawk({ctx:ctx(async()=>false),input:{action:'note',content:'x'},login:async()=>auth++});assert.equal(result.status,'cancelled');assert.equal(auth,0);
});
test('approved note authenticates only after approval and returns saved result',async()=>{
 const events=[],original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{events.push('post');assert.equal(JSON.parse(options.body).content,'Body');return new Response('{"id":"saved-note"}');};
 try{
  const result=await sendHawk({ctx:ctx(async()=>{events.push('confirm');return true;}),input:{action:'note',content:'Body'},login:async()=>{events.push('login');return 'token';}});
  assert.deepEqual(events,['confirm','login','post']);assert.equal(result.id,'saved-note');assert.equal(result.status,'published');
 }finally{globalThis.fetch=original;}
});
test('report uses the delegated generator only after approval',async()=>{
 let calls=0;
 const cancelled=await sendHawk({ctx:ctx(async()=>false),input:{action:'report',date:'yesterday'},report:async()=>calls++});assert.equal(cancelled.status,'cancelled');assert.equal(calls,0);
 const result=await sendHawk({ctx:ctx(async()=>true),input:{action:'report',date:'yesterday'},report:async()=>{calls++;return {status:'published',id:'report-id'};}});
 assert.equal(result.id,'report-id');assert.equal(calls,1);
});
test('file upload uses shared API, requires approval and returns metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hawk-manual-')),original=globalThis.fetch;await writeFile(join(dir,'index.html'),'<h1>Hello</h1>');
 globalThis.fetch=async(url,options)=>{assert.equal(options.headers['content-type'],'text/html');return new Response('{"id":"file-id","name":"index.html","size":14}');};
 try{
  const context={...ctx(async()=>true),cwd:dir};
  const result=await sendHawk({ctx:context,input:{action:'file',path:'index.html'},login:async()=> 'token'});
  assert.equal(result.status,'published');assert.equal(result.name,'index.html');assert.equal(result.id,'file-id');
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
test('aborted approval does not reach login even if UI returns true',async()=>{
 const controller=new AbortController();let auth=0;
 await assert.rejects(sendHawk({ctx:ctx(async()=>{controller.abort();return true;}),input:{action:'note',content:'x'},signal:controller.signal,login:async()=>auth++}));assert.equal(auth,0);
});
