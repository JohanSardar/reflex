// Ajv for the Agent layer inside the Worker: the validators build.ts compiled
// ahead of time, under the same API agent/src/protocol.ts uses.
// @ts-expect-error generated JavaScript
import * as V from "../gen/validators.js";

type Validate = ((data: unknown) => boolean) & { errors?: unknown[] | null };
const all = V as unknown as Record<string, Validate> & { byId: Record<string, string>; byCompile: Record<string, string> };

export class Ajv2020 {
  constructor(_opts?: unknown) {}
  addSchema(): this {
    return this;
  }
  getSchema(id: string): Validate | undefined {
    const name = all.byId[id];
    return name ? all[name] : undefined;
  }
  compile(schema: unknown): Validate {
    const name = all.byCompile[JSON.stringify(schema)];
    if (!name) throw new Error(`no precompiled validator for ${JSON.stringify(schema)}; add it to relay/cloudflare/build.ts`);
    return all[name];
  }
}
export default Ajv2020;
