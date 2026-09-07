import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultConfigurations = [
  { file: 'tsconfig.json', strict: true },
  // Runtime image build contexts intentionally omit the deployment-only configuration.
  { file: 'tsconfig.deployment.json', checkJs: true, optional: true }
];

/**
 * @param {string} root
 * @param {{file:string;strict?:boolean;checkJs?:boolean;optional?:boolean}[]} configurations
 */
export function checkTypecheck(root, configurations = defaultConfigurations) {
  const projectRoot = resolve(root);
  /** @type {string[]} */
  const failures = [];
  /** @type {Set<string>} */
  const files = new Set();
  for (const configuration of configurations) {
    const path = resolve(projectRoot, configuration.file);
    if (configuration.optional && !existsSync(path)) continue;
    const loaded = ts.readConfigFile(path, ts.sys.readFile);
    if (loaded.error) {
      failures.push(diagnostic(loaded.error));
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(path), undefined, path);
    failures.push(...parsed.errors.map(diagnostic));
    if (configuration.strict && parsed.options.strict !== true)
      failures.push(`${configuration.file}: strict must be true`);
    if (configuration.checkJs && parsed.options.checkJs !== true)
      failures.push(`${configuration.file}: checkJs must be true`);
    if (parsed.options.noCheck === true)
      failures.push(`${configuration.file}: noCheck must not be true`);
    for (const file of parsed.fileNames) {
      const local = relative(projectRoot, file);
      if (local !== '..' && !local.startsWith('../') && !local.split(/[\\/]/).includes('node_modules'))
        files.add(file);
    }
  }
  for (const file of [...files].sort()) {
    const text = readFileSync(file, 'utf8');
    if (!/@ts-(?:nocheck|ignore)/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    /** @type {Map<number,number>} */
    const literalRanges = new Map();
    /** @param {ts.Node} node */
    function visit(node) {
      if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) ||
          node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ||
          node.kind === ts.SyntaxKind.TemplateTail || node.kind === ts.SyntaxKind.JsxText)
        literalRanges.set(node.getStart(source), node.end);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (;;) {
      const literalEnd = literalRanges.get(scanner.getTextPos());
      if (literalEnd !== undefined) {
        scanner.setTextPos(literalEnd);
        continue;
      }
      const token = scanner.scan();
      if (token === ts.SyntaxKind.EndOfFileToken) break;
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      const match = /@ts-(?:nocheck|ignore)/.exec(scanner.getTokenText());
      if (match === null) continue;
      const position = source.getLineAndCharacterOfPosition(scanner.getTokenPos() + match.index);
      failures.push(`${relative(projectRoot, file)}:${position.line + 1}:${position.character + 1}: forbidden type-check suppression ${match[0]}`);
    }
  }
  if (failures.length) throw new Error(`Type-check guard failed:\n${failures.join('\n')}`);
  return { files: files.size };
}

/** @param {ts.Diagnostic} value */
function diagnostic(value) { return ts.flattenDiagnosticMessageText(value.messageText, '\n'); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkTypecheck(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(`Type-check guard passed: ${result.files} owned source files checked.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
