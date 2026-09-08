import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requiredEnvKeys } from '../config/env';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INSTALLER'S CONFIGURATION MUST SATISFY THE SCHEMA THAT READS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this is aimed at ─────────────────────────────────────────────
 *
 * `walaa.env` on a merchant's machine is written by the installer from
 * `packaging/walaa.env.template`, a hand-written file. The API validates what it finds
 * there against a Zod schema. Nothing connected the two.
 *
 * So a setting added to the schema as required, and not added to the template, passes
 * every gate we have: it typechecks, the tests pass, the build succeeds, and every
 * developer machine works — because every developer machine has a repository `.env`
 * that happens to satisfy it. The first machine without one is the merchant's, on his
 * first launch, and what he sees is a service that will not start.
 *
 * That is the same shape as the schema fingerprints that shipped as ungenerated
 * placeholders: a value maintained by memory, whose staleness surfaces at the one
 * place nobody is watching.
 *
 * The template was a literal inside `stage.mjs` until this test needed to read it.
 * Moving it to a file is most of the fix; this is the rest.
 *
 * ── What is and is not asserted ──────────────────────────────────────────────
 *
 * Only the **required** keys — the ones with no default, taken from the schema itself
 * rather than from a second hand-kept list. Optional settings are deliberately absent
 * from the template: WhatsApp credentials, Google Drive's client id and the test-only
 * endpoint overrides are all things a shop either does not use or must not have, and
 * listing them would be inviting somebody to fill them in.
 */

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(API_ROOT, '..', '..');

/** Every `KEY=` assignment in an env file, including commented-out ones. */
function keysIn(path: string): Set<string> {
  const text = readFileSync(path, 'utf8');
  return new Set(
    [...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
  );
}

describe('the configuration the installer writes', () => {
  const required = requiredEnvKeys();

  it('has required settings at all — otherwise this test proves nothing', () => {
    // A schema refactor that made everything optional would turn every assertion below
    // into a tautology. Naming the expectation stops that passing silently.
    expect(required.length).toBeGreaterThan(0);
    expect(required).toContain('DATABASE_URL');
  });

  it('supplies every required setting in packaging/walaa.env.template', () => {
    const template = join(REPO, 'packaging', 'walaa.env.template');
    expect(existsSync(template), `${template} is missing`).toBe(true);

    const present = keysIn(template);
    const missing = required.filter((key) => !present.has(key));

    expect(
      missing,
      'These settings are required by the API and absent from the template the installer ' +
        'writes, so a fresh install would refuse to start. Add them to ' +
        'packaging/walaa.env.template.',
    ).toEqual([]);
  });

  it('documents every required setting in .env.example', () => {
    const example = join(REPO, '.env.example');
    expect(existsSync(example), `${example} is missing`).toBe(true);

    const present = keysIn(example);
    const missing = required.filter((key) => !present.has(key));

    expect(
      missing,
      'These settings are required by the API and undocumented in .env.example, so a ' +
        'developer setting the project up has no way to know they exist.',
    ).toEqual([]);
  });

  /**
   * The placeholders the installer substitutes. If one is renamed in the template and
   * not in `walaa-service.exe`, the shipped `walaa.env` keeps the literal `{{...}}`
   * text — which fails validation on the merchant's machine and nowhere else.
   */
  it('uses only placeholders the service host knows how to fill', () => {
    /*
      Assignment lines only. The file's own header explains the `{{PLACEHOLDER}}`
      convention by naming it, and a placeholder inside a comment is substituted into
      nothing — matching it would fail this test on its own documentation, which is how
      a check earns a `.skip`.
    */
    const template = readFileSync(join(REPO, 'packaging', 'walaa.env.template'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const used = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1] as string);

    const host = readFileSync(
      join(REPO, 'packaging', 'service-host', 'src', 'main.rs'),
      'utf8',
    );

    const unknown = used.filter((name) => !host.includes(`{{${name}}}`));
    expect(
      unknown,
      'The template asks for placeholders the service host never substitutes, so they ' +
        'would reach the merchant as literal text.',
    ).toEqual([]);
  });
});
