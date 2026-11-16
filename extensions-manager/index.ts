import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { globalSettings, extensionSettings, getSetting, setSetting, type Setting } from './settings';

type Prefs = { compact: boolean; rememberTools: boolean; disabledTools: string[] };
type Item = { id: string; name: string; description: string; path?: string; tool?: ToolInfo; commands?: ReturnType<ExtensionAPI['getCommands']>; observed?: boolean; setting?: Setting };
const defaults: Prefs = { compact: false, rememberTools: false, disabledTools: [] };
const descriptions: Record<string, string> = {
 'extensions': 'Browse extensions, inspect tools, and change loading and display settings.',
 'permission-gate': 'Requests approval before potentially dangerous shell commands.',
 'protected-paths': 'Blocks tool writes and edits to secrets and generated directories.',
 'git-checkpoint': 'Creates stash checkpoints so session forks can restore working code.',
 'clear-on-quit': 'Clears the terminal when Pi exits.',
 'notify': 'Plays a sound when Pi finishes or needs attention.',
 'gondolin': 'Runs tools in a micro-VM. Changes to host-backed workspace files still affect the host.',
 'file-explorer': 'Shows a file tree and Git status beside the conversation.',
 'git-changes': 'Shows diffs and supports staging and unstaging changes.',
 'session-time-limit': 'Sets a per-prompt time limit.',
 'status-footer': 'Shows Git status, context usage, cost, and model information in the footer.',
 'deepseek-web': 'Searches the web and reads public pages through DeepSeek. Requests count toward a session budget.',
 'questionnaire': 'Asks multiple-choice questions, including multi-question forms.',
 'btw': 'Answers side questions in an overlay without adding them to the conversation context.',
 'commit-gate': 'Requests approval before the agent creates a Git commit.',
};
const usage: Record<string, string[]> = {
 'extensions': ['/extensions or Ctrl+Shift+X opens this panel.'],
 'file-explorer': ['Ctrl+F opens the file tree. The . key toggles hidden files.'],
 'git-changes': ['Ctrl+G opens source control. The . key toggles ignored files.'],
 'session-time-limit': ['/time-limit opens the clock settings.', '/time-limit 10m sets ten minutes per prompt.', '/time-limit off removes the limit for this session.'],
 'deepseek-web': ['/web status shows usage and budget.', '/web on or /web off switches the web tools.'],
 'status-footer': ['/footer switches between the custom footer and the built-in footer.'],
};

// Read fresh settings for each update, preserving unrelated fields.
export function patchJson(path: string, update: (value: any) => any) {
 const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
 const next = update(value);
 const temp = `${path}.extensions-${process.pid}.tmp`;
 writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
 renameSync(temp, path);
}
export function discover(directory: string): string[] {
 if (!existsSync(directory)) return [];
 return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name.startsWith('.')) return [];
  const path = join(directory, entry.name);
  if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) return [path];
  if (!entry.isDirectory()) return [];
  for (const name of ['index.ts', 'index.js']) if (existsSync(join(path, name))) return [join(path, name)];
  return [];
 });
}
function title(path: string) { return basename(path).startsWith('index.') ? basename(dirname(path)) : basename(path).replace(/\.[^.]+$/, ''); }
function clean(text: string) { return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
function displayName(name: string) { return name.replace(/^builtin:/,'').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).replace(/\bMcp\b/g,'MCP').replace(/\bApi\b/g,'API').replace(/Deepseek/g,'DeepSeek'); }
function displayValue(value: unknown) { return value === true ? 'On' : value === false ? 'Off' : String(value).replace(/-/g,' '); }

