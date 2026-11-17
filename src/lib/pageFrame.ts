/**
 * The frames an HTML page the agent presented is drawn in, and the policy
 * they hold it to.
 *
 * The page sits in a frame inside a frame, both sandboxed with scripts
 * allowed and nothing else, so neither has an origin, storage, forms,
 * popups or a way to navigate anything above it. The outer frame holds
 * only the inner one, under a policy whose `frame-src 'none'` stops the
 * page navigating its own frame anywhere: a policy binds the frames inside
 * a document, never the document's own frame, and the window itself has
 * none. Both documents carry the same policy: nothing from the network,
 * and of files only those in the page's own folder, which the app serves
 * at the page's base address under a token for that page.
 *
 * A line of script put in front of the page reports its height, catches
 * a click on a link, and tells the window what did not load, so the
 * window can say why.
 */

/** What may be loaded from the page's folder: anything at its base
    address, which names this page's folder and no other. Without one the
    page loads nothing but what it carries itself. */
export function pagePolicy(base: string | null): string {
  const files = base === null ? "" : ` ${base}`;
  return [
    "default-src 'none'",
    `img-src${files} data: blob:`,
    `media-src${files} data: blob:`,
    `font-src${files} data:`,
    `style-src${files} 'unsafe-inline'`,
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    `base-uri${base === null ? " 'none'" : files}`,
  ].join("; ");
}

function attribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Runs in the page before anything of its own. Posts to the window, two
    frames up: the page's height, a link clicked, a file that did not load;
    and takes from the window why, to draw in place of an image. */
const PRELUDE = String.raw`(function(){
var host=parent.parent,base=document.querySelector("base[data-workbench]");base=base?base.href:null;
function post(m){host.postMessage(m,"*")}
function h(){var c=document.body?document.body.children:[],m=0;for(var i=0;i<c.length;i++){var b=c[i].getBoundingClientRect().bottom;if(b>m)m=b}return m>0?m+16:document.documentElement.scrollHeight}
function r(){post({workbenchHeight:h()})}
addEventListener("load",r);if(window.ResizeObserver&&document.documentElement)new ResizeObserver(r).observe(document.documentElement);setTimeout(r,0);
var told={};
function said(t){return t&&t.getAttribute?t.getAttribute("src")||t.getAttribute("href")||t.getAttribute("poster")||null:null}
function whose(u){var all=document.querySelectorAll("[src],[href],[poster]");for(var i=0;i<all.length;i++){var t=all[i];if(t.src===u||t.href===u||t.poster===u)return said(t)}return null}
function whole(u){try{return new URL(u,document.baseURI).href}catch(x){return u}}
function missed(url,how,as){if(!url||told[url])return;told[url]=1;post({workbenchMissed:{url:String(url),how:how,said:as||null}})}
document.addEventListener("securitypolicyviolation",function(e){if(e.blockedURI==="inline"||e.blockedURI==="eval")return;missed(e.blockedURI,"blocked:"+e.effectiveDirective,said(e.target)||whose(e.blockedURI))});
addEventListener("error",function(e){var t=e.target;if(!t||t===window||!t.tagName)return;var u=t.src||t.currentSrc||t.href;if(typeof u!=="string"||u===""||/^(data|blob):/.test(u))return;missed(whole(u),"failed",said(t))},true);
addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var raw=a.getAttribute("href")||"";if(/^\s*javascript:/i.test(raw))return;e.preventDefault();
if(raw.charAt(0)==="#"){var id=raw.slice(1);try{id=decodeURIComponent(id)}catch(x){}var to=id?document.getElementById(id)||document.getElementsByName(id)[0]:document.body;if(to)to.scrollIntoView();return}
var u;try{u=new URL(raw,document.baseURI).href}catch(x){return}
if(base&&u.indexOf(base)===0)post({workbenchOpen:u.slice(base.length).split("#")[0].split("?")[0]});else{delete told[u];missed(u,"link",raw)}});
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}
function cut(t,n){t=String(t);return t.length>n?"…"+t.slice(t.length-n+1):t}
function stand(img,name,why){var b=img.getBoundingClientRect(),w=b.width>=160?Math.round(b.width):320,v=b.height>=48?Math.round(b.height):64,n=Math.max(8,Math.floor((w-24)/7));
var s='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+v+'"><rect x="0.5" y="0.5" width="'+(w-1)+'" height="'+(v-1)+'" rx="4" fill="#f4f4f5" stroke="#a1a1aa" stroke-dasharray="4 3"/><text y="50%" font-family="system-ui,sans-serif" font-size="12" fill="#3f3f46"><tspan x="12" dy="-0.3em">'+esc(cut(name,n))+'</tspan><tspan x="12" dy="1.4em" fill="#71717a">'+esc(cut(String(why).split(/[,:]/)[0],n))+'</tspan></text></svg>';
img.removeAttribute("srcset");img.title=name+" "+why;img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(s)}
addEventListener("message",function(e){if(e.source!==host)return;var d=e.data&&e.data.workbenchWhy;if(!d)return;var all=document.images;for(var i=0;i<all.length;i++){var g=all[i];if((g.src===d.url||g.currentSrc===d.url)&&g.complete&&g.naturalWidth===0)stand(g,d.name,d.why)}});
})()`;

