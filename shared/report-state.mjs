import {readFile,mkdir,open,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export function yesterday(now = new Date()) { const d = new Date(now); d.setDate(d.getDate()-1); return dayKey(d); }
export function bounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Use YYYY-MM-DD');
  const start = new Date(`${day}T00:00:00`); if (dayKey(start)!==day) throw new Error('Invalid date');
  const end = new Date(start); end.setDate(end.getDate()+1); return [start,end];
}
export async function claim(dir, day) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,`${day}.lock`);
  for(let i=0;i<2;i++) {
    try {const f=await open(path,'wx',0o600);await f.writeFile(String(process.pid));await f.close();return async()=>{await unlink(path).catch(()=>{});};}
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      let pid;try{pid=Number(await readFile(path,'utf8'));}catch{return null;}
      if(!Number.isInteger(pid)||pid<=0)return null;
      try{process.kill(pid,0);return null;}catch(err){if(err.code!=='ESRCH')return null;}
      await unlink(path).catch(()=>{});
    }
  }
  return null;
}
export async function readState(dir,day) {try{return JSON.parse(await readFile(join(dir,`${day}.json`),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function saveState(dir,day,state) {await writeFile(join(dir,`${day}.json`),JSON.stringify(state),{mode:0o600});}
