// English command grammar (plans 06 voice-commands.md). Data only: voice-commands.ts compiles
// it. Order matters: the first entry whose pattern matches and whose gate holds wins.
//
// Pattern syntax, matched against the whole normalized utterance:
//   (a|b)      alternatives        [ x]   optional (put the leading space inside)
//   <n> <m>    number slots        <dir>  up|down|left|right
//   <text>     free text (taken from the original utterance, punctuation kept)
//   <keys>     key names           <role> links|buttons|fields|menus|tabs
//   <app>      app name            <amount> a little|a lot

/** State a command needs before it applies; outside it the utterance falls through. */
export type Gate =
  | 'marks'
  | 'grid'
  | 'grid-drag'
  | 'no-guide'
  | 'autoscroll'
  | 'busy-target'
  | 'answer'
  /** Help sheet only: guide voice navigation (guides/voice-nav.ts) runs before the grammar. */
  | 'guide'
  /** "Read the page" is reading or paused. */
  | 'reading'
  /** A screen description was just given ("more detail"). */
  | 'described'
  /** Help sheet only: lesson commands (teach/commands.ts) run before the grammar in a lesson. */
  | 'lesson'
  /** An answer is on screen or was in the last two minutes ("repeat that", "copy the answer"). */
  | 'recent-answer'
  /** The bar's notice has an Undo button (dictation command mode). */
  | 'notice-undo'
  /** The bar's notice has an Unmute button (sound output muted). */
  | 'notice-unmute'

export type Category =
  | 'numbers'
  | 'grid'
  | 'pointer'
  | 'scroll'
  | 'keyboard'
  | 'navigation'
  | 'windows'
  | 'lumen'
  | 'guide'
  | 'reading'

export interface GrammarEntry {
  id: string
  category: Category
  patterns: string[]
  /** Fixed args merged into the slot args. */
  args?: Record<string, string | number | boolean>
  gate?: Gate
  /** Example phrasings for the help sheet. */
  say: string
  /** What it does, for the help sheet. */
  does: string
}

