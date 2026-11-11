// `reflex create guide|recipe|embed|adapter <name>`: writes a working example
// of each extension kind (ARCHITECTURE §5). Each one passes `reflex test` as
// written, so an author starts from green and changes one thing at a time.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NAME, type Kind } from "../extensions/checks.ts";

const title = (name: string) => name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function guide(name: string): Record<string, string> {
  return {
    [`${name}.md`]: `---
kind: guide
name: ${name}
summary: How to lay out ${title(name).toLowerCase()} on the canvas. Replace this line; read_me("index") shows it.
---
# ${title(name)}

A Guide teaches Agents one domain. Agents read it with \`read_me("${name}")\` before they start, so say
what to draw, where, and how to answer the person's Marks.

## Layout

- Put the main item at the top left, with \`at: {x: 0, y: 0}\`.
- Place everything else relative to it (\`right_of\`, \`below\`), and let Reflex compute the geometry.
- Leave room on the right for the person to write.

## Answering

When the person circles something, answer next to the circle with \`apply(in_reply_to: <send>)\`;
what you add without \`at\` goes next to the first Mark.

## Example

\`\`\`json
{ "space": "demo", "ops": [
  { "op": "add", "id": "topic", "type": "text", "text": "# ${title(name)}", "markdown": true, "size": "xl", "at": { "x": 0, "y": 0 } },
  { "op": "add", "id": "first", "type": "note", "text": "Start here.", "at": { "below": "topic", "gap": 40 } }
] }
\`\`\`
`,
  };
}

function recipe(name: string): Record<string, string> {
  return {
    [`${name}.md`]: `---
kind: recipe
name: ${name}
summary: A titled card with a note under it and a button that sends. Replace this line.
---
# ${title(name)}

A Recipe is a ready-made batch of \`apply\` ops with parameters. An Agent applies it with
\`recipe("${name}", params)\` and gets the batch back to adjust. A string that is exactly
\`"{{param}}"\` becomes that parameter's value with its type; \`{{param}}\` inside a longer string
is replaced by its text.

Use it when you want the person's verdict on one item: they tap the card's button to send.

## Parameters

\`\`\`json params
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,40}$", "description": "The card's ID; the note is <id>-note." },
    "title": { "type": "string", "maxLength": 80 },
    "body": { "type": "string", "maxLength": 400 }
  },
  "required": ["id", "title", "body"],
  "additionalProperties": false
}
\`\`\`

## Example parameters

\`\`\`json example
{ "id": "card", "title": "Payments service", "body": "Owns refunds and payouts. Split it?" }
\`\`\`

## Template

\`\`\`json template
[
  { "op": "add", "id": "{{id}}", "type": "shape", "shape": "rounded", "text": "{{title}}", "color": "violet", "fill": "tint", "w": 240, "h": 90,
    "at": { "x": 0, "y": 0 },
    "behaviors": [ { "on": "tap", "do": "send" } ] },
  { "op": "add", "id": "{{id}}-note", "type": "note", "text": "{{body}}", "w": 240, "h": 110, "at": { "below": "{{id}}", "gap": 24 } }
]
\`\`\`
`,
  };
}

