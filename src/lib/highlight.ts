import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * The colours code is drawn in, by what each word is. Every colour is one
 * of the `--code-*` tokens, which come from the terminal's colours, so the
 * editor's code reads in the palette the agent's output does and follows
 * the appearance, the palette, a theme and a stylesheet of the user's own.
 * Nothing changes the face's size, so a line is as tall coloured as plain.
 *
 * This style is loaded with the first language. `@codemirror/language`,
 * which it builds on, is in the app's start bundle, because the editor's
 * commands already import it.
 */
const style = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
      t.meta,
      t.processingInstruction,
      t.annotation,
    ],
    color: "var(--code-keyword)",
  },
  {
    tag: [t.string, t.special(t.string), t.character, t.regexp, t.attributeValue],
    color: "var(--code-string)",
  },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.escape, t.constant(t.name), t.color],
    color: "var(--code-literal)",
  },
  { tag: [t.comment, t.contentSeparator], color: "var(--code-comment)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: "var(--code-function)",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
    color: "var(--code-type)",
  },
  { tag: t.tagName, color: "var(--code-tag)" },
  { tag: t.attributeName, color: "var(--code-attribute)" },
  { tag: t.heading, color: "var(--code-heading)", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--code-link)" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.invalid, color: "var(--code-invalid)" },
]);

export const highlight = syntaxHighlighting(style);
