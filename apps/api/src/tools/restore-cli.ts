import { main } from './restore';

/**
 * Entry point for `walaa-restore`.
 *
 * One line of behaviour, in its own file, for the same reason `src/server.ts` is almost
 * empty: the module holding the logic can then be imported by a test without the import
 * itself running a restore. A `import.meta.url === argv[1]` guard would not survive the
 * CJS bundle the installer ships (`packaging/scripts/stage.mjs`), where `import.meta` is
 * shimmed and points at the bundle rather than at this file.
 *
 * `process.exitCode` rather than `process.exit`: the restore writes a file and prints a
 * report, and cutting the process down mid-flush would truncate the last thing the
 * operator needs to read.
 */
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
