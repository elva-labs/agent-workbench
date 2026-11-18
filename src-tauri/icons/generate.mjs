// Draws every raster and bundle icon from the SVG sources beside this
// script: the macOS .icns, the Windows .ico, the PNGs Tauri bundles for
// Linux and the Windows Store, the one-colour mark for the menu bar, the
// installer art, the README's image and the page's favicon, for the app
// and for a development build.
//
//   node src-tauri/icons/generate.mjs
//
// Each size is drawn from the source made for it, not scaled down from a
// larger one: the small sources cut the circle wider and draw the mark
// larger, so the cut still shows at 16 px. The SVGs are rasterised by the
// Chromium that Playwright installs for the browser tests, through a
// canvas, and the containers (.icns, .ico, .bmp) are written here.
//
// It writes into the tree, over the files checked in. It needs the
// project's packages and Playwright's Chromium (`npx playwright install
// chromium`). The disk image's background is a TIFF holding both of its
// resolutions, which macOS's tiffutil makes, so that one file is skipped
// elsewhere. Run on macOS on Apple silicon, the output is the same byte
// for byte from run to run; Chromium's rasteriser may differ by a shade on
// another platform or processor, so the checked-in files come from there.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** The source for each size, by its size in points and in pixels: 16 px
    on a screen of 1x has one of its own, then 16 and 32 points, 64 and 128
    points, and larger. */
const macos = (dir) => (points, pixels = points) =>
  join(
    dir,
    pixels <= 16 ? "macos-16.svg" : points <= 32 ? "macos-32.svg" : points <= 128 ? "macos-128.svg" : "macos.svg",
  );
const tile = (dir) => (size) => join(dir, size <= 32 ? "tile-32.svg" : "tile.svg");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");

/** Draws an SVG at width by height, over `ground` when one is given, and
    returns the pixels as RGBA and as a PNG. */
async function draw(file, width, height = width, ground = null) {
  const svg = readFileSync(file, "utf8");
  return page.evaluate(
    async ({ svg, width, height, ground }) => {
      const image = new Image(width, height);
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (ground !== null) {
        context.fillStyle = ground;
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);
      const rgba = Array.from(context.getImageData(0, 0, width, height).data);
      const png = canvas.toDataURL("image/png").split(",")[1];
      return { rgba, png };
    },
    { svg, width, height, ground },
  );
}

async function png(file, size) {
  return Buffer.from((await draw(file, size)).png, "base64");
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(path.slice(root.length + 1));
}

/** An .icns chunk: its type, its length and its data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
}

/** One channel of a classic icon in the run-length form macOS reads,
    written as literal runs only: a count byte under 128, then the bytes. */
function runs(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length; at += 128) {
    const run = bytes.slice(at, at + 128);
    out.push(run.length - 1, ...run);
  }
  return Buffer.from(out);
}

/** An .icns: 16 and 32 px in the classic RGB and mask chunks, which every
    macOS reads, and the larger sizes and every Retina size as PNGs. */
async function icns(source) {
  const chunks = [];
  for (const [rgb, mask, size] of [["is32", "s8mk", 16], ["il32", "l8mk", 32]]) {
    const { rgba } = await draw(source(size), size);
    const channel = (offset) => rgba.filter((_, index) => index % 4 === offset);
    chunks.push(chunk(rgb, Buffer.concat([runs(channel(0)), runs(channel(1)), runs(channel(2))])));
    chunks.push(chunk(mask, Buffer.from(channel(3))));
  }
  const types = [
    ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
    ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
  ];
  for (const [type, size] of types) {
    // A Retina size is drawn as its point size would be, at twice the
    // pixels: 16@2x from the source for 16 points, not from the one for 32.
    const points = ["ic11", "ic12", "ic13", "ic14"].includes(type) ? size / 2 : size;
    chunks.push(chunk(type, await png(source(points, size), size)));
  }
  return chunk("icns", Buffer.concat(chunks));
}

