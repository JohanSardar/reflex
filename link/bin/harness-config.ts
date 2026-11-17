// What `reflex setup` writes into a harness's own config, edited in place.
//
// Codex: `[mcp_servers.reflex]` in config.toml. Only the keys Reflex owns are
// set (command, args, tool_timeout_sec when missing, REFLEX_HOME in env); every
// other key, comment and table stays as it was. The server may be written as
// a table, with an `[mcp_servers.reflex.env]` subtable, or inline under
// `[mcp_servers]` as `reflex = { … }`; whichever is there is edited, and a
// table is added only when neither is.
//
// Claude Code: the entry `claude mcp add-json` takes, built from the one there
// so the person's own env and extra args survive.

export interface Want {
  command: string;
  args: string[];
  /** REFLEX_HOME for a profile other than the default; null takes it out. */
  home: string | null;
}

const q = (s: string): string => JSON.stringify(s);
/** A TOML value: a basic string, an array or inline table on one line, or a bare word or number. */
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{[^}]*\}|[^,}\s#]+`;

/** The table a header line opens (`[a.b]`, `[ "a" . b ]`), or undefined for any other line. */
function header(line: string): string | undefined {
  const m = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
  return m ? m[1].replace(/\s+/g, "").replace(/"/g, "") : undefined;
}

/** Sets (or, with null, removes) `key` in an inline table's text `{ … }`. */
function inlineSet(table: string, key: string, value: string | null): string {
  const re = new RegExp(String.raw`(^\{\s*|,\s*)("?)${key}\2\s*=\s*(?:${VALUE})`);
  const m = re.exec(table);
  if (m) {
    if (value === null) {
      const rest = table.slice(m.index + m[0].length);
      // Removing the first pair takes the comma after it; any other, the comma before it.
      return m[1].startsWith("{")
        ? `{ ${rest.replace(/^\s*,\s*/, "").replace(/^\s*/, "")}`
        : table.slice(0, m.index) + rest;
    }
    return `${table.slice(0, m.index)}${m[1]}${key} = ${value}${table.slice(m.index + m[0].length)}`;
  }
  if (value === null) return table;
  const inner = table.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  return inner ? `{ ${inner}, ${key} = ${value} }` : `{ ${key} = ${value} }`;
}

/** Where a `key = value` line's value ends: the same line, or the line closing a multi-line array. */
function valueEnd(lines: string[], i: number): number {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j].replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, "")) {
      if (ch === "[" || ch === "{") depth++;
      if (ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0) return j;
  }
  return i;
}

/**
 * Why Reflex's server in this config.toml is written in a form this editor doesn't handle (dotted keys, a multi-line
 * string or inline table, an array of tables), or null. Setup then leaves the file alone and says what to write.
 */
