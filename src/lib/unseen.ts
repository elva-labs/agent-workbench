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

/** Letters of other scripts that read as Latin ones, folded to them, and
    the digits and letters that read as each other, folded to one. This is
    the look-alikes a name is likeliest to be made of, not Unicode's whole
    table of them; a name that mixes scripts is refused outright besides. */
const LOOKALIKE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", һ: "h", п: "n", г: "r",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
  ı: "l", ℓ: "l", i: "l", "1": "l", "|": "l", "0": "o",
};

/** A name as it reads, for telling two names apart: without anything
    unseen, any spaces, line breaks or tabs, the marks around it, accents
    or case, and with letters that look like Latin ones read as them, so
    "Session 1", "Session1", "session\n1" and "Sessiоn 1" with a Cyrillic
    о are one name. */
export function bareName(name: string): string {
  return Array.from(name.normalize("NFKD").toLowerCase())
    .filter((char) => !UNSEEN.test(char) && !/\s/.test(char) && !/\p{M}/u.test(char))
    .map((char) => LOOKALIKE[char] ?? char)
    .join("")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Whether a name's letters are of more than one script, as a name made to
    pass for another's often is. */
export function mixesScripts(name: string): boolean {
  const scripts = new Set<string>();
  for (const char of name) {
    if (!/\p{L}/u.test(char)) continue;
    const script = ["Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Han", "Hiragana", "Katakana", "Hangul"].find(
      (name) => new RegExp(`\\p{Script=${name}}`, "u").test(char),
    );
    scripts.add(script ?? "other");
  }
  // Japanese writes its words in three scripts at once.
  const japanese = ["Han", "Hiragana", "Katakana"];
  if ([...scripts].every((script) => japanese.includes(script))) return false;
  return scripts.size > 1;
}

/** Whether a name would read as the user's own, "You", in any case and with
    anything unseen, spaces or marks around it. A session is never called
    that: the thread says "You" for the user alone. */
export function readsAsYou(name: string): boolean {
  return bareName(name) === "you";
}
