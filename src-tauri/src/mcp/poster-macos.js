// AppKit measures and draws with the same font fallback as the desktop app.
ObjC.import("AppKit");
function run(argv) {
  const [original, translation, label, background, foreground, path] = argv;
  function color(hex) {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(...rgb, 1);
  }
  const blocks = [[original, 46], [translation, 38], [label, 25]]
    .filter(([text]) => text.length)
    .map(([text, size]) => {
      const attrs = $.NSMutableDictionary.alloc.init;
      attrs.setObjectForKey($.NSFont.systemFontOfSize(size), $.NSFontAttributeName);
      attrs.setObjectForKey(color(foreground), $.NSForegroundColorAttributeName);
      const value = $(text);
      const height = Math.ceil(value.boundingRectWithSizeOptionsAttributesContext($.NSMakeSize(920, 32000), 3, attrs, $.NSStringDrawingContext.alloc.init).size.height);
      return { value, attrs, height };
    });
  const height = 160 + blocks.reduce((sum, block) => sum + block.height + 30, 0);
  if (height > 16000) throw Error("选中文字过长，请缩短后生成海报");
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(1080, height));
  image.lockFocus;
  color(background).setFill;
  $.NSRectFill($.NSMakeRect(0, 0, 1080, height));
  let top = height - 80;
  for (const block of blocks) {
    top -= block.height;
    block.value.drawWithRectOptionsAttributes($.NSMakeRect(80, top, 920, block.height), 3, block.attrs);
    top -= 30;
  }
  image.unlockFocus;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (!png.writeToFileAtomically($(path), true)) throw Error("无法写入 PNG");
}