export function unsupported(text: string): string | null {
  const lines = text.split("\n");
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\[\[\s*"?mcp_servers"?\s*\.\s*"?reflex"?\b/.test(l))
      return `line ${i + 1} makes it an array of tables ([[…]])`;
    const h = header(l);
    if (h !== undefined) {
      section = h;
      continue;
    }
    const mine = section === "mcp_servers.reflex" || section.startsWith("mcp_servers.reflex.");
    const inline = section === "mcp_servers" && /^\s*"?reflex"?\s*=/.test(l);
    if (section === "" && /^\s*"?mcp_servers"?\s*\.\s*"?reflex"?\s*[.=]/.test(l))
      return `line ${i + 1} sets it with dotted keys (mcp_servers.reflex.…)`;
    if (section === "mcp_servers" && /^\s*"?reflex"?\s*\./.test(l))
      return `line ${i + 1} sets it with dotted keys (reflex.…)`;
    if (inline && /=\s*\{/.test(l) && !/\}\s*(#.*)?$/.test(l))
      return `line ${i + 1} spreads its inline table over several lines`;
    if ((mine || inline) && /"""|'''/.test(l)) return `line ${i + 1} has a multi-line string`;
  }
  return null;
}

/** config.toml with Reflex's MCP server set to `want`. Returns the text unchanged when it already is. */
export function codexConfig(text: string, want: Want): string {
  const lines = text.split("\n");
  const cmd = q(want.command);
  const args = `[${want.args.map(q).join(", ")}]`;
  const home = want.home === null ? null : q(want.home);

  // Inline, under [mcp_servers]: `reflex = { … }` on one line.
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const h = header(lines[i]);
    if (h !== undefined) {
      section = h;
      continue;
    }
    const m = section === "mcp_servers" ? /^(\s*"?reflex"?\s*=\s*)(\{.*\})(\s*(#.*)?)$/.exec(lines[i]) : null;
    if (!m) continue;
    let t = inlineSet(inlineSet(m[2], "command", cmd), "args", args);
    if (!/(^\{|,)\s*"?tool_timeout_sec"?\s*=/.test(t)) t = inlineSet(t, "tool_timeout_sec", "300");
    const env = /(^\{|,)\s*"?env"?\s*=\s*(\{[^}]*\})/.exec(t);
    const envNow = env ? inlineSet(env[2], "REFLEX_HOME", home) : home ? `{ REFLEX_HOME = ${home} }` : null;
    if (envNow !== null) t = inlineSet(t, "env", envNow === "{ }" || envNow === "{}" ? null : envNow);
    lines[i] = m[1] + t + m[3];
    return lines.join("\n");
  }

  // A table: [mcp_servers.reflex], then maybe [mcp_servers.reflex.env], up to the next other table.
  const start = lines.findIndex((l) => header(l) === "mcp_servers.reflex");
  if (start < 0) {
    const block = [
      "[mcp_servers.reflex]",
      `command = ${cmd}`,
      `args = ${args}`,
      "tool_timeout_sec = 300   # Codex cuts every call at this; progress does not extend it",
      ...(home ? [`env = { REFLEX_HOME = ${home} }`] : []),
      "",
    ].join("\n");
    return text + (text && !text.endsWith("\n\n") ? (text.endsWith("\n") ? "\n" : "\n\n") : "") + block;
  }
  let end = start + 1;
  while (end < lines.length && (header(lines[end])?.startsWith("mcp_servers.reflex.") ?? true)) end++;
  const sub = lines.findIndex((l, i) => i > start && i < end && header(l) !== undefined);
  const mainEnd = sub < 0 ? end : sub;
  const envAt = lines.findIndex((l, i) => i > start && i < end && header(l) === "mcp_servers.reflex.env");

  /** Sets key = value in lines (from, to); returns how many lines were added or removed. */
  const set = (from: number, to: number, key: string, value: string | null, onlyIfMissing = false): number => {
    for (let i = from; i < to; i++) {
      if (!new RegExp(String.raw`^\s*"?${key}"?\s*=`).test(lines[i])) continue;
      if (onlyIfMissing) return 0;
      const last = valueEnd(lines, i);
      const comment = /\s+#[^"\]]*$/.exec(lines[last])?.[0] ?? "";
      if (value === null) {
        lines.splice(i, last - i + 1);
        return -(last - i + 1);
      }
      lines.splice(i, last - i + 1, `${/^\s*/.exec(lines[i])?.[0] ?? ""}${key} = ${value}${comment}`);
      return -(last - i);
    }
    if (value === null) return 0;
    // After the last key of that table, before any blank lines that end it.
    let at = to;
    while (at - 1 >= from && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, `${key} = ${value}`);
    return 1;
  };

  let shift = 0;
  shift += set(start + 1, mainEnd + shift, "command", cmd);
  shift += set(start + 1, mainEnd + shift, "args", args);
  shift += set(start + 1, mainEnd + shift, "tool_timeout_sec", "300", true);
  if (envAt >= 0) {
    const from = envAt + shift + 1;
    let to = from;
    while (to < lines.length && header(lines[to]) === undefined) to++;
    set(from, to, "REFLEX_HOME", home);
  } else {
    const at = lines.findIndex((l, i) => i > start && i < mainEnd + shift && /^\s*"?env"?\s*=\s*\{.*\}/.test(l));
    const m = at >= 0 ? /^(\s*"?env"?\s*=\s*)(\{[^}]*\})(.*)$/.exec(lines[at]) : null;
    if (m) {
      const t = inlineSet(m[2], "REFLEX_HOME", home);
      if (/^\{\s*\}$/.test(t)) lines.splice(at, 1);
      else lines[at] = m[1] + t + m[3];
    } else if (home) set(start + 1, mainEnd + shift, "env", `{ REFLEX_HOME = ${home} }`);
  }
  return lines.join("\n");
}

export interface ClaudeEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

/** Whether a Claude Code entry is a Reflex one (some checkout's agent/bin/reflex.mjs), not another server called reflex. */
export const isReflex = (e: ClaudeEntry): boolean => (e.args ?? []).some((a) => /agent\/bin\/reflex\.mjs$/.test(a));

/** The entry to add: the one there with this checkout's command and args, its extra args and other env kept. */
export function claudeEntry(old: ClaudeEntry | undefined, want: Want): ClaudeEntry {
  const env = { ...(old?.env ?? {}) };
  delete env.REFLEX_HOME;
  if (want.home !== null) env.REFLEX_HOME = want.home;
  const extra = old?.args ? old.args.slice(old.args.indexOf("mcp") + 1).filter((a) => !want.args.includes(a)) : [];
  return { ...(old ?? {}), type: "stdio", command: want.command, args: [...want.args, ...extra], env };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const sameEntry = (a: ClaudeEntry, b: ClaudeEntry): boolean =>
  a.command === b.command &&
  same(a.args ?? [], b.args ?? []) &&
  same(Object.entries(a.env ?? {}).sort(), Object.entries(b.env ?? {}).sort());
