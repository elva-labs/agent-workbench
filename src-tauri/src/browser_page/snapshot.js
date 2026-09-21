// Builds a plain-text snapshot of a page for a model to read cheaply: the
// title and url, then an indented tree of what is likely to matter --
// headings, links, buttons, inputs, textareas, selects, editable regions,
// images with alt text, landmark regions and blocks of visible text --
// skipping anything hidden and script/style/noscript. Runs in the app's own
// content world, called fresh for every snapshot.
//
// Every element a click or a type can target gets a ref like "e3", written
// onto the element itself as the REF_ATTR attribute (cleared from every
// element first, so a ref from an earlier snapshot never lingers). What a
// script leaves on this world's globals is gone by the next call, so a map
// kept there could not be read back; browser_click and browser_type find an
// element again by its attribute.

var REF_ATTR = "data-workbench-ref";
var CAP = 30000;
var nextRef = 1;
var lines = [];

Array.prototype.forEach.call(document.querySelectorAll("[" + REF_ATTR + "]"), function (el) {
  el.removeAttribute(REF_ATTR);
});

// A landmark's implicit role, by tag.
var LANDMARK_TAGS = {
  header: "banner",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  form: "form",
};
var LANDMARK_ROLES = [
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "form",
  "region",
];

function isHidden(el) {
  var style = window.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return false;
}

function ref(el) {
  var id = "e" + nextRef++;
  el.setAttribute(REF_ATTR, id);
  return id;
}

function indent(depth) {
  return "  ".repeat(depth);
}

// The element's whole text, collapsed to single spaces: used for elements
// whose own line fully describes them, so their markup below is not walked
// separately.
function text(el) {
  return el.textContent.replace(/\s+/g, " ").trim();
}

function describeInput(el) {
  var parts = ["input type=" + (el.type || "text")];
  if (el.name) parts.push('name="' + el.name + '"');
  if (el.type === "checkbox" || el.type === "radio") {
    parts.push("checked=" + (el.checked ? "true" : "false"));
  } else if (el.value) {
    parts.push('value="' + el.value + '"');
  }
  if (el.placeholder) parts.push('placeholder="' + el.placeholder + '"');
  return parts.join(" ");
}

function isEditable(el) {
  return el.isContentEditable && el.hasAttribute("contenteditable");
}

function isButtonLike(el) {
  return el.tagName === "BUTTON" || el.getAttribute("role") === "button";
}

// The line an element's own tag or role fully describes, or null when it is
// just a container or plain text carrier.
function describeLeaf(el, tag) {
  if (/^H[1-6]$/.test(tag)) {
    return "heading " + tag.slice(1) + ' "' + text(el) + '"';
  }
  if (tag === "A" && el.hasAttribute("href")) {
    return 'link "' + text(el) + '" -> ' + el.getAttribute("href");
  }
  if (isButtonLike(el)) {
    return 'button "' + text(el) + '"';
  }
  if (tag === "INPUT") {
    return describeInput(el);
  }
  if (tag === "TEXTAREA") {
    return 'textarea name="' + (el.name || "") + '" value="' + el.value + '"';
  }
  if (tag === "SELECT") {
    return 'select name="' + (el.name || "") + '" value="' + el.value + '"';
  }
  if (isEditable(el)) {
    return 'editable "' + text(el) + '"';
  }
  if (tag === "IMG" && el.hasAttribute("alt")) {
    return 'image alt="' + el.getAttribute("alt") + '"';
  }
  return null;
}

// Whether a click or a type can target this element, so it needs a ref.
function needsRef(el, tag) {
  return (
    (tag === "A" && el.hasAttribute("href")) ||
    isButtonLike(el) ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    isEditable(el)
  );
}

function landmarkRole(el) {
  var role = el.getAttribute("role");
  if (role && LANDMARK_ROLES.indexOf(role) !== -1) return role;
  var tag = el.tagName.toLowerCase();
  return LANDMARK_TAGS[tag] || null;
}

function walk(el, depth) {
  if (el.nodeType !== Node.ELEMENT_NODE) return;
  var tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
  if (isHidden(el)) return;

  var leaf = describeLeaf(el, tag);
  if (leaf) {
    var id = needsRef(el, tag) ? ref(el) : null;
    lines.push(indent(depth) + (id ? "[" + id + "] " : "") + leaf);
    return;
  }

  var landmark = landmarkRole(el);
  if (landmark) lines.push(indent(depth) + "region: " + landmark);
  var childDepth = landmark ? depth + 1 : depth;

  if (el.children.length === 0) {
    var own = text(el);
    if (own) lines.push(indent(childDepth) + own);
    return;
  }

  for (var i = 0; i < el.children.length; i++) {
    walk(el.children[i], childDepth);
  }
}

walk(document.body, 0);

var snapshot = document.title + "\n" + location.href + "\n" + lines.join("\n");
if (snapshot.length > CAP) {
  snapshot = snapshot.slice(0, CAP) + "\n...[snapshot cut]";
}
return snapshot;
