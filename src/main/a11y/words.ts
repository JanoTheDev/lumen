// Common English words, most frequent first, for scan keyboard suggestions (06 T10).
// Short words are left in: picking "the" after "t" still saves a scan step and a space.
export const WORDS: readonly string[] = `
the be to of and a in that have i it for not on with he as you do at this but his by from
they we say her she or an will my one all would there their what so up out if about who get
which go me when make can like time no just him know take people into year your good some
could them see other than then now look only come its over think also back after use two how
our work first well way even new want because any these give day most us is was are been has
had were said did going thanks thank hello hi please yes okay ok sorry help find open close
save send email message search video music file folder document picture photo page window
today tomorrow yesterday morning evening night week month home school call phone number name
address where why here very much more many before great little own old right left big high
small large next early young important few public bad same able last long best better under
never always often again still while should need feel try leave put mean keep let begin seem
show hear play run move live believe hold bring happen write provide sit stand lose pay meet
include continue set learn change lead understand watch follow stop create speak read allow
add spend grow offer remember love consider appear buy wait serve die build stay fall cut
reach kill remain suggest raise pass sell require report decide pull family friend friends
house world life hand part child children eye woman man place case point government company
problem fact group money water room mother father area story student lot study book job word
business issue side kind head service question night end member power car city game line
law information nothing something everything anything someone everyone together around
through between during without again against another every each both such those down off
really actually maybe probably already almost enough quite rather soon later sure free fine
nice happy hope doctor appointment meeting dinner lunch breakfast coffee tea food drink
please computer internet website account password login download upload print copy paste
delete undo text letter note list calendar schedule time address birthday weather news
`
  .split(/\s+/)
  .filter((w, i, all) => w && all.indexOf(w) === i)
