import {randomUUID} from 'node:crypto';
import {request} from './core.mjs';
import {bounds,dayKey} from '../shared/report-state.mjs';

export const routes=['note','journal','task','file','notepad','report','status'];
export function parseRoute(args) {
 const [first,...rest]=args;
 const route=({notes:'note',tasks:'task',files:'file',notepads:'notepad'})[first]??first;
 if(!routes.includes(route))return {route:null,text:args.join(' ')};
 const result={route,text:'',date:undefined,title:undefined,file:undefined,time:undefined};const text=[];
 for(let i=0;i<rest.length;i++){
  const a=rest[i];
  if(a==='--'){text.push(...rest.slice(i+1));break;}
  if(['--date','--title','--file','--time'].includes(a)){
   if(!rest[i+1]||rest[i+1].startsWith('--'))throw new Error(`Missing value for ${a}`);
   result[a.slice(2)]=rest[++i];
  }else if(a.startsWith('--'))throw new Error(`Unknown option ${a}`);else text.push(a);
 }
 result.text=text.join(' ');return result;
}
export function resolveDate(input) {
 if(!input||input==='today')return dayKey(new Date());
 if(input==='yesterday'||input==='tomorrow'){const d=new Date();d.setDate(d.getDate()+(input==='tomorrow'?1:-1));return dayKey(d);}
 bounds(input);return input;
}
export async function postItem(base,token,item,signal) {
 const {route,content='',title='',date,time}=item;
 if(route==='file'){
  if(!item.bytes||item.bytes.byteLength>100*1024*1024)throw new Error('File exceeds 100 MB');
  const r=await fetch(new URL('/api/files',base),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':item.mime??'application/octet-stream','content-length':String(item.bytes.byteLength),'x-file-name':encodeURIComponent(item.name)},body:item.bytes,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  if(!r.ok)throw new Error(`Hawk file upload returned HTTP ${r.status}`);return r.json();
 }
 if(!content.trim()||Buffer.byteLength(content)>50000)throw new Error('Content must be 1–50000 bytes');
 if(route!=='note')bounds(date);
 if(route==='task'){
  if(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('Time must be HH:MM');
  const lines=content.split('\n').map(s=>s.replace(/^\s*[-*]\s+(?:\[ \]\s*)?/,'').trim()).filter(Boolean);
  if(lines.length>100)throw new Error('Maximum 100 tasks per post');
  return request(base,`/api/day/tasks?date=${date}`,token,{upsert:lines.map((text,i)=>({id:randomUUID(),text,done:false,order:Date.now()+i,...(time?{time}:{})}))},signal);
 }
 if(route==='notepad')return request(base,`/api/day/notes?date=${date}&snapshot=true`,token,{note:{id:randomUUID(),title,markdown:content},baseRev:0},signal);
 if(route==='note'||route==='journal')return request(base,'/api/notes/notes',token,{id:randomUUID(),title,content,isPublic:false,baseRev:0,snapshot:true,...(route==='journal'?{day:date}:{})},signal);
 throw new Error('Unsupported posting route');
}
