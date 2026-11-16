import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const root = '/Users/p327gvf/.pi/agent/install/releases/1.5.2/node_modules';
const require = createRequire(`${root}/jiti/package.json`);
const { createJiti } = require('jiti');
const tui = await import(`${root}/@earendil-works/pi-tui/dist/index.js`);
const home = mkdtempSync(join(tmpdir(), 'extensions-test-'));
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: false, alias: {
 '@earendil-works/pi-coding-agent': `${home}/agent.cjs`,
 '@earendil-works/pi-tui': `${root}/@earendil-works/pi-tui/dist/index.js`,
} });
writeFileSync(`${home}/agent.cjs`, `exports.getAgentDir = () => ${JSON.stringify(home)};`);
const { default: extension, discover, patchJson } = await jiti.import('./index.ts');
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const { getThemeByName } = await import(`${root}/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js`);
const kb = { matches: (data,id) => tui.matchesKey(data, ({ 'tui.select.up':'up','tui.select.down':'down','tui.select.confirm':'enter','tui.select.cancel':'escape' })[id]) };
function harness({ busy = false, appearance = 'dark', extensionPath = '/tmp/web.ts' } = {}) {
 let component, options, active = ['read', 'search'], toolCalls = 0, closed = false, editorChanges = 0;
 const terminal = { rows: 32 };
 const handlers = {}, commands = new Map(), shortcuts = new Map();
 const tools = [
  { name:'read', description:'Read files 中文 🌿. ' + 'Description text. '.repeat(60), parameters:{ type:'object',properties:{path:{type:'string', description:'File path'}},required:['path'] }, sourceInfo:{path:'builtin:read',source:'builtin'}, exposure:'direct' },
  { name:'search', description:'Search the web', parameters:{type:'object',properties:{}}, sourceInfo:{path:'/tmp/web.ts',source:'user'}, exposure:'deferred' },
 ];
 const pi = {
  on:(name,fn) => { handlers[name] = fn; },
  registerCommand:(name,opts) => commands.set(name,opts),
  registerShortcut:(key,opts) => shortcuts.set(key,opts),
  getAllTools:() => tools, getActiveTools:() => active,
  setActiveTools:names => { active = names; toolCalls++; },
  getSettings:() => ({extensions:[]}),
  getCommands:() => [{name:'web',description:'Browse the web',source:'extension',sourceInfo:{path:extensionPath,source:'user'}},{name:'mcp',description:'MCP',source:'extension',sourceInfo:{path:'builtin:mcp',source:'builtin'}}],
 };
 const ctx = { mode:'tui', cwd:home, isProjectTrusted:() => false, isIdle:() => !busy,
  ui:{ notify:()=>{}, getToolsExpanded:()=>false, setToolsExpanded:()=>{}, setEditorText:()=>{editorChanges++;}, confirm:async()=>true,
   custom:async (factory,opts) => { options = opts; component = factory({terminal,requestRender(){}},getThemeByName(appearance),kb,()=>{closed=true;}); },
  },
 };
 extension(pi);
 return { ctx,terminal,commands,shortcuts,handlers,get component(){return component;},get options(){return options;},get active(){return active;},get closed(){return closed;},get toolCalls(){return toolCalls;},get editorChanges(){return editorChanges;} };
}
test('built-ins sort after local extensions', async () => {
 const h = harness(); await h.commands.get('extensions').handler('',h.ctx);
 const output = strip(h.component.render(100).join('\n'));
 assert.ok(output.indexOf('Your extensions') < output.indexOf('Built-in'));
 assert.ok(output.indexOf('› Web') < output.indexOf('MCP'));
});
test('extension settings save selected values without replacing unrelated fields', async () => {
 writeFileSync(join(home,'settings.json'),JSON.stringify({unrelated:42,extensionPreferences:{notify:{permission:false}}}));
 const h = harness({extensionPath:'/tmp/notify.ts'});
 h.ctx.ui.select = async () => { throw new Error('Settings must stay inside the overlay'); };
 await h.commands.get('extensions').handler('',h.ctx);
 await focusSettings(h);
 assert.ok(text(h).includes('Settings · editing'));
 await h.component.handleInput('\x1b[C');
 await h.component.handleInput('\x1b[B');
 await h.component.handleInput('\x1b[A');
 await h.component.handleInput('\x1b[C');
 await h.component.handleInput('\x1b[D');
 const saved = JSON.parse(readFileSync(join(home,'settings.json'),'utf8'));
 assert.equal(saved.unrelated,42); assert.equal(saved.extensionPreferences.notify.permission,false);
 assert.equal(saved.extensionPreferences.notify.completion,false);
});
test('global settings save real Pi values and label reload requirement', async () => {
 writeFileSync(join(home,'settings.json'),JSON.stringify({unrelated:42}));
 const h = harness(); await h.commands.get('extensions').handler('',h.ctx);
 await h.component.handleInput('\t'); await h.component.handleInput('\t');
 for(let i=0;i<3;i++) await h.component.handleInput('\x1b[B');
 await h.component.handleInput(' ');
 const saved = JSON.parse(readFileSync(join(home,'settings.json'),'utf8'));
 assert.equal(saved.hideThinkingBlock,true); assert.equal(saved.unrelated,42);
 assert.ok(strip(h.component.render(100).join('\n')).includes('/reload'));
});
const text = h => strip(h.component.render(100).join('\n'));
async function open(h) { await h.commands.get('extensions').handler('',h.ctx); }
async function focusSettings(h) {
 text(h);
 await h.component.handleInput('\x1b[C');
 for (let i=0;i<60;i++) {
  const output = text(h);
  if (output.includes('› Settings  →')) {
   await h.component.handleInput('\r'); text(h); return;
  }
  await h.component.handleInput('\x1b[B');
 }
 assert.fail('Settings row should be reachable with arrows');
}
test('safe JSON patch preserves unrelated settings and refuses malformed JSON', () => {
 const path = join(home,'settings.json'); writeFileSync(path,JSON.stringify({unrelated:42,extensions:[]}));
 patchJson(path, data => ({...data,extensions:['-/tmp/web.ts']}));
 assert.deepEqual(JSON.parse(readFileSync(path,'utf8')), {unrelated:42,extensions:['-/tmp/web.ts']});
 writeFileSync(path,'broken');
 assert.throws(() => patchJson(path, () => ({})));
 assert.equal(readFileSync(path,'utf8'),'broken');
});
test('discovers entrypoints, not helper directories', () => {
 const dir = join(home,'discovery'); mkdirSync(dir); mkdirSync(join(dir,'nested')); mkdirSync(join(dir,'shared'));
 writeFileSync(join(dir,'one.ts'),''); writeFileSync(join(dir,'nested/index.ts'),''); writeFileSync(join(dir,'shared/helper.ts'),'');
 assert.equal(discover(dir).length,2);
});
test('only registers /extensions and preserves the copy shortcut', () => {
 const h = harness(); assert.deepEqual([...h.commands.keys()],['extensions']);
 assert.ok(h.shortcuts.has('ctrl+shift+x')); assert.ok(!h.shortcuts.has('ctrl+x'));
});
test('width is capped at 104 and height increases from 30 to 45 rows', async () => {
 const h = harness(); await open(h); assert.equal(h.options.overlayOptions.width,104);
 for (const width of [28,40,60,90,120,200]) {
  for (const line of h.component.render(width)) assert.ok(tui.visibleWidth(line) <= Math.min(104,width));
 }
 for (const rows of [10,16,20,24,40,60,100]) {
  h.terminal.rows = rows;
  assert.ok(h.component.render(100).length <= Math.min(rows - 1,45), `height ${rows}`);
 }
 assert.equal(h.component.render(100).length,45);
 assert.ok(!text(h).includes('builtin:read'));
});
test('Enter focuses details; arrows scroll without changing selection; Escape returns', async () => {
 const h = harness(); await open(h); await h.component.handleInput('\t');
 const before = text(h); assert.ok(before.includes('● Items'));
 await h.component.handleInput('\r'); const focused = text(h); assert.ok(focused.includes('● Details · selected'));
 await h.component.handleInput('\x1b[B');
 assert.notEqual(text(h),focused);
 assert.equal(h.toolCalls,0); assert.equal(h.editorChanges,0);
 await h.component.handleInput('\x1b[A'); assert.ok(text(h).includes('Details 1–'));
 await h.component.handleInput('\x1b'); assert.ok(text(h).includes('● Items')); assert.equal(h.closed,false);
 await h.component.handleInput('\x1b[B'); assert.ok(text(h).includes('Still callable'));
 await h.component.handleInput('\x1b'); assert.equal(h.closed,true);
});
test('Enter on an extension never launches or prepares a command', async () => {
 const h = harness(); await open(h);
 await h.component.handleInput('\r'); await h.component.handleInput('\r');
 assert.equal(h.editorChanges,0); assert.equal(h.closed,false);
 assert.ok(text(h).includes('/web'));
});
test('Space switches tools, but not while the agent is busy', async () => {
 const h = harness(); await open(h); await h.component.handleInput('\t'); await h.component.handleInput(' ');
 assert.deepEqual(h.active,['search']);
 const running = harness({busy:true}); await open(running);
 await running.component.handleInput('\t'); await running.component.handleInput(' ');
 assert.equal(running.toolCalls,0); assert.ok(text(running).includes('finish'));
});
test('search and clear work', async () => {
 const h = harness(); await open(h); await h.component.handleInput('/');
 for (const char of 'zzznomatch') await h.component.handleInput(char);
 await h.component.handleInput('\r'); assert.ok(text(h).includes('No matches'));
 await h.component.handleInput('\x7f'); assert.ok(!text(h).includes('No matches'));
});
test('extension loading changes preserve settings and require confirmation', async () => {
 writeFileSync(join(home,'settings.json'),JSON.stringify({unrelated:42,extensions:[]}));
 const h = harness(); let confirmations = 0;
 h.ctx.ui.confirm = async () => { confirmations++; return false; };
 await open(h); await h.component.handleInput(' '); assert.equal(confirmations,1);
 assert.deepEqual(JSON.parse(readFileSync(join(home,'settings.json'),'utf8')).extensions,[]);
 h.ctx.ui.confirm = async () => true; await h.component.handleInput(' ');
 assert.deepEqual(JSON.parse(readFileSync(join(home,'settings.json'),'utf8')), {unrelated:42,extensions:['-/tmp/web.ts']});
 assert.ok(text(h).includes('/reload'));
});
test('light and dark themes work without a custom palette or promotional text', async () => {
 for (const appearance of ['light','dark']) {
  const h = harness({appearance}); await open(h);
  h.component.render(40); await h.component.handleInput('\r');
  assert.ok(strip(h.component.render(40).join('\n')).includes('Web'));
  await h.component.handleInput('\t'); await h.component.handleInput('\t');
  const output = text(h);
  assert.ok(!/atelier|clay|sage|Palette|make space|\bwarm\b/i.test(output));
  assert.ok(output.includes('List Density'));
 }
});
test('inline editor stays open and Escape returns through settings and details', async () => {
 const h = harness({extensionPath:'/tmp/notify.ts'}); await open(h);
 await focusSettings(h);
 assert.ok(text(h).includes('Settings · editing'));
 await h.component.handleInput('\x1b'); assert.equal(h.closed,false);
 assert.ok(text(h).includes('● Details · selected'));
 await h.component.handleInput('\x1b'); assert.equal(h.closed,false);
 assert.ok(text(h).includes('● Items'));
});
test('technical metadata is hidden until requested', async () => {
 const h = harness(); await open(h);
 assert.ok(!text(h).includes('/tmp/web.ts'));
 await h.component.handleInput('d'); assert.ok(text(h).includes('/tmp/web.ts'));
 await h.component.handleInput('d'); assert.ok(!text(h).includes('/tmp/web.ts'));
});
test('right focuses the pane, Settings is reached with arrows, left returns to list', async () => {
 const h = harness({extensionPath:'/tmp/notify.ts'}); await open(h);
 const initial = text(h); assert.ok(initial.includes('● Items'));
 await h.component.handleInput('\x1b[C');
 const active = text(h); assert.ok(active.includes('● Details · selected'));
 assert.ok(!active.includes('Settings · editing'));
 for(let i=0;i<60 && !text(h).includes('› Settings  →');i++) await h.component.handleInput('\x1b[B');
 assert.ok(text(h).includes('Enter edit settings'));
 await h.component.handleInput('\r'); assert.ok(text(h).includes('● Settings · editing'));
 await h.component.handleInput('\x1b'); assert.ok(text(h).includes('› Settings  →'));
 await h.component.handleInput('\x1b[D'); assert.ok(text(h).includes('● Items'));
 assert.equal(h.closed,false);
});
test('Enter changes global settings from the right pane', async () => {
 const h = harness(); await open(h); await h.component.handleInput('\t'); await h.component.handleInput('\t');
 await h.component.handleInput('\x1b[C'); const before=text(h);
 await h.component.handleInput('\r'); assert.notEqual(text(h),before);
});
if (process.env.EXTENSIONS_PREVIEW) {
 const h = harness({extensionPath:'/tmp/notify.ts'}); await open(h); h.terminal.rows=42;
 await focusSettings(h);
 writeFileSync('/tmp/extensions-preview.txt',strip(h.component.render(104).join('\n')));
}
