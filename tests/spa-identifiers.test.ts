import { readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The SPA is plain ES modules with no bundler, so a helper that a view uses
// but forgets to import only fails at runtime — and only once that code path
// renders. Full checkJs is too noisy on DOM types, so this asserts just the
// one property that matters: every identifier resolves.
const UNRESOLVED_NAME_CODES = new Set([2304, 2552]);

it('resolves every identifier used by the console modules', () => {
  const files = readdirSync('public')
    .filter((name) => name.endsWith('.js'))
    .map((name) => `public/${name}`);
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
  });

  const unresolved = files.flatMap((file) =>
    program.getSemanticDiagnostics(program.getSourceFile(file))
      .filter((diagnostic) => UNRESOLVED_NAME_CODES.has(diagnostic.code))
      .map((diagnostic) => {
        const { line } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!);
        return `${file}:${line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
      }));

  expect(unresolved).toEqual([]);
});