function embed(name: string): Record<string, string> {
  const manifest = {
    kind: "embed",
    name,
    summary: "A bar chart whose Marks resolve to the rows they cover. Replace this line.",
    entry: "index.html",
    params: "params.schema.json",
    guide: "guide.md",
    allow: [],
    example: { title: "Requests per service", rows: [{ id: "auth", label: "auth", value: 42 }, { id: "users", label: "users", value: 17 }, { id: "billing", label: "billing", value: 29 }, { id: "search", label: "search", value: 8 }] },
  };
  const params = {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 80 },
      rows: {
        type: "array",
        maxItems: 50,
        items: { type: "object", properties: { id: { type: "string", maxLength: 64 }, label: { type: "string", maxLength: 40 }, value: { type: "number" } }, required: ["id", "label", "value"], additionalProperties: false },
      },
    },
    required: ["title", "rows"],
    additionalProperties: false,
  };
  return {
    [`${name}/reflex.json`]: JSON.stringify(manifest, null, 2) + "\n",
    [`${name}/params.schema.json`]: JSON.stringify(params, null, 2) + "\n",
    [`${name}/guide.md`]: `# ${title(name)}

A bar chart. Add it with
\`{"op": "add", "type": "embed", "template": "${name}", "params": {"title": "...", "rows": [{"id": "r1", "label": "auth", "value": 42}]}}\`.

When the person circles or strikes bars, the Mark comes back with
\`target: {"kind": "data", "rows": ["r1", ...]}\`: the IDs of the rows it covers.
`,
    [`${name}/index.html`]: `<!doctype html>
<html>
<head>
  <style>
    body { margin: 0; font: 13px -apple-system, Helvetica, Arial, sans-serif; color: #1d1d1f; }
    h1 { font-size: 15px; margin: 10px 12px 4px; }
    svg { display: block; }
    .bar { fill: #0090ff; } .bar.picked { fill: #f76b15; }
    text { font-size: 11px; fill: #6e6e73; }
  </style>
</head>
<body>
  <h1 id="title"></h1>
  <svg id="chart" width="100%" height="260"></svg>
  <script>
    const { title, rows } = reflex.element.props();
    document.getElementById("title").textContent = title;
    const svg = document.getElementById("chart");
    const NS = "http://www.w3.org/2000/svg";
    const chartTop = svg.getBoundingClientRect().top;
    const width = document.body.clientWidth;
    const max = Math.max(1, ...rows.map((r) => r.value));
    const slot = (width - 24) / Math.max(1, rows.length);
    // Where each bar is, in this Embed's own pixels, for the Anchor resolver below.
    const boxes = rows.map((r, i) => {
      const h = Math.round((r.value / max) * 200);
      const box = { id: r.id, x: 12 + i * slot + slot * 0.15, y: chartTop + 220 - h, w: slot * 0.7, h };
      const rect = document.createElementNS(NS, "rect");
      Object.entries({ x: box.x, y: box.y - chartTop, width: box.w, height: h, class: "bar" }).forEach(([k, v]) => rect.setAttribute(k, v));
      rect.addEventListener("click", () => {
        rect.classList.toggle("picked");
        reflex.element.setState({ picked: [...document.querySelectorAll(".picked")].length });
      });
      const label = document.createElementNS(NS, "text");
      Object.entries({ x: box.x + box.w / 2, y: 240, "text-anchor": "middle" }).forEach(([k, v]) => label.setAttribute(k, v));
      label.textContent = r.label;
      svg.append(rect, label);
      return box;
    });

    // A Mark on this Embed: say which rows it covers, not just where it is.
    reflex.anchors.register({
      resolve(region) {
        const [x, y, w, h] = region.bounds;
        const hit = boxes.filter((b) => b.x < x + w && x < b.x + b.w && b.y < y + h && y < b.y + b.h).map((b) => b.id);
        return hit.length ? { kind: "data", rows: hit, label: hit.length + " of " + rows.length + " bars" } : { kind: "local", bounds: region.bounds };
      },
    });
  </script>
</body>
</html>
`,
  };
}

function adapter(name: string): Record<string, string> {
  return {
    [`${name}/reflex.json`]: JSON.stringify({ kind: "adapter", name, summary: "Posts each Send Bundle to a webhook as JSON. Replace this line.", entry: "adapter.ts", config: { url: "https://example.com/reflex-hook" } }, null, 2) + "\n",
    [`${name}/adapter.ts`]: `// A Send Adapter: the Link calls deliver with each Send Bundle for the Agent
// this adapter serves. \`fetch\` is handed in, so \`reflex test\` and \`reflex dev\`
// can run it without touching the network.
type Ctx = { config: { url: string; secret?: string }; fetch: typeof fetch; log: (msg: string) => void };

export default {
  name: "${name}",
  // A JSON Schema for this adapter's configuration (in reflex.json, or \`reflex adapters add\`).
  config: {
    type: "object",
    properties: { url: { type: "string", pattern: "^https://" }, secret: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  },
  async deliver(bundle: { send: string; space: string; said?: string; marks: unknown[] }, ctx: Ctx) {
    const res = await ctx.fetch(ctx.config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ctx.config.secret ? { authorization: \`Bearer \${ctx.config.secret}\` } : {}) },
      body: JSON.stringify({ text: bundle.said ?? \`\${bundle.marks.length} Marks in \${bundle.space}\`, bundle }),
    });
    ctx.log(\`posted \${bundle.send} to the webhook: HTTP \${res.status}\`);
    return { delivered: res.ok };
  },
};
`,
  };
}

const MAKERS: Record<Kind, (name: string) => Record<string, string>> = { guide, recipe, embed, adapter };

/** Writes the example and returns the files it wrote and the path to pass to `reflex test` and `reflex dev`. */
export function create(kind: Kind, name: string, dir: string): { path: string; files: string[] } {
  if (!NAME.test(name)) throw new Error(`'${name}' is not a valid name: use lowercase letters, digits and dashes, starting with a letter or digit.`);
  const files = MAKERS[kind](name);
  const base = resolve(dir);
  const path = kind === "guide" || kind === "recipe" ? join(base, `${name}.md`) : join(base, name);
  if (existsSync(path)) throw new Error(`${path} already exists.`);
  const written: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const f = join(base, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text, { flag: "wx" });
    written.push(f);
  }
  return { path, files: written };
}
