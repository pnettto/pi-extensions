import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,basename,extname} from 'node:path';
import {resolveDate,postItem} from './posting.mjs';
import {dayKey} from '../shared/report-state.mjs';

// Shared by the slash command and agent tool. Authentication is deliberately
// deferred until explicit UI approval; missing UI and cancellation fail closed.
export async function sendHawk({ctx,input,signal,login,report,update=()=>{}}){
 if(!ctx.hasUI)throw new Error('Interactive approval is required to post to Hawk');
 const action=input.action??input.route;
 if(!['note','journal','task','file','notepad','report'].includes(action))throw new Error('Unsupported Hawk action');
 const date=['journal','task','notepad','report'].includes(action)?resolveDate(input.date??(action==='report'?'yesterday':'today')):undefined;
 if(action==='report'){
  if(date>dayKey(new Date()))throw new Error('Cannot report on a future day');
  if(!await ctx.ui.confirm('Post Pi report to Hawk?',`${date}${date===dayKey(new Date())?' · today so far':''} · private Journal note`,{signal}))return {status:'cancelled',action};
  signal?.throwIfAborted();update('Preparing report');
  return await report(date,signal);
 }
 let content=input.content??'',path=input.path??input.file,title=input.title??'',item;
 const hostPath=p=>resolve(ctx.cwd,p.startsWith('~/')?join(homedir(),p.slice(2)):p);
 if(action==='file'){
  if(!path)throw new Error('A host file path is required');
  path=hostPath(path);const info=await stat(path);
  if(!info.isFile()||info.size>100*1024*1024)throw new Error('File must be at most 100 MB');
  if(!await ctx.ui.confirm('Upload file to Hawk?',`${basename(path)} · ${info.size} bytes · private storage`,{signal}))return {status:'cancelled',action};
  signal?.throwIfAborted();
  const bytes=await readFile(path,{signal});
  const mime=({'.html':'text/html','.md':'text/markdown','.txt':'text/plain','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json'})[extname(path).toLowerCase()]??'application/octet-stream';
  item={route:action,name:basename(path),bytes,mime};
 }else{
  if(path){
   if(content)throw new Error('Supply content or a text-file path, not both');
   path=hostPath(path);const info=await stat(path);
   if(!info.isFile()||info.size>50000)throw new Error('Text file must be at most 50 KB');
   content=await readFile(path,{encoding:'utf8',signal});
  }
  if(!content.trim()||Buffer.byteLength(content)>50000)throw new Error('Content must be 1–50000 bytes');
  if(input.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))throw new Error('Time must be HH:MM');
  if(!await ctx.ui.confirm('Send to Hawk?',`${action}${date?' · '+date:''}${title?' · '+title:''}\n${content.slice(0,350)}${content.length>350?'…':''}`,{signal}))return {status:'cancelled',action};
  item={route:action,date,title,content,time:input.time};
 }
 signal?.throwIfAborted();update(`Posting ${action}`);
 const token=await login(signal);signal?.throwIfAborted();
 const result=await postItem('https://hawk.pnetto.store',token,item,signal);
 return {status:'published',action,...(date?{date}:{}),...(result?.id?{id:result.id}:{}),...(result?.name?{name:result.name}:{}),...(typeof result?.size==='number'?{size:result.size}:{})};
}
