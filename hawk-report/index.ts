import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseCommandArgs } from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { claim, dayKey, readState, saveState, yesterday } from '../shared/report-state.mjs';
import { publish, request } from './core.mjs';
import {parseRoute} from './posting.mjs';
import {sendHawk} from './manual.mjs';

const exec=promisify(execFile),stateDir=join(homedir(),'.pi','agent','hawk-reports'),base='https://hawk.pnetto.store';
const labels={'Private note':'note','Journal note (dated)':'journal','Daily task(s)':'task','Upload file':'file','Daily notepad note':'notepad','Pi report':'report','Posting status':'status'};
const help='/hawk note|journal|task|file|notepad|report|status [text/path] [--date YYYY-MM-DD] [--title "Title"] [--file path] [--time HH:MM]';

export default function(pi:ExtensionAPI){
 let running=false,stopped=false,lastAttempt=0;
 let controller:AbortController|undefined,pending:Promise<any>|undefined;
 const login=async(signal:AbortSignal)=>{
  const credential=await exec('/usr/bin/security',['find-generic-password','-a',userInfo().username,'-s','pi-hawk-password','-w'],{timeout:30000,signal});
  const auth=await request(base,'/api/login',undefined,{password:credential.stdout.replace(/\n$/,'')},signal);
  if(!auth?.token)throw new Error('No Hawk token');return auth.token;
 };
 const postReport=async(ctx:ExtensionContext,day:string,signal:AbortSignal)=>{
  const snapshot=day===dayKey(new Date()),key=day+(snapshot?'-snapshot':'');
  const release=await claim(stateDir,key);
  if(!release)return {status:'busy',action:'report',date:day};
  try{
   const state=await readState(stateDir,key);
   if(state?.status==='published'||state?.status==='empty')return {status:state.status==='published'?'already_published':'empty',action:'report',date:day,id:state.id};
   if(!pi.getCommands().some(c=>c.name==='report-generate'))throw new Error('Report extension unavailable');
   const {generateReport}=await import('../report/index.ts');
   const report=await generateReport(ctx,day,signal);
   if(report.status==='empty'){if(!snapshot)await saveState(stateDir,key,{status:'empty'});return {status:'empty',action:'report',date:day};}
   ctx.ui.setStatus('hawk-report',`Hawk: posting ${day}`);
   const token=await login(signal),result=await publish(base,token,day,report.content,signal,snapshot);
   await saveState(stateDir,key,{status:'published',id:result.id,at:new Date().toISOString()});
   return {status:result.existing?'already_published':'published',action:'report',date:day,id:result.id};
  }finally{await release();}
 };
 const status=async()=>{const date=yesterday(),state=await readState(stateDir,date);return {status:running?'running':state?.status??'not_sent',date};};
 const work=(ctx:ExtensionContext,fn:(signal:AbortSignal)=>Promise<any>,external?:AbortSignal)=>{
  if(stopped||running)return Promise.resolve({status:'busy'});
  running=true;lastAttempt=Date.now();controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(9*60*1000),...(external?[external]:[])]);
  pending=fn(signal).finally(()=>{if(!stopped)ctx.ui.setStatus('hawk-report',undefined);running=false;pending=undefined;controller=undefined;});
  return pending;
 };
 const manual=(ctx:ExtensionContext,input:any,external?:AbortSignal,onUpdate?:(text:string)=>void)=>work(ctx,signal=>sendHawk({ctx,input,signal,login,report:(date:string,s:AbortSignal)=>postReport(ctx,date,s),update:(text:string)=>{ctx.ui.setStatus('hawk-report',`Hawk: ${text}`);onUpdate?.(text);}}),external);
 const announce=(ctx:ExtensionContext,result:any)=>ctx.ui.notify(`Hawk: ${result.status}${result.action?' · '+result.action:''}${result.date?' · '+result.date:''}`,result.status==='busy'?'warning':'info');
 const automatic=(ctx:ExtensionContext)=>{
  try{if(JSON.parse(readFileSync(join(stateDir,'settings.json'),'utf8')).automatic===false)return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return;}
  if(stopped||running||ctx.mode!=='tui'||Date.now()-lastAttempt<10*60*1000)return;
  void work(ctx,signal=>postReport(ctx,yesterday(),signal)).then(result=>{if(result.status==='published')announce(ctx,result);}).catch(()=>{if(!stopped)ctx.ui.notify('Automatic Hawk report failed; it can retry on later Pi use.','warning');});
 };
 pi.on('session_start',(_event,ctx)=>{stopped=false;automatic(ctx);});
 pi.on('before_agent_start',(_event,ctx)=>automatic(ctx));
 pi.on('session_shutdown',async()=>{stopped=true;controller?.abort();try{await pending;}catch{}});
 pi.registerTool({
  name:'hawk',label:'Hawk',exposure:'model-only',
  description:'Post a private note, journal entry, daily task(s), file upload, notepad note, or Pi report to Hawk; or check status. Uses the same approved flow as /hawk. Requires explicit UI confirmation before any manual upload; never bypass using shell scripts. Host paths resolve relative to the Pi working directory, outside Gondolin. Supply content or a path to a text file; action=file uploads raw bytes. Ask the user if the destination or required content/path is unclear.',
  promptSnippet:'Post notes, tasks, files and reports to Hawk with approval',
  promptGuidelines:['Use the hawk tool for Hawk uploads and posting requests instead of terminal scripts, curl, or recreating authentication logic. Do not retry a failed manual write without checking with the user; a lost response may have saved successfully.'],
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  parameters:Type.Object({
   action:Type.Union(['note','journal','task','file','notepad','report','status'].map(v=>Type.Literal(v))),
   content:Type.Optional(Type.String({description:'Markdown/text, or tasks separated by newlines'})),
   path:Type.Optional(Type.String({description:'Host path: required for file uploads; optional text-file source for notes/tasks'})),
   title:Type.Optional(Type.String()),date:Type.Optional(Type.String({description:'today, yesterday, tomorrow or YYYY-MM-DD; reports cannot target future days'})),time:Type.Optional(Type.String({description:'Optional task time HH:MM'})),
  }),
  async execute(_id,params,signal,onUpdate,ctx){
   try{
    const result=params.action==='status'?await status():await manual(ctx,params,signal,text=>onUpdate?.({content:[{type:'text',text}],details:{status:'running'}}));
    return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
   }catch{
    return {isError:true,content:[{type:'text',text:'Hawk operation failed or was aborted. No automatic retry was made. Check approval, input, Keychain and network; do not assume an interrupted upload was unsaved.'}],details:{status:'failed'}};
   }
  },
 });
 pi.registerCommand('hawk',{
  description:'Post notes, journal entries, tasks, files, notepad notes or reports; no args opens a guide',
  handler:async(args,ctx)=>{
   if(args.trim()==='help'){ctx.ui.notify(help,'info');return;}
   let input:any;try{input=parseRoute(parseCommandArgs(args));}catch(e){ctx.ui.notify((e as Error).message,'warning');return;}
   const guided=!input.route;
   if(guided){const selected=await ctx.ui.select('What would you like to send to Hawk?',Object.keys(labels));if(!selected)return;input.route=labels[selected as keyof typeof labels];}
   if(input.route==='status'){announce(ctx,await status());return;}
   if(running){ctx.ui.notify('Hawk publisher is busy.','info');return;}
   if(input.route==='report'){
    input.date=input.date||input.text||await ctx.ui.select('Report for which day?',['yesterday','today']);if(!input.date)return;
   }else if(input.route==='file'){
    input.path=input.file||input.text||await ctx.ui.input('Host file path to upload');if(!input.path)return;
   }else{
    if(guided&&input.route!=='note'){const date=await ctx.ui.input('Date (today, yesterday, tomorrow or YYYY-MM-DD)','today');if(date===undefined)return;input.date=date;}
    input.content=input.text||'';input.path=input.file;
    if(!input.content&&!input.path){input.content=await ctx.ui.editor(input.route==='task'?'Tasks (one per line)':'Note content (Markdown)','');if(!input.content)return;}
    if(input.route!=='task'&&!input.title){const title=await ctx.ui.input('Note title (optional)');if(title===undefined)return;input.title=title;}
   }
   void manual(ctx,{...input,action:input.route}).then(result=>announce(ctx,result)).catch(()=>ctx.ui.notify('Hawk operation failed; check input, Keychain or network. No manual upload is automatically retried.','warning'));
  },
 });
}
