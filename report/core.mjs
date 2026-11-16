import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bounds} from '../shared/report-state.mjs';
async function* files(dir) {
  for (const e of await readdir(dir,{withFileTypes:true})) {
    const p=join(dir,e.name); if(e.isDirectory()) yield* files(p); else if(e.isFile()&&e.name.endsWith('.jsonl')) yield p;
  }
}
export function textOf(m) { return typeof m.content==='string'?m.content:(m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'); }
export async function collect(root, day) {
  const [start,end]=bounds(day), sessions=[], seen=new Set();
  for await (const path of files(root)) {
    let source; try { source=await readFile(path,'utf8'); } catch { continue; }
    let cwd='', recap=false; const messages=[];
    for (const line of source.split('\n')) {
      let e; try { e=JSON.parse(line); } catch { continue; }
      if(e.type==='session') cwd=e.cwd??'';
      const m=e.message; if(!m||!['user','assistant'].includes(m.role)) continue;
      const text=textOf(m).trim(); if(!text) continue;
      if(m.role==='user') recap=/^(?:\/(?:report|day)(?:\s|$)|Create my (?:daily )?Pi report for\b)/i.test(text);
      if(recap) continue;
      const at=new Date(e.timestamp); if(!(at>=start&&at<end)) continue;
      const key=createHash('sha256').update(`${e.timestamp}|${m.role}|${text}`).digest('hex');
      if(seen.has(key)) continue; seen.add(key);
      messages.push({at:at.toISOString(),role:m.role,text});
    }
    if(messages.length) sessions.push({cwd,messages});
  }
  return sessions;
}
