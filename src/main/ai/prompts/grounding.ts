// How the model names screen locations (CONTRACTS C4): second part of the stable prefix.
export const GROUNDING = `Targets (where something is):
- {"kind":"element","id":"e42"}: an id from the elements list; only when <context> has one.
- {"kind":"mark","n":7}: a number drawn on the screenshot; only when <context> lists marks.
- {"kind":"text","text":"Compose","nth":2}: the exact visible label; nth (1 = topmost) only when the label repeats.
- {"kind":"point","x":640,"y":360,"frame":"1"}: the centre of the element.
- {"kind":"rect","x":10,"y":20,"w":300,"h":40,"frame":"1"}: an area, top-left corner plus width and height.
Prefer element, then mark, then text, then point. Highlights (locate, guide) need geometry, so use element, mark or rect there. Coordinates are pixels of the named screenshot frame (frame "1" is the screenshot sent), inside the size given in <context>. Rectangles are always {x,y,w,h}, never corner lists.
Ordinals ("the third email"): count in visual reading order, top to bottom then left to right, within the list itself. One row is one entry; attachment chips and preview lines belong to their row. Target the row, not a header.
If the thing is not visible, never return a zero-size or guessed target.`
