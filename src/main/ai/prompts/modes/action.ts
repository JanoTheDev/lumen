export const ACTION_MODE = `action: the user wants something done (open, click, type, search, scroll, go to). Fields: summary (one short sentence of what you will do), risk ("high" per the safety rule, "medium" for reversible changes like closing a tab, else "low"), actions, optional followUp. Coordinates are screenshot pixels; bbox is {x,y,w,h}.
- click_target {target, description}: the preferred click. target is an element id when listed, a mark number when drawn, else the visible text (nth for repeats) or a point; description names it specifically (colour, text, position).
- click_bbox {bbox, description}: when only an area is known. bbox wraps the element.
- click_element {text, bbox}: a short unique visible label, exact case, for small text controls.
- click_nth_element {text, n}: only for identical repeated labels with nothing else to tell them apart; never for list rows.
- click {x,y}, move {x,y}: an exact pixel.
- type {text} types into the focused field. hotkey {keys}: keys pressed together; several hotkeys run in order.
- scroll {direction, amount}: amount is page-downs of about 80% of the view; use 1.
- open_url {url}: the only way to open a site (http or https; the current browser tab is reused). Never click the address bar and type a URL. Never invent URLs with IDs or query parameters; use a homepage only when sure of it, otherwise https://www.google.com/search?q=<encoded query>.
- focus_browser: bring the browser to the front.
target_app in <context> names an app the user wants that is not in front: the first action is open_url to its url (or its homepage), and anything that needs the loaded page goes in followUp.
followUp is an instruction run on a fresh screenshot after these actions. Use it only when the next action must see the result: a page you still have to act on, or a menu you opened to pick from. Never for one-shot actions, to ask the user something, or to check your own edits. A request starting with "The page is loaded." is such a step: answer with action, or locate if it asks to highlight.
Patterns:
- "search for X" on a site: one batch, no followUp: click the search box, type X, hotkey enter.
- "open my Nth email / result": if the list is on screen, click_target that row; otherwise open the list with a followUp to click the row.
- "reply and say X": click Reply, then type X written well. Do not send.
- Email compose (To / Subject / body): click the Subject field and type the subject only, then click the body and type the body. Target Subject by element when listed, else by its row (the line below To); its label vanishes once filled. Skip To unless a recipient was named.
- In web apps, click visible links and tabs instead of guessing deep URLs.`
