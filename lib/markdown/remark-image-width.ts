import type { Root, RootContent } from "mdast";
import type { VFile } from "vfile";

import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";

// Consume metadata before Markdown becomes React elements. Tight lists, table
// cells, links, and emphasis do not necessarily have a paragraph renderer.
export function remarkImageWidth() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    function transform(parent: Root | RootContent) {
      if (!("children" in parent)) return;
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        transform(child);
        if (child.type !== "image" && child.type !== "imageReference") continue;
        const next = parent.children[index + 1];
        const end = child.position?.end.offset;
        if (next?.type !== "text" || end === undefined) continue;
        // Read raw Markdown so escaped braces and character references remain
        // literal, matching the editor's interpretation of the same suffix.
        const width = parseImageWidthTokenFromText(source.slice(end));
        if (!width) continue;
        child.data ??= {};
        child.data.hProperties = {
          ...child.data.hProperties,
          style: `width:${width.width}`,
        };
        next.value = next.value.slice(width.consumedChars);
        if (next.value.length === 0) parent.children.splice(index + 1, 1);
      }
    }
    transform(tree);
  };
}
