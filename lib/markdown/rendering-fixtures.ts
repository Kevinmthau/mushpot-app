// These cases run against both real rendering pipelines, not a mock parser.
export const markdownMediaFixtures = [
  { name: "paragraph", markdown: "![Photo](https://example.com/a.png){width=50%}", width: "50%" },
  { name: "tight list", markdown: "- ![Photo](https://example.com/a.png){width=50%}", width: "50%" },
  { name: "loose list", markdown: "- Intro\n\n  ![Photo](https://example.com/a.png){width=50%}", width: "50%" },
  { name: "nested ordered list", markdown: "1. Item\n   - ![Photo](https://example.com/a.png){width=50%}", width: "50%" },
  { name: "strong", markdown: "**![Photo](https://example.com/a.png){width=50%}**", width: "50%" },
  { name: "emphasis", markdown: "*![Photo](https://example.com/a.png){width=50%}*", width: "50%" },
  { name: "linked image", markdown: "[![Photo](https://example.com/a.png){width=50%}](https://example.com/page)", width: "50%" },
  { name: "quote", markdown: "> ![Photo](https://example.com/a.png){width=50%}", width: "50%" },
  { name: "table", markdown: "| Photo |\n| --- |\n| ![Photo](https://example.com/a.png){width=50%} |", width: "50%" },
  { name: "strong in table", markdown: "| Photo |\n| --- |\n| **![Photo](https://example.com/a.png){width=50%}** |", width: "50%" },
  { name: "pixels", markdown: "![Photo](https://example.com/a.png) { width = 240 }", width: "240px" },
  { name: "decimal pixels", markdown: "![Photo](https://example.com/a.png){width=240.500px}", width: "240.5px" },
  { name: "formatted alt", markdown: "![*Photo* &amp; more](https://example.com/a.png){width=50%}", width: "50%", alt: "Photo & more" },
  { name: "escaped destination", markdown: String.raw`![Photo](https://example.com/a\(b\).png?x=1&amp;y=2){width=50%}`, width: "50%", src: "https://example.com/a(b).png?x=1&y=2" },
  { name: "angle destination", markdown: "![Photo](<https://example.com/a b.png>){width=50%}", width: "50%", src: "https://example.com/a%20b.png" },
  { name: "full reference", markdown: "![Photo][ Pic   URL ]{width=50%}\n\n[pic url]: https://example.com/a.png", width: "50%" },
  { name: "collapsed reference", markdown: "![Photo][]{width=50%}\n\n[Photo]: https://example.com/a.png", width: "50%" },
  { name: "shortcut reference", markdown: "![Photo]{width=50%}\n\n[Photo]: https://example.com/a.png", width: "50%" },
  { name: "table reference", markdown: "| Photo |\n| --- |\n| ![Photo][photo]{width=50%} |\n\n[photo]: https://example.com/a.png", width: "50%" },
  { name: "duplicate reference", markdown: "![Photo][photo]{width=50%}\n\n[photo]: https://example.com/a.png\n[photo]: https://example.com/ignored.png", width: "50%" },
  { name: "video with escaped poster title", markdown: String.raw`![Photo](https://example.com/a.mp4 "poster=https://example.com/poster\(1\).png"){width=50%}`, width: "50%", src: "https://example.com/a.mp4", poster: "https://example.com/poster(1).png", video: true },
] as const;

export const markdownLinkFixtures = [
  "[Label](https://example.com/page)",
  String.raw`[Label](https://example.com/a\(b\)?x=1&amp;y=2)`,
  "[Label](<https://example.com/a b>)",
  "[Label][ Page   URL ]\n\n[page url]: https://example.com/page",
  "[Label][]\n\n[label]: https://example.com/page",
  "[Label]\n\n[label]: https://example.com/page",
  "| Link |\n| --- |\n| [Label][page] |\n\n[page]: https://example.com/page",
];
