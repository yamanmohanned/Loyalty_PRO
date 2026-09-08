import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No client redeclares a server DTO (CLAUDE_v3.md §12.27).
 *
 * ## Why this is a test and not a convention
 *
 * The rule has now been broken twice, and both times it failed the same way —
 * silently, by staying plausible:
 *
 *  - §12.23: the manager app copied the `Role` union, so it kept refusing exactly
 *    the roles it had been written against while the API grew a fourth.
 *  - §12.25: the manager app copied the customer DTO, so renaming `barcodeToken`
 *    to `cardNumber` in the contract did not break it. The duplicate went on
 *    describing a shape the server had stopped sending.
 *
 * A duplicated type never fails at the point of duplication. It fails later, in
 * some other commit, as a screen showing `undefined` — which is why a convention
 * is not enough and this has to be a check that runs.
 *
 * ## What it checks
 *
 * Every type argument to `api.get<T>` / `api.post<T>` / `api.put<T>` in a client
 * app must be built **only** from types imported from `@walaa/shared-types`.
 *
 * That is the precise rule rather than a proxy for it: the type argument to an API
 * call IS the client's claim about what the server returns, and the contract
 * package is the only thing entitled to make that claim. Inline wrappers like
 * `{ card: CustomerCard }` are fine — the shape is written at the call site, but
 * every name in it still comes from the contract.
 *
 * Local UI types (`ButtonProps`, `Presentation`) are untouched: they never appear
 * in an API call's type argument, so they never reach this check.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

const CLIENT_APPS = ['apps/manager-desktop/src', 'apps/station/src'];

/** Types every TypeScript file may use without importing anything. */
const AMBIENT = new Set([
  'string',
  'number',
  'boolean',
  'unknown',
  'void',
  'null',
  'undefined',
  'never',
  'any',
  'object',
  'Array',
  'Record',
  'Partial',
  'Pick',
  'Omit',
  'Readonly',
  'Promise',
  'Date',
  'Blob',
  'true',
  'false',
]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/** Names imported from the contract package in one file. */
function contractImports(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@walaa\/shared-types'/g;
  for (const match of source.matchAll(pattern)) {
    for (const raw of match[1]!.split(',')) {
      const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Blanks out comments, preserving offsets and line structure.
 *
 * ── Why the guard needed this ────────────────────────────────────────────────
 *
 * It scanned raw file text, so `api.get<` written inside a comment counted as an API
 * call. `Customers.tsx` carries a comment explaining a bug that was fixed — it quotes
 * the old, wrong call `api.get<{ customer: Customer; balance: CustomerLifetime }>` —
 * and the guard read the explanation as a fresh offence. Worse, the bracket matching
 * then ran off the end of the quoted snippet and into real code below, inventing a
 * third offence (`T`) that appears nowhere near an API call.
 *
 * So the guard failed on a file whose actual API call is correct, and the only ways to
 * make it pass were to delete the comment or to weaken the rule — a check that
 * punishes writing down why something was fixed is a check that will be deleted.
 *
 * Characters are replaced with spaces rather than removed, so every offset and line
 * number downstream still refers to the same place. String literals are tracked
 * because `'http://…'` contains `//` and would otherwise swallow the rest of its line.
 */
function stripComments(source: string): string {
  const out = source.split('');
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      continue;
    }

    i += 1;
  }
  return out.join('');
}

/**
 * The type argument of every `api.get<…>` in a file.
 *
 * Bracket-matched rather than regex-terminated, because the arguments nest:
 * `api.get<{ cards: Card[] }>` closes on its second `>`, not its first.
 */
function apiTypeArguments(rawSource: string): string[] {
  // Comments are not code: see `stripComments`.
  const source = stripComments(rawSource);
  const found: string[] = [];
  const pattern = /\bapi\.(?:get|post|put|patch)</g;
  for (const match of source.matchAll(pattern)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '<') depth += 1;
      else if (char === '>') depth -= 1;
      index += 1;
    }
    found.push(source.slice(start, index - 1));
  }
  return found;
}

/** Identifiers in a type expression, minus property names and ambient types. */
function typeNames(expression: string): string[] {
  // `{ card: CustomerCard }` — drop the property side of every `key:` pair so the
  // key is not mistaken for a type that ought to have been imported.
  const withoutKeys = expression.replace(/[A-Za-z_$][\w$]*\s*\??\s*:/g, ':');
  return [...new Set(withoutKeys.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(
    (name) => !AMBIENT.has(name),
  );
}

describe('no client redeclares a server DTO', () => {
  it('types every API call from the contract package', () => {
    const offences: string[] = [];

    for (const app of CLIENT_APPS) {
      for (const file of sourceFiles(join(REPO, app))) {
        const source = readFileSync(file, 'utf8');
        const imported = contractImports(source);

        for (const argument of apiTypeArguments(source)) {
          for (const name of typeNames(argument)) {
            if (imported.has(name)) continue;
            offences.push(
              `${file.slice(REPO.length + 1).replace(/\\/g, '/')}: api call typed with ` +
                `\`${name}\`, which is not imported from @walaa/shared-types`,
            );
          }
        }
      }
    }

    // The message matters more than the assertion: whoever trips this is midway
    // through adding a screen and needs to know the fix is to move the shape into
    // the contract package, not to widen the check.
    expect(
      offences,
      `A client is describing a server response with a type it declared itself.\n` +
        `Move the shape into packages/shared-types and import it in BOTH the API and\n` +
        `the client, so the two cannot drift (CLAUDE_v3.md §12.27).\n\n` +
        offences.join('\n'),
    ).toEqual([]);
  });

  it('finds the API calls it is supposed to be checking', () => {
    // A guard on the guard. If the regex stops matching — the client renames its
    // `api` helper, say — every offence silently becomes zero offences, and this
    // check would pass forever while checking nothing.
    const total = CLIENT_APPS.flatMap((app) => sourceFiles(join(REPO, app))).reduce(
      (count, file) => count + apiTypeArguments(readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });
});
