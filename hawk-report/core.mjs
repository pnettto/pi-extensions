export async function request(base,path,token,body,signal) {
  const r=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(r.status===404&&body===undefined)return null;
  if(!r.ok)throw new Error(`Hawk API returned HTTP ${r.status}`);
  return r.json();
}
export const noteId = day => `pi-report-${day}`;
export async function publish(base,token,day,content,signal,snapshot=false) {
  const id=noteId(day)+(snapshot?'-snapshot':''),existing=await request(base,`/api/notes/notes/${id}`,token,undefined,signal);
  // Never overwrite an existing report, including one edited or trashed by the user.
  if(existing)return {id,existing:true};
  if(!content.trim()||Buffer.byteLength(content)>50000)throw new Error('Report is empty or too large');
  await request(base,'/api/notes/notes',token,{id,title:`Pi report — ${day}${snapshot?' (so far)':''}`,day,content,isPublic:false,baseRev:0,snapshot:true},signal);
  return {id,existing:false};
}
