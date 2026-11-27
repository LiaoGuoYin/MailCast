import ts from 'typescript';
import { expect, it } from 'vitest';

// The console has no bundler: tsc compiles web/*.ts file by file into public/,
// and a deploy refuses to ship output with type errors (noEmitOnError). Running
// the same check here makes `pnpm test` catch an unimported helper or a renamed
// API field before a deploy does.
it('type-checks the console sources under tsconfig.web.json', () => {
  const { config, error } = ts.readConfigFile('tsconfig.web.json', ts.sys.readFile);
  expect(error).toBeUndefined();
  const { fileNames, options, errors } = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd());
  expect(errors).toEqual([]);
  expect(fileNames.length).toBeGreaterThan(0);

  const program = ts.createProgram(fileNames, { ...options, noEmit: true });
  const problems = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    if (!diagnostic.file) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${diagnostic.file.fileName}:${line + 1} ${message}`;
  });

  expect(problems).toEqual([]);
});