/** An .ico of PNGs, which Windows reads from Vista on. */
async function ico(source) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push(await png(source(size), size));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, index) => {
    const at = 6 + 16 * index;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt8(0, at + 2);
    head.writeUInt8(0, at + 3);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(images[index].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  return Buffer.concat([head, ...images]);
}

/** A 24-bit .bmp, which the Windows installers take for their art. */
async function bmp(file, width, height, ground) {
  const { rgba } = await draw(file, width, height, ground);
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    const at = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      out[at + x * 3] = rgba[from + 2];
      out[at + x * 3 + 1] = rgba[from + 1];
      out[at + x * 3 + 2] = rgba[from];
    }
  }
  return out;
}

/** The icons of one build, the app's or a development build's. */
async function icons(dir) {
  const mac = macos(dir);
  const other = tile(dir);
  write(join(dir, "icon.icns"), await icns(mac));
  write(join(dir, "icon.ico"), await ico(other));
  // Linux takes the PNGs in the bundle's list, the first as the window's.
  write(join(dir, "32x32.png"), await png(other(32), 32));
  write(join(dir, "64x64.png"), await png(other(64), 64));
  write(join(dir, "128x128.png"), await png(other(128), 128));
  write(join(dir, "128x128@2x.png"), await png(other(256), 256));
  write(join(dir, "icon.png"), await png(other(512), 512));
  // The Windows Store's names, in the sizes it asks for.
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310])
    write(join(dir, `Square${size}x${size}Logo.png`), await png(other(size), size));
  write(join(dir, "StoreLogo.png"), await png(other(50), 50));
}

await icons(here);
await icons(join(here, "dev"));

// The mark in one colour. The menu bar takes a template image: black on
// clear, which macOS tints for the bar it is in.
const mark = (size) => join(here, size <= 24 ? "mark-16.svg" : "mark.svg");
for (const [name, size] of [["menubar-template.png", 18], ["menubar-template@2x.png", 36]])
  write(join(here, "mark", name), await png(mark(size), size));
for (const size of [16, 32, 64, 128]) write(join(here, "mark", `mark-${size}.png`), await png(mark(size), size));

// The installers' art. The disk image's window is 660 by 400 points, and
// Finder draws its background sharp on a Retina screen only from a TIFF
// that holds both resolutions, which is the one file the bundle takes.
const art = join(here, "installer");
const dmg = join(art, "dmg-background.svg");
if (process.platform === "darwin") {
  const scratch = mkdtempSync(join(tmpdir(), "chord-dmg-"));
  writeFileSync(join(scratch, "background.png"), Buffer.from((await draw(dmg, 660, 400)).png, "base64"));
  writeFileSync(join(scratch, "background@2x.png"), Buffer.from((await draw(dmg, 1320, 800)).png, "base64"));
  const tiff = join(scratch, "background.tiff");
  execFileSync("tiffutil", ["-cathidpicheck", join(scratch, "background.png"), join(scratch, "background@2x.png"), "-out", tiff], { stdio: "ignore" });
  write(join(art, "dmg-background.tiff"), readFileSync(tiff));
} else {
  console.log("skipped the disk image's background, which needs macOS's tiffutil");
}
write(join(art, "nsis-header.bmp"), await bmp(join(art, "nsis-header.svg"), 150, 57, "#ffffff"));
write(join(art, "nsis-sidebar.bmp"), await bmp(join(art, "nsis-sidebar.svg"), 164, 314, "#ffffff"));
write(join(art, "wix-banner.bmp"), await bmp(join(art, "wix-banner.svg"), 493, 58, "#ffffff"));
write(join(art, "wix-dialog.bmp"), await bmp(join(art, "wix-dialog.svg"), 493, 312, "#ffffff"));

// The README's image and the page's favicon.
write(join(root, "docs", "app-icon.png"), await png(join(here, "macos.svg"), 256));
write(join(root, "static", "favicon.png"), await png(join(here, "tile.svg"), 128));

await browser.close();
