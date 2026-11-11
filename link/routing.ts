// Who a Send goes to (SPEC §4, "Routing Sends"): the Agent that owns the
// Region or Element it is about, else the Agents that own what its Marks
// point at, else every Agent attached to the Space. A Behavior trigger that
// nobody receives (only set, apply_recipe or open_panel) isn't delivered.
import type { DatabaseSync } from "node:sqlite";
import type { SpaceStore } from "./storage/journal.ts";

export const recipient = (agent: string) => `agent:${agent}`;

export function attachedAgents(db: DatabaseSync, space: string): string[] {
  return (db.prepare("SELECT agent FROM space_agents WHERE space = ? ORDER BY at").all(space) as { agent: string }[]).map((r) => r.agent);
}

/** Recipients for one Send, or null when it goes to nobody. */
export function route(db: DatabaseSync, store: SpaceStore, space: string, send: string): string[] | null {
  const attached = attachedAgents(db, space);
  const r = store.read(space, (s) => {
    const frozen = JSON.parse(s.send(send));
    if (!frozen) return { frozen: null, marks: [] };
    const marks = JSON.parse(s.marks(send, "{}"))?.marks ?? [];
    return { frozen, marks };
  });
  const frozen = r.frozen;
  if (!frozen) return attached.map(recipient);
  if (frozen.kind === "action") return null;
  const owner: string | undefined = frozen.owner?.agent;
  if (owner) return attached.includes(owner) ? [recipient(owner)] : attached.map(recipient);
  // Elements as nobody in particular sees them: an Agent's are "<agent>:<id>".
  const owners = new Set<string>();
  for (const m of r.marks) for (const id of [...(m.on ?? []), m.from, m.to, m.near]) if (typeof id === "string" && id.includes(":")) owners.add(id.split(":")[0]);
  const mine = attached.filter((a) => owners.has(a));
  return (mine.length ? mine : attached).map(recipient);
}
