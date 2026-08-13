// Named-export bridge to tests/harness.ts for the `.mjs` suites.
//
// Every suite runs under `node --import jiti/register`, and jiti's ESM hook
// hands an ESM importer of a `.ts` module a default-only namespace: from a
// `.mjs` file, `import { suite } from "./harness.ts"` fails with "does not
// provide an export named 'suite'", while `import harness from "./harness.ts"`
// works and yields the whole module object. (A `.ts` suite importing
// `./harness.ts` is unaffected — jiti keeps named exports within its own
// transform.)
//
// That quirk is a property of the loader, not of the harness, and it belongs in
// exactly one place rather than as a two-line destructuring preamble in each
// `.mjs` suite. Suites in both dialects therefore write the same thing:
// `import { suite } from "../harness.ts"` (TypeScript) or
// `import { suite } from "../harness.mjs"` (JavaScript).
//
// Adding an export to harness.ts and forgetting it here fails loudly at import
// time ("does not provide an export named …"), never silently as undefined.

import harness from "./harness.ts";

export const { suite, sleep, until, withTempDir, repoRoot, readSource } = harness;