export default function extensionsManager(pi: ExtensionAPI) {
 const agentDir = getAgentDir();
 const configPath = join(agentDir, 'extensions-manager.json');
 const settingsPath = join(agentDir, 'settings.json');
 let prefs = { ...defaults };
 try {
  // Read the previous config once if this is an upgrade; never use its palette.
  const source = existsSync(configPath) ? configPath : join(agentDir, 'atelier.json');
  const saved = JSON.parse(readFileSync(source, 'utf8'));
  prefs = { compact: saved.compact === true, rememberTools: saved.rememberTools === true,
   disabledTools: Array.isArray(saved.disabledTools) ? saved.disabledTools.filter((n: unknown) => typeof n === 'string') : [] };
 } catch { /* Missing or invalid preferences: use defaults. */ }
 let open = false;
 const save = () => patchJson(configPath, () => prefs);
 const restore = () => {
  if (prefs.rememberTools) pi.setActiveTools(pi.getActiveTools().filter(name => !prefs.disabledTools.includes(name)));
 };
 pi.on('session_start', restore);
 pi.on('before_agent_start', restore);

 async function show(ctx: ExtensionContext) {
  if (ctx.mode !== 'tui') { ctx.ui.notify('Extensions requires interactive mode.', 'info'); return; }
  if (open) return;
  open = true;
  try {
   const tools = pi.getAllTools();
   const commands = pi.getCommands().filter(c => c.source === 'extension');
   const paths = new Set(discover(join(agentDir, 'extensions')));
   if (ctx.isProjectTrusted()) for (const p of discover(join(ctx.cwd, '.pi', 'extensions'))) paths.add(p);
   for (const entry of [...tools, ...commands]) {
    const path = entry.sourceInfo.path;
    if (path && !path.startsWith('<') && entry.sourceInfo.source !== 'sdk' &&
     (entry.sourceInfo.source !== 'builtin' || ['builtin:mcp', 'builtin:codemode', 'builtin:tool-search', 'builtin:llama.cpp'].includes(path))) paths.add(path);
   }
   const extensions: Item[] = [...paths].map(path => {
    const owned = commands.filter(c => c.sourceInfo.path === path);
    const name = title(path) === 'extensions-manager' ? 'extensions' : title(path);
    return { id: path, path, name, commands: owned,
     observed: owned.length > 0 || tools.some(t => t.sourceInfo.path === path),
     description: descriptions[name] ?? (owned.map(c => c.description).filter(Boolean).join(' · ') || 'No description registered. See the extension source or README.') };
   }).sort((a,b) => Number(a.path?.startsWith('builtin:')) - Number(b.path?.startsWith('builtin:')) || a.name.localeCompare(b.name));
   const exclusions = new Set<string>((pi.getSettings().extensions ?? []).filter((p: string) => p.startsWith('-')).map((p: string) => p.slice(1)));
   await ctx.ui.custom<void>((tui, theme, kb, done) => {
    let tab = 0, selected = 0, detailOffset = 0, searching = false, detailsFocused = false, focused = true;
    let message = '', settingsFocused = false, selectedSetting = 0, technical = false;
    let detailCursor = 0, detailLength = 1, settingsEntry = -1;
    const effective: any = pi.getSettings();
    const currentSetting = (s: Setting) => getSetting(effective,s.key) ?? s.fallback;
    const changeSetting = (setting: Setting, direction = 1) => {
     const index = setting.values.indexOf(currentSetting(setting));
     const next = setting.values[(Math.max(0,index)+direction+setting.values.length)%setting.values.length];
     patchJson(settingsPath,data=>setSetting(data,setting.key,next));
     setSetting(effective,setting.key,next);
     message = 'Saved · reload to apply';
    };
    const search = new Input();
    const tabs = ['Extensions', 'Tools', 'Settings'];
    const settings: Item[] = [
     { id: 'compact', name: 'List density', description: 'Compact shows one row per item. Spacious adds a blank row. Saved globally.' },
     { id: 'rememberTools', name: 'Remember tool switches', description: 'Keep tools switched off here disabled on future turns and restarts. Otherwise, switches affect only the current runtime. This controls model visibility, not security permissions.' },
     { id: 'expanded', name: 'Tool output', description: 'Expand or collapse tool results in the current session.' },
     ...globalSettings.map(setting => ({id:setting.key,name:setting.name,description:setting.description,setting})),
    ];
    const list = (): Item[] => (tab === 0 ? extensions : tab === 1 ? tools.map(tool => ({ id: tool.name, name: tool.name, description: tool.description, tool })) : settings)
     .filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.getValue().toLowerCase()));
    const refresh = () => tui.requestRender();
    const disabled = (item: Item) => item.path ? exclusions.has(item.path) : item.tool ? !pi.getActiveTools().includes(item.id) : false;
    const value = (item: Item) => item.setting ? displayValue(currentSetting(item.setting)) : item.id === 'expanded' ? (ctx.ui.getToolsExpanded() ? 'expanded' : 'collapsed') : item.id === 'compact' ? (prefs.compact ? 'compact' : 'spacious') : prefs.rememberTools ? 'on' : 'off';
    const toggle = async () => {
     const item = list()[selected]; if (!item) return;
     if (tab === 0) {
      if (item.name === 'extensions') { message = 'This panel cannot disable itself.'; return; }
      const enabling = disabled(item);
      if (!await ctx.ui.confirm(`${enabling ? 'Enable' : 'Disable'} ${item.name}?`, enabling ? 'Save an exact inclusion. Run /reload to apply.' : 'This may remove safety hooks or integrations. Run /reload to apply. Reloading may restart the sandbox.')) return;
      patchJson(settingsPath, data => ({ ...data, extensions: [...(data.extensions ?? []).filter((p: string) => p !== `-${item.path}` && p !== `+${item.path}`), `${enabling ? '+' : '-'}${item.path}`] }));
      enabling ? exclusions.delete(item.path!) : exclusions.add(item.path!);
      message = 'Saved. Run /reload to apply.';
     } else if (tab === 1) {
      if (!ctx.isIdle()) { message = 'Wait for the current response to finish before changing tools.'; return; }
      if (item.tool?.exposure === 'hidden') { message = 'Hidden tools cannot be activated.'; return; }
      const active = pi.getActiveTools();
      const off = active.includes(item.id);
      pi.setActiveTools(off ? active.filter(n => n !== item.id) : [...active, item.id]);
      prefs.disabledTools = off ? [...new Set([...prefs.disabledTools, item.id])] : prefs.disabledTools.filter(n => n !== item.id);
      save();
      message = `${item.name}: ${off ? 'off' : 'on'}. ${prefs.rememberTools ? 'Saved for future sessions.' : 'Current runtime only.'}`;
     } else {
      if (item.setting) {
       const s = item.setting;
       const index = s.values.indexOf(currentSetting(s));
       const next = s.values[(index+1)%s.values.length];
       patchJson(settingsPath,data=>setSetting(data,s.key,next));
       setSetting(effective,s.key,next);
       message = 'Saved globally. Run /reload to apply. Project settings may override this value.';
       return;
      }
      if (item.id === 'expanded') ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
      else if (item.id === 'compact') prefs.compact = !prefs.compact;
      else prefs.rememberTools = !prefs.rememberTools;
      save(); message = 'Settings saved.';
     }
    };
    let busy = false;
    return {
     get focused() { return focused; },
     set focused(value: boolean) { focused = value; search.focused = value && searching; },
     capturesViewportInput: true,
     invalidate() { search.invalidate(); },
     async handleInput(data: string) {
      if (busy) return;
      if (searching) {
       if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm')) { searching = false; search.focused = false; }
       else search.handleInput(data);
       selected = 0; detailOffset = 0; detailCursor = 0; refresh(); return;
      }
      if (kb.matches(data, 'tui.select.cancel') && settingsFocused) { settingsFocused = false; refresh(); return; }
      if (kb.matches(data, 'tui.select.cancel') && detailsFocused) { detailsFocused = false; refresh(); return; }
      if (kb.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+shift+x')) { done(); return; }
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
       tab = (tab + (matchesKey(data, 'shift+tab') ? 2 : 1)) % 3;
       selected = 0; detailOffset = 0; detailCursor = 0; detailsFocused = false; settingsFocused = false; selectedSetting = 0; message = '';
      } else if (kb.matches(data, 'tui.select.up') || data === 'k') {
       if (settingsFocused) selectedSetting = Math.max(0,selectedSetting-1);
       else if (detailsFocused) detailCursor = Math.max(0, detailCursor - 1);
       else { selected = Math.max(0, selected - 1); detailOffset = 0; detailCursor = 0; message = ''; }
      } else if (kb.matches(data, 'tui.select.down') || data === 'j') {
       if (settingsFocused) selectedSetting = Math.min((extensionSettings[list()[selected]?.name] ?? []).length-1,selectedSetting+1);
       else if (detailsFocused) detailCursor = Math.min(detailLength-1, detailCursor+1);
       else { selected = Math.min(list().length - 1, selected + 1); detailOffset = 0; detailCursor = 0; message = ''; }
      } else if (detailsFocused && !settingsFocused && detailCursor === settingsEntry && settingsEntry >= 0 && data === ' ') {
       settingsFocused = true; selectedSetting = 0;
      } else if (settingsFocused && (matchesKey(data,'left') || matchesKey(data,'right') || kb.matches(data,'tui.select.confirm') || data === ' ')) {
       const setting = (extensionSettings[list()[selected]?.name] ?? [])[selectedSetting];
       if (setting) { try { changeSetting(setting,matchesKey(data,'left') ? -1 : 1); } catch(error) { message = `Could not save: ${String(error)}`; } }
      } else if (matchesKey(data, 'left') && detailsFocused) detailsFocused = false;
      else if (kb.matches(data, 'tui.select.confirm') || matchesKey(data, 'right')) {
       if (detailsFocused && tab === 2) { try { await toggle(); } catch(error) { message = `Could not save: ${String(error)}`; } }
       else if (detailsFocused && detailCursor === settingsEntry && settingsEntry >= 0) { settingsFocused = true; selectedSetting = 0; }
       detailsFocused = true;
      } else if (data === 'd') technical = !technical;
      else if (data === '/') { searching = true; detailsFocused = false; settingsFocused = false; search.focused = focused; }
      else if (matchesKey(data, 'backspace')) { search.setValue(''); selected = 0; detailOffset = 0; }
      else if (data === ' ') {
       busy = true;
       try { await toggle(); } catch (error) { message = `Could not save: ${String(error)}`; }
       finally { busy = false; }
      }
      refresh();
     },
     render(width: number) {
      const paint = (text: string, role: 'text'|'accent'|'muted'|'border' = 'text', selectedRow = false) => selectedRow
       ? theme.style(text, { fg: 'text', bg: 'userMessageBg' }) : theme.fg(role, text);
      const fit = (s: string, w: number) => { const t = truncateToWidth(s, Math.max(0,w)); return t + ' '.repeat(Math.max(0, w - visibleWidth(t))); };
      const w = Math.max(1, Math.min(104, width)), inner = Math.max(0,w-4);
      const narrow = w < 68;
      const frame = (s: string) => paint('│ ', 'border') + fit(s,inner) + paint(' │','border');
      // Previous maximum was 30 rows. Use 45 rows, constrained by the terminal.
      const height = Math.min(45, Math.max(8, tui.terminal.rows - 2));
      const available = Math.max(1, height - 8);
      const items = list(); selected = Math.max(0, Math.min(selected, items.length-1));
      const item = items[selected];
      const lw = Math.min(29, Math.max(22, Math.floor(inner * .32)));
      const rw = Math.max(1, narrow ? inner : inner-lw-3);
      const measure = Math.max(1, rw-4);
      const details: string[] = [], settingPositions: number[] = [];
      const add = (text: string) => details.push(...wrapTextWithAnsi(clean(text),measure));
      const heading = (text: string) => details.push(theme.bold(text));
      settingsEntry = -1;
      if (item) {
       heading(displayName(item.name)); details.push(''); add(item.description); details.push('');
       if (tab === 0) {
        details.push(paint(exclusions.has(item.id) ? 'Disabled on reload' : item.observed ? 'Loaded' : 'Local extension · load status unverified','muted'));
        const options = extensionSettings[item.name] ?? [];
        if (options.length) {
         details.push(''); settingsEntry = details.length; heading('Settings  →');
         details.push(paint(settingsFocused ? 'Reload to apply changes' : 'Enter to edit · reload to apply','muted')); details.push('');
         options.forEach((setting,index) => {
          settingPositions.push(details.length);
          const label = fit(`${settingsFocused && index === selectedSetting ? '›' : ' '} ${setting.name}`,Math.max(1,measure-15));
          const raw = currentSetting(setting);
          const value = setting.key.endsWith('.volume') ? `${Number((Number(raw)*100).toFixed(1))}%` : setting.key.endsWith('.minutes') ? `${raw} min` : displayValue(raw);
          details.push(paint(fit(`${label}  ${settingsFocused && index === selectedSetting ? '‹ ' : ''}${value}${settingsFocused && index === selectedSetting ? ' ›' : ''}`,measure),'text',settingsFocused && index === selectedSetting));
          details.push('');
         });
         if (settingsFocused) { add(options[selectedSetting]?.description ?? ''); details.push(''); }

        }
        details.push(''); heading('Commands');
        for (const c of item.commands ?? []) add(`/${c.name} — ${c.description ?? ''}`);
        if (!item.commands?.length) add('Runs automatically; no commands.');
        for (const hint of usage[item.name] ?? []) { details.push(''); add(hint); }
        if (technical) { details.push(''); heading('Technical details'); add('Global loading rules apply after reload. Project and CLI rules can override them.'); details.push(''); add(item.path!); }
       } else if (tab === 1) {
        details.push(paint(`Model access: ${disabled(item) ? 'Off' : 'On'}`,'muted'));
        if (technical) add(`Exposure: ${item.tool!.exposure ?? 'direct'}`);
        if (['codemode','deferred'].includes(item.tool!.exposure ?? '')) add('Still callable through other tools when model visibility is off.');
        details.push(''); heading('Parameters'); details.push('');
        const schema = item.tool!.parameters as any;
        for (const [name, prop] of Object.entries(schema?.properties ?? {}) as [string, any][]) {
         heading(`${name}${schema.required?.includes(name) ? ' · required' : ' · optional'}`);
         details.push(paint(`${prop.type ?? 'value'}${prop.enum ? ` · ${prop.enum.join(', ')}` : ''}`,'muted'));
         if (prop.description) add(prop.description);
         details.push('');
        }
        if (technical) { details.push(''); heading('Technical details'); add('Model visibility is not a security permission.'); add(item.tool!.sourceInfo.path); }
       } else {
        heading(`‹  ${item.setting ? displayValue(currentSetting(item.setting)) : value(item)}  ›`);
        details.push(''); details.push(paint('Space changes this setting','muted'));
        details.push(''); add(item.setting ? 'Saved globally. Reload to apply.' : 'Applies immediately.');
        if (technical && item.setting) { details.push(''); add(item.setting.key); add('Project settings may override this value.'); }
       }
      } else add('No matches. Backspace clears the filter.');
      detailLength = Math.max(1,details.length);
      detailCursor = Math.min(detailCursor, detailLength-1);
      if (detailsFocused && !settingsFocused) {
       if (detailCursor < detailOffset) detailOffset = detailCursor;
       if (detailCursor >= detailOffset+available) detailOffset = detailCursor-available+1;
      }
      if (settingsFocused) {
       const position = settingPositions[selectedSetting] ?? 0;
       if (position < detailOffset) detailOffset = position;
       if (position >= detailOffset+available-1) detailOffset = Math.max(0,position-available+2);
      }
      detailOffset = Math.min(detailOffset, Math.max(0, details.length-available));
      const navigation: {index?:number;heading?:string}[] = [];
      let previousGroup = '';
      items.forEach((entry,index) => {
       const group = tab === 0 ? (entry.path?.startsWith('builtin:') ? 'Built-in' : 'Your extensions') : tab === 1 ? 'Available tools' : 'Preferences';
       if (group !== previousGroup) { navigation.push({heading:group}); previousGroup=group; }
       navigation.push({index});
       if (!prefs.compact) navigation.push({});
      });
      const selectedRow = navigation.findIndex(row=>row.index===selected);
      const start = Math.max(0,Math.min(selectedRow-Math.floor(available/2),navigation.length-available));
      const lines = [paint(`╭${'─'.repeat(Math.max(0,w-2))}╮`, 'border'), frame(theme.bold('Extensions')), frame(tabs.map((name,i) => i === tab ? theme.bold(paint(narrow ? name.slice(0,3) : name,'accent')) : paint(narrow ? name.slice(0,3) : name,'muted')).join('    ')), frame(searching ? search.render(inner)[0] : paint(search.getValue() ? `Filter: ${search.getValue()}` : '/ Search', 'muted')), frame(narrow ? paint(settingsFocused ? 'Settings · editing' : detailsFocused ? 'Details · selected' : 'Extensions · selected','accent') : paint(fit(detailsFocused ? 'Items' : '● Items',lw),detailsFocused ? 'muted' : 'accent') + paint(' │ ',detailsFocused ? 'accent' : 'border') + paint(settingsFocused ? '● Settings · editing' : detailsFocused ? '● Details · selected' : 'Details',detailsFocused ? 'accent' : 'muted'))];
      for (let row=0; row<available; row++) {
       const nav = navigation[start+row];
       const idx = nav?.index ?? -1, entry = items[idx];
       const listWidth = narrow ? inner : lw;
       let left = '';
       if (nav?.heading) left = paint(fit(nav.heading,listWidth),'muted');
       if (entry) {
        const state = disabled(entry) ? 'off' : '';
        const name = fit(`${idx === selected ? '›' : ' '} ${displayName(entry.name)}`, Math.max(0,listWidth-4));
        left = paint(fit(`${name} ${state}`,listWidth),'text',idx === selected && !detailsFocused);
       }
       const lineIndex = row+detailOffset;
       const activeLine = detailsFocused && !settingsFocused && lineIndex === detailCursor;
       const marker = activeLine ? paint('› ','accent') : '  ';
       const content = fit(details[lineIndex] ?? '',Math.max(0,rw-3));
       const right = ' ' + marker + paint(content,'text',activeLine && lineIndex === settingsEntry);
       lines.push(frame(narrow ? (detailsFocused ? right : left) : fit(left,lw) + paint(' │ ',detailsFocused ? 'accent' : 'border') + right));
      }
      const position = detailsFocused ? `Details ${detailOffset+1}–${Math.min(details.length,detailOffset+available)} / ${details.length}` : `${items.length ? selected+1 : 0} / ${items.length}`;
      lines.push(frame(paint(message || position,'muted')), frame(paint(settingsFocused ? '↑↓ choose   ←→ change   Esc back to details' : detailsFocused ? (tab === 2 ? '↑↓ read    Enter change    ← list    Esc back' : detailCursor === settingsEntry && settingsEntry >= 0 ? 'Enter edit settings    ↑↓ navigate    ← list    Esc back' : '↑↓ navigate    ← list    Esc back') : narrow ? '↑↓ select · → details · Tab sections' : '↑↓ select    → details    Tab sections    Space switch    d technical    Esc close','muted')), paint(`╰${'─'.repeat(Math.max(0,w-2))}╯`,'border'));
      return lines.map(line => truncateToWidth(line,w));
     },
    };
   }, { overlay: true, overlayOptions: { anchor: 'center', width: 104, maxHeight: '100%', margin: 1 } });
  } finally { open = false; }
 }
 pi.registerCommand('extensions', { description: 'Manage extensions, tools, and settings', handler: async (_args,ctx) => show(ctx) });
 pi.registerShortcut('ctrl+shift+x', { description: 'Open Extensions', handler: show });
}