export const GRAMMAR: GrammarEntry[] = [
  // ---- Reading aloud (gated, first: "stop" while reading stops the reading) ----
  {
    id: 'read.stop',
    category: 'reading',
    patterns: ['(stop|stop reading|stop it|be quiet|quiet|thats enough|enough)'],
    gate: 'reading',
    say: 'stop reading',
    does: 'Stop reading'
  },
  {
    id: 'read.pause',
    category: 'reading',
    patterns: ['(pause|pause reading|wait|hold on)'],
    gate: 'reading',
    say: 'pause',
    does: 'Pause the reading'
  },
  {
    id: 'read.continue',
    category: 'reading',
    patterns: ['(continue|continue reading|resume|resume reading|keep reading|go on|carry on)'],
    gate: 'reading',
    say: 'continue',
    does: 'Go on reading'
  },
  {
    id: 'read.skip',
    category: 'reading',
    patterns: ['(next|skip|skip that|next part|next paragraph)'],
    args: { by: 1 },
    gate: 'reading',
    say: 'next',
    does: 'Skip to the next part'
  },
  {
    id: 'read.skip',
    category: 'reading',
    patterns: ['(back|go back|previous|previous part|previous paragraph|repeat|say that again)'],
    args: { by: -1 },
    gate: 'reading',
    say: 'repeat',
    does: 'Read the last part again'
  },
  {
    id: 'describe.screen',
    category: 'reading',
    patterns: ['(more detail|more details|tell me more|in detail|describe it in detail)'],
    args: { detail: 'full' },
    gate: 'described',
    say: 'more detail',
    does: 'Describe the screen in full'
  },

  // ---- Mouse grid (gated, so it runs before numbers and pointer) ----
  {
    id: 'grid.select',
    category: 'grid',
    patterns: ['[(number|box|cell) ]<n>'],
    gate: 'grid',
    say: '1 to 9',
    does: 'Zoom into that box'
  },
  {
    id: 'grid.act',
    category: 'grid',
    patterns: ['[left ]click'],
    args: { action: 'click' },
    gate: 'grid',
    say: 'click',
    does: 'Click the middle of the grid'
  },
  {
    id: 'grid.act',
    category: 'grid',
    patterns: ['double click'],
    args: { action: 'double' },
    gate: 'grid',
    say: 'double click',
    does: 'Double click the middle of the grid'
  },
  {
    id: 'grid.act',
    category: 'grid',
    patterns: ['right click'],
    args: { action: 'right' },
    gate: 'grid',
    say: 'right click',
    does: 'Right click the middle of the grid'
  },
  {
    id: 'grid.drop',
    category: 'grid',
    patterns: ['(drop|drag here|drop here|release)'],
    gate: 'grid-drag',
    say: 'drop',
    does: 'Finish the drag here'
  },
  {
    id: 'grid.mark',
    category: 'grid',
    patterns: ['(drag|mark|start drag|drag from here)'],
    gate: 'grid',
    say: 'drag',
    does: 'Start a drag here'
  },
  {
    id: 'grid.up',
    category: 'grid',
    patterns: ['(undo|back|go back|up|zoom out)'],
    gate: 'grid',
    say: 'back',
    does: 'Go up one grid level'
  },
  {
    id: 'grid.close',
    category: 'grid',
    patterns: ['(cancel|close grid|hide grid|close|stop|exit grid|no grid)'],
    gate: 'grid',
    say: 'close grid',
    does: 'Close the grid'
  },
  {
    id: 'grid.show',
    category: 'grid',
    patterns: [
      '(mouse grid|grid|show grid|show mouse grid)[ (on )?(monitor |screen |display )?<n>]'
    ],
    say: 'mouse grid, mouse grid 2',
    does: 'Show a 3 by 3 grid to point anywhere'
  },

  // ---- Answer card and notice buttons (gated; plain "copy" / "undo" stay keys) ----
  {
    id: 'answer.repeat',
    category: 'lumen',
    patterns: [
      '(repeat|repeat that|repeat it|repeat the answer|repeat your answer|say that again|say it again|what did you say|what was that|read it again|read that again|read the answer|read the answer again)'
    ],
    gate: 'recent-answer',
    say: 'repeat that',
    does: 'Say the answer again'
  },
  {
    id: 'answer.copy',
    category: 'lumen',
    patterns: [
      '(copy that|copy the answer|copy your answer|copy answer|copy the reply|copy your reply)'
    ],
    gate: 'recent-answer',
    say: 'copy the answer',
    does: 'Copy the answer text'
  },
  {
    id: 'notice.undo',
    category: 'lumen',
    patterns: ['(undo|undo that|undo it|undo the edit|undo the change|undo my edit)'],
    gate: 'notice-undo',
    say: 'undo that',
    does: 'Undo the edit Lumen just made'
  },
  {
    id: 'notice.unmute',
    category: 'lumen',
    patterns: [
      '(unmute|unmute it|unmute that|unmute the sound|unmute sound|turn the sound on|turn sound on|sound on)'
    ],
    gate: 'notice-unmute',
    say: 'unmute',
    does: 'Turn the sound on and hear the answer'
  },

  // ---- Numbers (marks) ----
  {
    id: 'marks.show',
    category: 'numbers',
    patterns: [
      '(show numbers|numbers|show labels|show me numbers|show the numbers|lumen numbers) (everywhere|on all screens|all screens)',
      '(numbers|show numbers) all screens'
    ],
    args: { scope: 'all' },
    say: 'show numbers everywhere',
    does: 'Number clickable things on every screen'
  },
  {
    id: 'marks.show',
    category: 'numbers',
    patterns: ['(show numbers|numbers|show labels|show me numbers|show the numbers|lumen numbers)'],
    say: 'show numbers',
    does: 'Number everything you can click in this window'
  },
  {
    id: 'marks.show',
    category: 'numbers',
    patterns: ['[show ]numbers (for|on) [the ]<role>'],
    say: 'numbers for links',
    does: 'Number only links, buttons, fields, menus or tabs'
  },
  {
    id: 'marks.hide',
    category: 'numbers',
    patterns: [
      '(hide numbers|no numbers|clear|clear numbers|hide labels|remove numbers|cancel|stop|close numbers)'
    ],
    gate: 'marks',
    say: 'hide numbers',
    does: 'Hide the numbers'
  },
  {
    id: 'marks.more',
    category: 'numbers',
    patterns: ['(show more numbers|more numbers|next numbers|next page)'],
    gate: 'marks',
    say: 'more numbers',
    does: 'Show the next page of numbers'
  },
  {
    id: 'marks.keep',
    category: 'numbers',
    patterns: ['keep[ the] numbers[ on]'],
    args: { on: true },
    say: 'keep numbers',
    does: 'Keep numbers on screen after each click'
  },
  {
    id: 'marks.keep',
    category: 'numbers',
    patterns: ['(stop keeping numbers|dont keep numbers|do not keep numbers)'],
    args: { on: false },
    say: 'stop keeping numbers',
    does: 'Hide numbers after each click'
  },
  {
    id: 'marks.drag',
    category: 'numbers',
    patterns: ['drag[ number] <n> (to|onto|on) [number ]<m>'],
    gate: 'marks',
    say: 'drag 3 to 7',
    does: 'Drag one numbered item onto another'
  },
  {
    id: 'marks.type',
    category: 'numbers',
    patterns: ['(type|write) <text> (in|into) [number ]<n>'],
    gate: 'marks',
    say: 'type hello in 4',
    does: 'Type into a numbered field'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['double click[ number] <n>'],
    args: { action: 'double' },
    gate: 'marks',
    say: 'double click 5',
    does: 'Double click a number'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['right click[ number] <n>'],
    args: { action: 'right' },
    gate: 'marks',
    say: 'right click 5',
    does: 'Right click a number'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['(focus|go to|move to)[ number] <n>'],
    args: { action: 'focus' },
    gate: 'marks',
    say: 'focus 5',
    does: 'Move to a number without clicking'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['(press|choose|select|pick|tap|open)[ number] <n>'],
    args: { action: 'click' },
    gate: 'marks',
    say: 'choose 5',
    does: 'Click a number'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['(click|left click)[ number] <n>'],
    args: { action: 'click' },
    say: 'click 5',
    does: 'Click a number (shows numbers first when none are up)'
  },
  {
    id: 'marks.act',
    category: 'numbers',
    patterns: ['[number ]<n>'],
    args: { action: 'click' },
    gate: 'marks',
    say: '5',
    does: 'Click that number while numbers are shown'
  },

  // ---- Pointer ----
  {
    id: 'pointer.click',
    category: 'pointer',
    patterns: ['(click|left click|click here|click it|click that)'],
    args: { button: 'left', count: 1 },
    say: 'click',
    does: 'Click where the pointer is'
  },
  {
    id: 'pointer.click',
    category: 'pointer',
    patterns: ['double click[ here| it| that]'],
    args: { button: 'left', count: 2 },
    say: 'double click',
    does: 'Double click where the pointer is'
  },
  {
    id: 'pointer.click',
    category: 'pointer',
    patterns: ['right click[ here| it| that]'],
    args: { button: 'right', count: 1 },
    say: 'right click',
    does: 'Right click where the pointer is'
  },
  {
    id: 'pointer.click',
    category: 'pointer',
    patterns: ['middle click[ here| it| that]'],
    args: { button: 'middle', count: 1 },
    say: 'middle click',
    does: 'Middle click where the pointer is'
  },
  {
    id: 'pointer.move',
    category: 'pointer',
    patterns: ['(move|nudge) (the )?(mouse|pointer|cursor) <dir>[ <n>]'],
    say: 'move mouse left, move mouse up 5',
    does: 'Nudge the pointer (number = times 10 pixels)'
  },

  // ---- Scrolling ----
  {
    id: 'scroll.stop',
    category: 'scroll',
    patterns: ['(stop scrolling|stop|stop it)'],
    gate: 'autoscroll',
    say: 'stop scrolling',
    does: 'Stop automatic scrolling'
  },
  {
    id: 'scroll.speed',
    category: 'scroll',
    patterns: ['(faster|scroll faster)'],
    args: { faster: true },
    gate: 'autoscroll',
    say: 'faster',
    does: 'Scroll faster'
  },
  {
    id: 'scroll.speed',
    category: 'scroll',
    patterns: ['(slower|scroll slower)'],
    args: { faster: false },
    gate: 'autoscroll',
    say: 'slower',
    does: 'Scroll slower'
  },
  {
    id: 'scroll.auto',
    category: 'scroll',
    patterns: ['(start scrolling|keep scrolling|auto scroll) <dir>'],
    say: 'start scrolling down',
    does: 'Scroll by itself until you say stop'
  },
  {
    id: 'scroll.edge',
    category: 'scroll',
    patterns: ['(scroll|go|jump) to (the )?top[ of the page]'],
    args: { edge: 'top' },
    say: 'scroll to the top',
    does: 'Jump to the top'
  },
  {
    id: 'scroll.edge',
    category: 'scroll',
    patterns: ['(scroll|go|jump) to (the )?bottom[ of the page]'],
    args: { edge: 'bottom' },
    say: 'go to bottom',
    does: 'Jump to the bottom'
  },
  {
    id: 'scroll',
    category: 'scroll',
    patterns: ['(scroll|page) <dir> <amount>'],
    say: 'scroll down a little, scroll up a lot',
    does: 'Scroll a little or a lot'
  },
  {
    id: 'scroll',
    category: 'scroll',
    patterns: ['(scroll|page|scroll it) <dir>[ <n> times]'],
    say: 'scroll down',
    does: 'Scroll the window under the pointer'
  },

  // ---- Keyboard ----
  {
    id: 'key.press',
    category: 'keyboard',
    patterns: ['(press|hit|push|tap) <keys> <n> times', '(press|hit|push|tap) <keys>'],
    say: 'press enter, press control s, press tab 3 times',
    does: 'Press a key or shortcut'
  },
  {
    id: 'key.type',
    category: 'keyboard',
    patterns: ['(type|write|dictate) <text>'],
    say: 'type hello world',
    does: 'Type text where the cursor is'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['new line'],
    args: { combo: 'enter' },
    say: 'new line',
    does: 'Press Enter'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['new paragraph'],
    args: { combo: 'enter', times: 2 },
    say: 'new paragraph',
    does: 'Press Enter twice'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['tab key'],
    args: { combo: 'tab' },
    say: 'tab key',
    does: 'Press Tab'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(backspace|back space)[ <n>][ times]'],
    args: { combo: 'backspace' },
    say: 'backspace, backspace 3',
    does: 'Delete characters before the cursor'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['delete (that|this)'],
    args: { combo: 'delete' },
    say: 'delete that',
    does: 'Press Delete'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['delete[ the| last] word'],
    args: { combo: 'ctrl+backspace' },
    say: 'delete word',
    does: 'Delete the word before the cursor'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['select all'],
    args: { combo: 'ctrl+a' },
    say: 'select all',
    does: 'Select everything'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(copy|copy that|copy this)'],
    args: { combo: 'ctrl+c' },
    say: 'copy',
    does: 'Copy'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(cut|cut that|cut this)'],
    args: { combo: 'ctrl+x' },
    say: 'cut',
    does: 'Cut'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(paste|paste that|paste it)'],
    args: { combo: 'ctrl+v' },
    say: 'paste',
    does: 'Paste'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(undo|undo that)'],
    args: { combo: 'ctrl+z' },
    say: 'undo',
    does: 'Undo'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(redo|redo that)'],
    args: { combo: 'ctrl+y' },
    say: 'redo',
    does: 'Redo'
  },
  {
    id: 'key.fixed',
    category: 'keyboard',
    patterns: ['(save|save it|save that|save file)'],
    args: { combo: 'ctrl+s' },
    say: 'save',
    does: 'Save'
  },
  {
    id: 'key.spell',
    category: 'keyboard',
    patterns: ['spell <text>'],
    say: 'spell c a t, spell alpha bravo',
    does: 'Type letter by letter'
  },
  {
    id: 'key.caps',
    category: 'keyboard',
    patterns: ['caps on'],
    args: { on: true },
    say: 'caps on',
    does: 'Type in capitals'
  },
  {
    id: 'key.caps',
    category: 'keyboard',
    patterns: ['caps off'],
    args: { on: false },
    say: 'caps off',
    does: 'Stop typing in capitals'
  },

  // ---- Navigation ----
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(go back|back|navigate back)'],
    args: { combo: 'alt+left' },
    gate: 'no-guide',
    say: 'go back',
    does: 'Go back (browser, Explorer)'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(go forward|forward|navigate forward)'],
    args: { combo: 'alt+right' },
    say: 'go forward',
    does: 'Go forward'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(refresh|reload|refresh page|reload page|refresh the page|reload the page)'],
    args: { combo: 'f5' },
    say: 'refresh',
    does: 'Reload the page'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(new tab|open new tab|open a new tab)'],
    args: { combo: 'ctrl+t' },
    say: 'new tab',
    does: 'Open a new tab'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(close tab|close this tab|close the tab)'],
    args: { combo: 'ctrl+w' },
    say: 'close tab',
    does: 'Close the tab'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(next tab|switch tab)'],
    args: { combo: 'ctrl+tab' },
    say: 'next tab',
    does: 'Go to the next tab'
  },
  {
    id: 'key.fixed',
    category: 'navigation',
    patterns: ['(previous tab|last tab|prior tab)'],
    args: { combo: 'ctrl+shift+tab' },
    say: 'previous tab',
    does: 'Go to the previous tab'
  },
  {
    id: 'tab.n',
    category: 'navigation',
    patterns: ['(tab|go to tab|switch to tab)[ number] <n>'],
    say: 'tab 3',
    does: 'Go to tab 1 to 8'
  },

  // ---- Windows ----
  {
    id: 'key.fixed',
    category: 'windows',
    patterns: ['(minimize|minimise)[ (the |this )?window]'],
    args: { combo: 'win+down' },
    say: 'minimize',
    does: 'Minimize the window'
  },
  {
    id: 'key.fixed',
    category: 'windows',
    patterns: ['(maximize|maximise)[ (the |this )?window]'],
    args: { combo: 'win+up' },
    say: 'maximize',
    does: 'Maximize the window'
  },
  {
    id: 'key.fixed',
    category: 'windows',
    patterns: ['restore[ (the |this )?window]'],
    args: { combo: 'win+down' },
    say: 'restore',
    does: 'Restore the window size'
  },
  {
    id: 'key.fixed',
    category: 'windows',
    patterns: ['(show desktop|show the desktop|go to desktop)'],
    args: { combo: 'win+d' },
    say: 'show desktop',
    does: 'Show the desktop'
  },
  {
    id: 'key.fixed',
    category: 'windows',
    patterns: ['(switch window|switch windows|next window|alt tab)'],
    args: { combo: 'alt+tab' },
    say: 'switch window',
    does: 'Switch to the previous window'
  },

  // ---- Describe and read ----
  {
    id: 'describe.screen',
    category: 'reading',
    patterns: [
      '(describe|describe [the |my |this ]screen|describe the window|describe this window)[ in (full|detail)]',
      '(what is|whats) on [the |my ]screen',
      '(where am i|what am i looking at|what do you see)'
    ],
    args: { detail: 'brief' },
    say: 'describe screen',
    does: 'Say what is on the screen (say "more detail" after it)'
  },
  {
    id: 'describe.cursor',
    category: 'reading',
    patterns: [
      '(what is|whats) under [my |the ](cursor|mouse|pointer)',
      '(what is|whats) (this|that)[ (button|thing|icon|control)]',
      '(explain|describe) (this|that)[ (button|thing|icon|control)]'
    ],
    say: "what's under my cursor",
    does: 'Explain the control under the pointer'
  },
  {
    id: 'read.selection',
    category: 'reading',
    patterns: [
      '(read|read out|read aloud) (this|that|it|the selection|selection|the selected text|selected text|what i selected)'
    ],
    say: 'read this',
    does: 'Read the selected text (or the field with focus, or what is under the pointer)'
  },
  {
    id: 'read.page',
    category: 'reading',
    patterns: [
      '(read|read out|read aloud) (the|this) (page|document|article|email|message)',
      '(read|read out) (the whole thing|everything|all of it)',
      'read page'
    ],
    say: 'read the page',
    does: 'Read the page aloud in parts ("pause", "continue", "next", "stop")'
  },

  // ---- Lumen ----
  {
    id: 'answer.pin',
    category: 'lumen',
    patterns: ['(pin|pin it|pin that|pin the answer|keep it|keep that|keep this)'],
    gate: 'answer',
    say: 'pin',
    does: 'Keep the answer on screen'
  },
  {
    id: 'answer.longer',
    category: 'lumen',
    patterns: ['(longer|wait longer|more time|give me more time)'],
    say: 'longer',
    does: 'Give me twice as long before things close'
  },
  {
    id: 'answer.close',
    category: 'lumen',
    patterns: ['(close|dismiss|close that|close it|close the answer|hide the answer)'],
    gate: 'answer',
    say: 'dismiss',
    does: 'Close the answer'
  },
  {
    id: 'dwell.set',
    category: 'lumen',
    patterns: ['(pause dwell|stop dwell|dwell off|turn off dwell|turn dwell off)'],
    args: { on: false },
    say: 'pause dwell',
    does: 'Pause dwell clicking'
  },
  {
    id: 'dwell.set',
    category: 'lumen',
    patterns: ['(resume dwell|start dwell|dwell on|turn on dwell|turn dwell on)'],
    args: { on: true },
    say: 'resume dwell',
    does: 'Resume dwell clicking'
  },
  {
    id: 'scan.set',
    category: 'lumen',
    patterns: ['(start scanning|switch scanning on|start switch scanning)'],
    args: { on: true },
    say: 'start scanning',
    does: 'Start switch scanning'
  },
  {
    id: 'scan.set',
    category: 'lumen',
    patterns: ['(stop scanning|switch scanning off)'],
    args: { on: false },
    say: 'stop scanning',
    does: 'Stop switch scanning'
  },
  {
    id: 'lumen.help-topic',
    category: 'lumen',
    patterns: [
      '(what can i say|what can you do|what can i ask|help|commands|voice commands) (about|for|with|in) <text>',
      '(help me with|show commands for|list commands for) <text>'
    ],
    say: 'what can I say about buddies',
    does: 'Hear the commands of one area'
  },
  {
    id: 'lumen.help',
    category: 'lumen',
    patterns: ['(what can i say|help|commands|show commands|list commands|voice commands)'],
    say: 'what can I say',
    does: 'List the commands'
  },
  {
    id: 'lumen.settings',
    category: 'lumen',
    patterns: ['(open settings|lumen settings|show settings|settings)'],
    say: 'open settings',
    does: 'Open Lumen settings'
  },
  {
    id: 'lumen.listen',
    category: 'lumen',
    patterns: ['(go to sleep|stop listening)'],
    args: { on: false },
    say: 'go to sleep',
    does: 'Stop listening for the wake word'
  },
  {
    id: 'lumen.listen',
    category: 'lumen',
    patterns: ['(wake up|start listening)'],
    args: { on: true },
    say: 'wake up',
    does: 'Listen for the wake word again'
  },

  {
    id: 'app.open',
    category: 'navigation',
    patterns: ['(open|start|launch|run) <app>'],
    say: 'open notepad',
    does: 'Open an app (or a known website)'
  },

  // ---- Last: needs an exact control name in the cached UIA snapshot, else the router ----
  {
    id: 'pointer.click-name',
    category: 'pointer',
    patterns: ['(click on|tap on|click) <text>'],
    say: 'click Compose',
    does: 'Click a control by its exact name'
  }
]

/**
 * Commands handled outside this grammar that the help sheet still lists: guide navigation
 * (guides/voice-nav.ts, whole utterance only, while a guide runs).
 */
export const SHEET_EXTRAS: GrammarEntry[] = [
  {
    id: 'guide.next',
    category: 'guide',
    patterns: [],
    gate: 'guide',
    say: 'next',
    does: 'Go to the next step'
  },
  {
    id: 'guide.prev',
    category: 'guide',
    patterns: [],
    gate: 'guide',
    say: 'back',
    does: 'Go to the previous step'
  },
  {
    id: 'guide.repeat',
    category: 'guide',
    patterns: [],
    gate: 'guide',
    say: 'repeat',
    does: 'Say the step again'
  },
  {
    id: 'guide.done',
    category: 'guide',
    patterns: [],
    gate: 'guide',
    say: 'done',
    does: 'Close the guide'
  }
]
