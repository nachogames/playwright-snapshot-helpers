import * as vscode from "vscode";
import { exec } from "child_process";
import { dirname } from "path";

interface TestBlock {
  name: string;
  range: vscode.Range;
  startLine: number;
  endLine: number;
}

function findTestBlock(
  lines: string[],
  startLine: number
): TestBlock | undefined {
  const line = lines[startLine];
  const testMatch = line.match(/test(?:\.only)?\s*\(\s*['"`](.*?)['"`]/);

  if (!testMatch) {
    return undefined;
  }

  // Find the end of the test block by counting braces
  let braceCount = 0;
  let foundOpenBrace = false;

  // Find the opening brace first
  for (let j = startLine; j < Math.min(lines.length, startLine + 5); j++) {
    const checkLine = lines[j];
    if (checkLine.includes("{")) {
      foundOpenBrace = true;
      braceCount = 1;
      break;
    }
  }

  if (!foundOpenBrace) {
    return undefined;
  }

  // Now find the closing brace
  let endLine = startLine;
  for (let j = startLine + 1; j < lines.length; j++) {
    const checkLine = lines[j];
    braceCount += (checkLine.match(/{/g) || []).length;
    braceCount -= (checkLine.match(/}/g) || []).length;
    
    if (braceCount === 0) {
      endLine = j;
      break;
    }
  }

  return {
    name: testMatch[1],
    range: new vscode.Range(startLine, 0, endLine, lines[endLine].length),
    startLine,
    endLine,
  };
}

class TestSymbol {
  constructor(
    public name: string,
    public range: vscode.Range,
    public nameRange: vscode.Range
  ) {}
}

function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return function(...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

class TestCache {
  private cache: Map<string, { tests: TestBlock[]; version: number }> = new Map();

  getTests(document: vscode.TextDocument): TestBlock[] {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    
    if (cached && cached.version === document.version) {
      return cached.tests;
    }

    const tests = this.findTestsInDocument(document);
    this.cache.set(key, { tests, version: document.version });
    return tests;
  }

  private findTestsInDocument(document: vscode.TextDocument): TestBlock[] {
    const tests: TestBlock[] = [];
    const text = document.getText();
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const testBlock = findTestBlock(lines, i);
      if (testBlock) {
        tests.push(testBlock);
      }
    }

    return tests;
  }

  clear(document: vscode.TextDocument) {
    this.cache.delete(document.uri.toString());
  }
}

async function isPlaywrightTestFile(document: vscode.TextDocument): Promise<boolean> {
  // Check file name pattern first
  if (!document.fileName.match(/\.(spec|test)\.(js|ts|mjs|cjs)$/)) {
    return false;
  }

  // Check for Playwright imports or usage
  const text = document.getText();
  return text.includes('@playwright/test') || 
         text.includes('playwright/test') ||
         text.includes('import { test }') ||
         text.includes('const { test }');
}

class PlaywrightCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
  private disposables: vscode.Disposable[] = [];
  private testCache: TestCache;

  constructor(testCache: TestCache) {
    this.testCache = testCache;

    // Combine events and debounce the refresh
    const refreshCodeLenses = debounce(() => {
      this._onDidChangeCodeLenses.fire();
    }, 250);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(refreshCodeLenses),
      vscode.window.onDidChangeActiveTextEditor(refreshCodeLenses),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.testCache.clear(doc);
        refreshCodeLenses();
      })
    );
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    if (!(await isPlaywrightTestFile(document))) {
      return [];
    }

    const tests = this.testCache.getTests(document);
    return tests.map(test => 
      new vscode.CodeLens(
        new vscode.Range(test.startLine, 0, test.startLine, document.lineAt(test.startLine).text.length),
        {
          title: "▶ Update Snapshot",
          command: "playwright-helpers.updateSelectedTest",
          arguments: [test.name, test.startLine],
        }
      )
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const testCache = new TestCache();
  const codeLensProvider = new PlaywrightCodeLensProvider(testCache);
  
  const selector: vscode.DocumentFilter[] = [
    { pattern: "**/*.spec.ts" },
    { pattern: "**/*.test.ts" },
    { pattern: "**/*.spec.js" },
    { pattern: "**/*.test.js" },
    // Add more explicit selectors
    { language: 'typescript', pattern: '**/*.spec.ts' },
    { language: 'typescript', pattern: '**/*.test.ts' },
    { language: 'javascript', pattern: '**/*.spec.js' },
    { language: 'javascript', pattern: '**/*.test.js' }
  ];

  // Register the provider first
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
    codeLensProvider
  );

  // Function to find the test at a specific position
  async function findTestAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<TestSymbol | undefined> {
    const text = document.getText();
    const lines = text.split("\n");

    // Look for test block start, scanning upwards from current position
    for (let i = position.line; i >= 0; i--) {
      const testBlock = findTestBlock(lines, i);
      if (
        testBlock &&
        position.line >= testBlock.startLine &&
        position.line <= testBlock.endLine
      ) {
        return new TestSymbol(testBlock.name, testBlock.range, testBlock.range);
      }
    }

    return undefined;
  }

  // Update snapshots for current file
  let updateFile = vscode.commands.registerCommand(
    "playwright-helpers.updateFile",
    async (uri?: vscode.Uri) => {
      let filePath: string;
      let document: vscode.TextDocument;

      if (uri) {
        // Called from explorer context menu
        filePath = uri.fsPath;
        document = await vscode.workspace.openTextDocument(uri);
      } else {
        // Called from editor context menu
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage("No active editor found");
          return;
        }
        filePath = editor.document.uri.fsPath;
        document = editor.document;
      }

      if (!(await isPlaywrightTestFile(document))) {
        vscode.window.showErrorMessage("Not a Playwright test file");
        return;
      }

      runPlaywrightUpdate(filePath);
    }
  );

  // Update all snapshots
  let updateAll = vscode.commands.registerCommand(
    "playwright-helpers.updateAll",
    () => {
      runPlaywrightUpdate();
    }
  );

  // Update snapshots in current directory
  let updateDir = vscode.commands.registerCommand(
    "playwright-helpers.updateDir",
    async (uri?: vscode.Uri) => {
      let dirPath: string;

      if (uri) {
        // Called from explorer context menu
        dirPath = uri.fsPath;
      } else {
        // Called from editor context menu
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage("No active editor found");
          return;
        }
        dirPath = dirname(editor.document.uri.fsPath);
      }

      runPlaywrightUpdate(dirPath);
    }
  );

  // Update snapshots for selected test
  let updateSelectedTest = vscode.commands.registerCommand(
    "playwright-helpers.updateSelectedTest",
    async (testNameArg?: string, testLineArg?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active editor found");
        return;
      }

      let testName = testNameArg;
      let test: TestSymbol | undefined;

      if (testName && testLineArg !== undefined) {
        // If we have both name and line (from CodeLens), verify the test still exists there
        const lines = editor.document.getText().split("\n");
        const testBlock = findTestBlock(lines, testLineArg);
        if (testBlock && testBlock.name === testName) {
          test = new TestSymbol(testBlock.name, testBlock.range, testBlock.range);
        }
      }

      // If we don't have a verified test yet, try to find it at cursor position
      if (!test) {
        const position = editor.selection.active;
        test = await findTestAtPosition(editor.document, position);
      }

      if (!test?.name) {
        vscode.window.showErrorMessage("No test found at cursor position");
        return;
      }

      const filePath = editor.document.uri.fsPath;
      runPlaywrightUpdate(filePath, test.name);
    }
  );

  context.subscriptions.push(
    updateFile,
    updateAll,
    updateDir,
    updateSelectedTest
  );

  // Debounce the cursor movement handler
  const updateTestContext = debounce(async (editor: vscode.TextEditor, position: vscode.Position) => {
    const tests = testCache.getTests(editor.document);
    const test = tests.find(t => 
      position.line >= t.startLine && 
      position.line <= t.endLine
    );
    
    await vscode.commands.executeCommand(
      "setContext",
      "playwright-helpers.isInTestBlock",
      !!test
    );
  }, 100);

  // Update cursor context when selection changes
  vscode.window.onDidChangeTextEditorSelection(
    async (e) => {
      const editor = e.textEditor;
      const position = editor.selection.active;
      updateTestContext(editor, position);
    },
    null,
    context.subscriptions
  );

  // Update cursor context when active editor changes
  vscode.window.onDidChangeActiveTextEditor(
    async (editor) => {
      if (editor) {
        const position = editor.selection.active;
        const test = await findTestAtPosition(editor.document, position);
        await vscode.commands.executeCommand(
          "setContext",
          "playwright-helpers.isInTestBlock",
          !!test
        );
      } else {
        await vscode.commands.executeCommand(
          "setContext",
          "playwright-helpers.isInTestBlock",
          false
        );
      }
    },
    null,
    context.subscriptions
  );
}

function runPlaywrightUpdate(path?: string, testName?: string) {
  let command: string;

  if (testName && path) {
    // Escape quotes in test name
    const escapedTestName = testName.replace(/["']/g, '\\"');
    command = `npx playwright test -u "${path}" -g "${escapedTestName}"`;
  } else if (path) {
    command = `npx playwright test -u "${path}"`;
  } else {
    command = "npx playwright test -u";
  }

  const terminal = vscode.window.createTerminal("Playwright Update");
  terminal.show();
  terminal.sendText(command);
}

export function deactivate() {}
