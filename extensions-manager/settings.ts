export type Setting = { key: string; name: string; description: string; values: (string|number|boolean)[]; fallback: string|number|boolean };
const bool = (key: string, name: string, description: string, fallback = true): Setting => ({key,name,description,values:[true,false],fallback});
export const globalSettings: Setting[] = [
 bool('hideThinkingBlock','Hide thinking','Hide thinking blocks in the transcript.',false),
 {key:'quietStartup',name:'Startup display',description:'false shows startup information; header hides resource lists; true hides both.',values:[false,'header',true],fallback:false},
 {key:'cacheWarming',name:'Prompt cache warming',description:'Keep eligible prompt caches warm. May incur API charges.',values:['off','streaming','idle'],fallback:'idle'},
 bool('showCacheMissNotices','Cache notices','Show cache misses, compaction, and recovery notices.',false),
 {key:'editorPaddingX',name:'Editor padding',description:'Horizontal editor padding in cells.',values:[0,1,2,3],fallback:0},
 {key:'outputPad',name:'Transcript padding',description:'Horizontal padding around messages and tool output.',values:[0,1],fallback:1},
 {key:'autocompleteMaxVisible',name:'Autocomplete rows',description:'Maximum visible autocomplete entries.',values:[3,5,8,12,20],fallback:5},
 bool('showHardwareCursor','Hardware cursor','Use the terminal cursor instead of the drawn cursor.',false),
 bool('terminal.showImages','Inline images','Display images in supported terminals.'),
 {key:'fullscreenScrollbar',name:'Scrollbar',description:'Fullscreen transcript scrollbar visibility.',values:['auto','always','hidden'],fallback:'auto'},
 bool('fullscreenCopyOnSelect','Copy on selection','Automatically copy selected transcript text.'),
 bool('compaction.enabled','Automatic compaction','Compact context automatically when needed.'),
 bool('retry.enabled','Automatic retry','Retry transient agent failures.'),
 {key:'doubleEscapeAction',name:'Double Escape',description:'Action when Escape is pressed twice with an empty editor.',values:['tree','fork','none'],fallback:'tree'},
 {key:'markdown.mermaid',name:'Mermaid diagrams',description:'Render diagrams while streaming, only when finished, or never.',values:['off','final','streaming'],fallback:'streaming'},
];
const pref = (extension: string, setting: Setting): Setting => ({...setting,key:`extensionPreferences.${extension}.${setting.key}`});
export const extensionSettings: Record<string, Setting[]> = {
 notify: [bool('completion','Completion sound','Play a sound when a response finishes.'),bool('permission','Permission sound','Play a sound when the agent requests input.'),{key:'volume',name:'Volume',description:'macOS playback volume.',values:[0.03,0.06,0.102,0.2,0.4],fallback:0.102}].map(s=>pref('notify',s)),
 'clear-on-quit': [bool('screen','Clear screen','Clear the terminal screen when Pi exits.'),bool('scrollback','Clear scrollback','Clear terminal scrollback when Pi exits.')].map(s=>pref('clear-on-quit',s)),
 'git-checkpoint': [bool('enabled','Create checkpoints','Create Git stash checkpoints at turn start.'),bool('restorePrompt','Offer restore on fork','Ask whether to restore a checkpoint when forking. Never restores without approval.')].map(s=>pref('git-checkpoint',s)),
 'status-footer': [bool('enabled','Custom footer','Use the custom status footer.'),bool('showClock','Show clock','Show the current time in the footer.'),bool('showCost','Show cost','Show session API cost in the footer.')].map(s=>pref('status-footer',s)),
 'session-time-limit': [bool('sessionTimeLimit.enabled','Time limit enabled','Enable the per-prompt time budget.'),{key:'sessionTimeLimit.minutes',name:'Default minutes',description:'Default prompt budget. A resumed session may retain its own limit.',values:[2,5,10,15,30,60],fallback:5}],
};
export function getSetting(data: any, key: string): any { return key.split('.').reduce((value,part)=>value?.[part],data); }
export function setSetting(data: any, key: string, value: any) {
 const parts=key.split('.'); let target=data;
 for (const part of parts.slice(0,-1)) { target[part] = {...(target[part] && typeof target[part] === 'object' ? target[part] : {})}; target=target[part]; }
 target[parts.at(-1)!]=value;
 return data;
}
