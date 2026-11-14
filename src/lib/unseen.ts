/** Characters that change how text reads without being seen, by Unicode's
    own categories: controls, format characters (the marks and overrides
    that reorder text, joiners, the soft hyphen, tags), line and paragraph
    separators, and every character Unicode says is drawn as nothing, such
    as variation selectors and Hangul fillers. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Text split so that every character that would change how it reads
    without being seen stands as a visible marker of its own, such as
    ⟨U+202E⟩. A line break and a tab stay as they are. */
export function revealed(text: string): { text: string; unseen: boolean }[] {
  const out: { text: string; unseen: boolean }[] = [];
  let plain = "";
  for (const char of text) {
    if (char !== "\n" && char !== "\t" && UNSEEN.test(char)) {
      if (plain !== "") out.push({ text: plain, unseen: false });
      plain = "";
      const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      out.push({ text: `⟨U+${code}⟩`, unseen: true });
    } else plain += char;
  }
  if (plain !== "" || out.length === 0) out.push({ text: plain, unseen: false });
  return out;
}

/** Text with every character that would change how it reads without being
    seen written as its marker, for a label or a line of plain text. */
export function shown(text: string): string {
  return revealed(text)
    .map((part) => part.text)
    .join("");
}

/** A name as it reads, for telling two names apart: without anything
    unseen, the spaces and marks around it, or case. */
export function bareName(name: string): string {
  return Array.from(name)
    .filter((char) => !UNSEEN.test(char))
    .join("")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Whether a name would read as the user's own, "You", in any case and with
    anything unseen, spaces or marks around it. A session is never called
    that: the thread says "You" for the user alone. */
export function readsAsYou(name: string): boolean {
  return bareName(name) === "you";
}