/** What goes in front of the page: the policy, the base its relative
    references resolve against, and the script. */
function prelude(base: string | null): string {
  const policy = attribute(pagePolicy(base));
  const at = base === null ? "" : `<base data-workbench href="${attribute(base)}">`;
  return (
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    at +
    `<script>${PRELUDE}</script>`
  );
}

/** The doctype and anything before it, which must stay first for the page
    to be laid out as it asks. */
const LEAD = /^(?:﻿)?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/** The page with the prelude put in front of it, after its doctype. */
export function pageDocument(html: string, base: string | null): string {
  const lead = LEAD.exec(html)?.[0] ?? "";
  return lead + prelude(base) + html.slice(lead.length);
}

/** The outer frame's document: the policy, and the page in a frame of its
    own inside. */
export function outerDocument(html: string, base: string | null, title: string): string {
  return (
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${attribute(pagePolicy(base))}">` +
    `<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>` +
    `</head><body><iframe sandbox="allow-scripts" title="${attribute(title)}" srcdoc="${attribute(pageDocument(html, base))}"></iframe></body></html>`
  );
}

/** What a page may name beside it and the window opens when a link to
    it is clicked. */
export type Opened = "image" | "video" | "audio";

export function openedKind(file: string): Opened | null {
  const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"].includes(extension))
    return "image";
  if (["mp4", "m4v", "webm", "mov", "ogv"].includes(extension)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "oga", "flac"].includes(extension)) return "audio";
  return null;
}

/** Why something the page named did not load, when the window can tell
    without asking where the files are. `url` is what the page reported,
    `how` how it went: `failed` to load, `link` clicked, or `blocked:` and
    the directive of the policy that stopped it. `base` is the page's base
    address. Null for a file in the page's folder that failed, which only
    the core can answer for. */
export function plainWhy(url: string, how: string, base: string | null): string | null {
  if (how === "blocked:connect-src")
    return "was asked for by a script, and a presented page's scripts reach nothing";
  if (how === "blocked:frame-src" || how === "blocked:child-src" || how === "blocked:object-src")
    return "is a frame, which a presented page does not open";
  if (how === "blocked:form-action") return "is where a form sends, which a presented page does not";
  if (how.startsWith("blocked:script-src"))
    return "is a script from a file, and a presented page runs only the scripts it carries";
  if (base !== null && url.startsWith(base)) return null;
  if (base !== null && url.startsWith(filesRoot(base))) return "is outside the page's folder";
  if (/^(?:https?:|wss?:|\/\/)/i.test(url)) {
    return how === "link"
      ? "is a link to the web, which a presented page does not open"
      : "is on the network, which a presented page does not reach";
  }
  return how === "link"
    ? "is a link out of the page's folder, which a presented page does not open"
    : "is outside the page's folder";
}

/** Where every page's files are served, above any one page's base: the
    base's scheme and host. */
function filesRoot(base: string): string {
  const host = base.indexOf("//");
  const path = host < 0 ? -1 : base.indexOf("/", host + 2);
  return path < 0 ? base : base.slice(0, path + 1);
}

/** A file in the page's folder as the page named it, decoded, from the
    part of its address after the base. */
export function fileOf(url: string, base: string): string {
  const rest = url.slice(base.length).split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
