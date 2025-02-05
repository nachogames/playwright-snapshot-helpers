import * as vscode from "vscode";
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { glob } from "glob";

let outputChannel: vscode.OutputChannel;

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
  constructor(public name: string, public range: vscode.Range) {}
}

function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return function (...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

class TestCache {
  private cache: Map<string, { tests: TestBlock[]; version: number }> =
    new Map();

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

async function isPlaywrightTestFile(
  document: vscode.TextDocument
): Promise<boolean> {
  // Check file name pattern first
  if (!document.fileName.match(/\.(spec|test)\.(js|ts|mjs|cjs)$/)) {
    return false;
  }

  // Check for Playwright imports or usage
  const text = document.getText();
  return (
    text.includes("@playwright/test") ||
    text.includes("playwright/test") ||
    text.includes("import { test }") ||
    text.includes("const { test }")
  );
}

async function findPlaywrightConfig(
  workspaceRoot: string
): Promise<string | undefined> {
  const configFiles = [
    join(workspaceRoot, "playwright.config.ts"),
    join(workspaceRoot, "playwright.config.js"),
  ];

  for (const configFile of configFiles) {
    if (existsSync(configFile)) {
      return configFile;
    }
  }
  return undefined;
}

async function getSnapshotDirFromConfig(
  workspaceRoot: string,
  testFilePath: string
): Promise<string | undefined> {
  const configPath = await findPlaywrightConfig(workspaceRoot);
  if (!configPath) {
    return undefined;
  }

  try {
    const configContent = readFileSync(configPath, "utf8");

    // Look for snapshotDir in the config
    const snapshotDirMatch = configContent.match(
      /snapshotDir:\s*['"`](.*?)['"`]/
    );
    if (snapshotDirMatch) {
      let snapshotDir = snapshotDirMatch[1];

      // Get the test file name and extension
      const testFileName = testFilePath.split("/").pop() || "";

      // Replace template variables
      let processedDir = snapshotDir;
      processedDir = processedDir.replace("{testFileName}", testFileName);
      processedDir = processedDir.replace("{arg}", "");
      processedDir = processedDir.replace("{ext}", "");

      return join(workspaceRoot, processedDir);
    }

    // If no explicit snapshotDir, check for testDir
    const testDirMatch = configContent.match(/testDir:\s*['"`](.*?)['"`]/);
    if (testDirMatch) {
      const testDir = testDirMatch[1];
      return join(workspaceRoot, testDir, "__snapshots__");
    }
  } catch (error) {
    // Silent fail - if we can't read config, we'll just return undefined
  }

  return undefined;
}

function formatSnapshotName(testName: string): string[] {
  const kebabName = testName.replace(/\s+/g, "-").toLowerCase();
  const prefixedName = kebabName.startsWith("dashboard-")
    ? kebabName
    : `dashboard-${kebabName}`;

  // Try variations with different suffixes and prefixes
  return [prefixedName, `${prefixedName}-1`, `${prefixedName}-2`, kebabName];
}

async function findSnapshotPath(
  testFilePath: string,
  testName: string
): Promise<string | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return undefined;
  }

  // First try to get snapshot directory from Playwright config
  const configSnapshotDir = await getSnapshotDirFromConfig(
    workspaceRoot,
    testFilePath
  );

  if (configSnapshotDir) {
    // Get all possible snapshot name variations
    const snapshotNames = formatSnapshotName(testName);

    // Try each snapshot name variation
    for (const snapshotName of snapshotNames) {
      // Try with and without the test file name in the path
      const pathVariations = [
        join(configSnapshotDir, snapshotName, "*-chromium-darwin.png"),
        join(
          configSnapshotDir,
          snapshotName,
          snapshotName,
          "*-chromium-darwin.png"
        ),
        join(configSnapshotDir, `${snapshotName}-chromium-darwin.png`),
        join(
          configSnapshotDir,
          testFilePath.split("/").pop() || "",
          snapshotName,
          "*-chromium-darwin.png"
        ),
      ];

      for (const pattern of pathVariations) {
        try {
          const matches = await glob(pattern, { nodir: true });
          if (matches.length > 0) {
            return matches[0];
          }
        } catch (error) {
          continue;
        }
      }
    }

    // If still not found, try a more flexible search
    for (const snapshotName of snapshotNames) {
      const flexiblePattern = join(
        configSnapshotDir,
        "**",
        `*${snapshotName}*-chromium-darwin.png`
      );
      try {
        const matches = await glob(flexiblePattern, { nodir: true });
        if (matches.length > 0) {
          return matches[0];
        }
      } catch (error) {
        continue;
      }
    }
  }

  return undefined;
}

async function getOutputDirFromConfig(workspaceRoot: string): Promise<string> {
  const configPath = await findPlaywrightConfig(workspaceRoot);
  if (!configPath) {
    return join(workspaceRoot, "test-results"); // Default Playwright output directory
  }

  try {
    const configContent = readFileSync(configPath, "utf8");
    const outputDirMatch = configContent.match(/outputDir:\s*['"`](.*?)['"`]/);
    return outputDirMatch
      ? join(workspaceRoot, outputDirMatch[1])
      : join(workspaceRoot, "test-results");
  } catch (error) {
    return join(workspaceRoot, "test-results");
  }
}

async function findFailedSnapshotFiles(
  testFilePath: string,
  testName: string
): Promise<{ actual: string; expected: string; diff: string } | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return undefined;
  }

  const outputDir = await getOutputDirFromConfig(workspaceRoot);
  const sanitizedTestName = testName
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase();

  // Try different possible paths where Playwright might store the failed snapshots
  const pathVariations = [
    join(outputDir, "**", sanitizedTestName, "*.png"),
    join(outputDir, "**", "*" + sanitizedTestName + "*", "*.png"),
    join(outputDir, "**", "*" + sanitizedTestName, "*.png"),
    join(outputDir, "**", sanitizedTestName + "*", "*.png"),
  ];

  for (const pattern of pathVariations) {
    try {
      const files = await glob(pattern);
      const actual = files.find((f) => f.includes("-actual.png"));
      const expected = files.find((f) => f.includes("-expected.png"));
      const diff = files.find((f) => f.includes("-diff.png"));

      if (actual && expected && diff) {
        return { actual, expected, diff };
      }
    } catch (error) {
      continue;
    }
  }

  return undefined;
}

class PlaywrightCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;
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
    this.disposables.forEach((d) => d.dispose());
  }

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    if (!(await isPlaywrightTestFile(document))) {
      return [];
    }

    const tests = this.testCache.getTests(document);
    const codeLenses: vscode.CodeLens[] = [];

    for (const test of tests) {
      // Add the existing update snapshot codelens
      const snapshotPath = await findSnapshotPath(
        document.uri.fsPath,
        test.name
      );
      codeLenses.push(
        new vscode.CodeLens(
          new vscode.Range(
            test.startLine,
            0,
            test.startLine,
            document.lineAt(test.startLine).text.length
          ),
          {
            title: `▶ ${snapshotPath ? "Update" : "Create"} Snapshot`,
            command: "playwright-helpers.updateSelectedTest",
            arguments: [test.name, test.startLine, !snapshotPath],
          }
        )
      );

      // Check if snapshot exists and add view snapshot codelens
      if (snapshotPath) {
        codeLenses.push(
          new vscode.CodeLens(
            new vscode.Range(
              test.startLine,
              0,
              test.startLine,
              document.lineAt(test.startLine).text.length
            ),
            {
              title: "👁 View Snapshot",
              command: "vscode.open",
              arguments: [vscode.Uri.file(snapshotPath)],
            }
          )
        );
      }

      // Add diff lens if failed snapshots exist
      const failedSnapshots = await findFailedSnapshotFiles(
        document.uri.fsPath,
        test.name
      );
      if (failedSnapshots) {
        codeLenses.push(
          new vscode.CodeLens(
            new vscode.Range(
              test.startLine,
              0,
              test.startLine,
              document.lineAt(test.startLine).text.length
            ),
            {
              title: "🔍 View Snapshot Diff",
              command: "playwright-helpers.showSnapshotDiff",
              arguments: [
                failedSnapshots.actual,
                failedSnapshots.expected,
                failedSnapshots.diff,
              ],
            }
          )
        );
      }
    }

    return codeLenses;
  }
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Playwright Helpers", {
    log: true,
  });
  context.subscriptions.push(outputChannel);
  const testCache = new TestCache();
  const codeLensProvider = new PlaywrightCodeLensProvider(testCache);

  const selector: vscode.DocumentFilter[] = [
    { pattern: "**/*.spec.ts" },
    { pattern: "**/*.test.ts" },
    { pattern: "**/*.spec.js" },
    { pattern: "**/*.test.js" },
    { language: "typescript", pattern: "**/*.spec.ts" },
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "javascript", pattern: "**/*.spec.js" },
    { language: "javascript", pattern: "**/*.test.js" },
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
        return new TestSymbol(testBlock.name, testBlock.range);
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

      runPlaywrightUpdate({path: filePath, confirm: true});
    }
  );

  // Update all snapshots
  let updateAll = vscode.commands.registerCommand(
    "playwright-helpers.updateAll",
    () => {
      runPlaywrightUpdate({confirm: true});
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

      runPlaywrightUpdate({path: dirPath, confirm: true});
    }
  );

  // Update snapshots for selected test
  let updateSelectedTest = vscode.commands.registerCommand(
    "playwright-helpers.updateSelectedTest",
    async (testNameArg?: string, testLineArg?: number, initialUpdate: boolean = false) => {
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
          test = new TestSymbol(testBlock.name, testBlock.range);
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
      runPlaywrightUpdate({path: filePath, testName: test.name, confirm: !initialUpdate});
    }
  );

  // Show snapshot diff
  let showSnapshotDiff = vscode.commands.registerCommand(
    "playwright-helpers.showSnapshotDiff",
    async (actual: string, expected: string, diff: string) => {
      const panel = vscode.window.createWebviewPanel(
        'snapshotDiff',
        'Snapshot Diff',
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      
      // Convert the images to base64
      const actualData = readFileSync(actual).toString('base64');
      const expectedData = readFileSync(expected).toString('base64');
      const diffData = readFileSync(diff).toString('base64');
      
      panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: system-ui;
              margin: 20px;
              background: var(--vscode-editor-background);
              color: var(--vscode-editor-foreground);
            }
            .container { margin-bottom: 40px; }
            .side-by-side { 
              display: flex;
              justify-content: space-between;
              margin-bottom: 40px;
              gap: 20px;
            }
            .image-container {
              flex: 1;
              text-align: center;
              background: var(--vscode-editor-background);
              padding: 10px;
              border-radius: 6px;
            }
            .image-container img {
              max-width: 100%;
              border: 1px solid var(--vscode-widget-border);
              user-select: none;
            }
            h3 {
              margin: 0 0 10px 0;
              color: var(--vscode-editor-foreground);
            }
            
            /* Tabs */
            .tabs {
              display: flex;
              gap: 10px;
              margin-bottom: 20px;
            }
            .tab {
              padding: 8px 16px;
              cursor: pointer;
              border: none;
              background: var(--vscode-button-secondaryBackground);
              color: var(--vscode-button-secondaryForeground);
              border-radius: 4px;
            }
            .tab.active {
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
            }
            
            /* Views */
            #side-by-side-view, #slider-view { display: none; }
            #side-by-side-view.active, #slider-view.active { display: block; }
            
            /* Slider */
            .slider {
              position: relative;
              max-width: 900px;
              margin: 0 auto;
              overflow: hidden;
              user-select: none;
              -webkit-user-select: none;
              -moz-user-select: none;
              -ms-user-select: none;
            }
            .slider img {
              max-width: 100%;
              display: block;
              pointer-events: none;
              user-drag: none;
              -webkit-user-drag: none;
              -webkit-user-select: none;
              -moz-user-select: none;
              -ms-user-select: none;
            }
            .before {
              position: absolute;
              inset: 0;
              width: 50%;
              overflow: hidden;
            }
            .after {
              display: block;
              width: 100%;
            }
            .before-inner {
              position: absolute;
              inset: 0;
              width: 100%;
            }
            .handle {
              position: absolute;
              top: 0;
              bottom: 0;
              left: 50%;
              width: 40px;
              margin-left: -20px;
              cursor: ew-resize;
            }
            .handle::before {
              content: '';
              position: absolute;
              top: 0;
              bottom: 0;
              left: 50%;
              width: 2px;
              background: #fff;
              transform: translateX(-50%);
            }
            .handle::after {
              content: '';
              position: absolute;
              width: 32px;
              height: 32px;
              top: 50%;
              left: 50%;
              background: #fff;
              border: 2px solid #666;
              border-radius: 50%;
              transform: translate(-50%, -50%);
            }
            .slider-label {
              position: absolute;
              top: 20px;
              padding: 5px 10px;
              border-radius: 4px;
              background: rgba(0, 0, 0, 0.5);
              color: white;
              font-size: 12px;
              pointer-events: none;
              transition: opacity 0.3s;
            }
            .before-label { left: 20px; }
            .after-label { right: 20px; }
          </style>
        </head>
        <body>
          <div class="tabs">
            <button class="tab active" onclick="showView('side-by-side-view')">Side by Side</button>
            <button class="tab" onclick="showView('slider-view')">Slider Compare</button>
          </div>

          <div id="side-by-side-view" class="active">
            <div class="side-by-side">
              <div class="image-container">
                <h3>Expected</h3>
                <img src="data:image/png;base64,${expectedData}" />
              </div>
              <div class="image-container">
                <h3>Actual</h3>
                <img src="data:image/png;base64,${actualData}" />
              </div>
              <div class="image-container">
                <h3>Diff</h3>
                <img src="data:image/png;base64,${diffData}" />
              </div>
            </div>
          </div>

          <div id="slider-view">
            <h3>Drag to Compare Expected vs Actual</h3>
            <div class="slider">
              <div class="before">
                <div class="before-inner">
                  <img src="data:image/png;base64,${expectedData}" class="after" />
                </div>
                <span class="slider-label before-label">Expected</span>
              </div>
              <img src="data:image/png;base64,${actualData}" class="after" />
              <span class="slider-label after-label">Actual</span>
              <div class="handle"></div>
            </div>
          </div>

          <script>
            // Tab switching
            function showView(viewId) {
              document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
              document.querySelectorAll('#side-by-side-view, #slider-view').forEach(view => view.classList.remove('active'));
              
              const selectedTab = document.querySelector(\`button[onclick="showView('\${viewId}')"]\`);
              const selectedView = document.getElementById(viewId);
              
              selectedTab.classList.add('active');
              selectedView.classList.add('active');
            }

            // Slider functionality
            const slider = (selector) => {
              const container = document.querySelector(selector);
              const before = container.querySelector('.before');
              const handle = container.querySelector('.handle');
              const beforeLabel = container.querySelector('.before-label');
              const afterLabel = container.querySelector('.after-label');

              let widthChange = 0;
              let mouseDown = false;

              const beforeInner = container.querySelector('.before-inner');
              beforeInner.style.width = \`\${container.offsetWidth}px\`;

              const resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                  beforeInner.style.width = \`\${entry.contentRect.width}px\`;
                }
              });
              resizeObserver.observe(container);

              const handleMove = (e) => {
                if (!mouseDown) return;

                e.preventDefault();
                const containerWidth = container.offsetWidth;
                const rect = container.getBoundingClientRect();
                const pageX = e.type === 'mousemove' ? e.pageX : e.touches[0].pageX;
                const currentPoint = Math.max(0, Math.min(pageX - rect.left, containerWidth));

                widthChange = (currentPoint / containerWidth) * 100;
                before.style.width = \`\${widthChange}%\`;
                handle.style.left = \`\${widthChange}%\`;
                afterLabel.style.opacity = 1 - (widthChange / 100);
                beforeLabel.style.opacity = widthChange / 100;
              };

              // Mouse events
              container.addEventListener('mousedown', () => {
                mouseDown = true;
                document.addEventListener('mousemove', handleMove);
                document.addEventListener('mouseup', () => {
                  mouseDown = false;
                  document.removeEventListener('mousemove', handleMove);
                }, { once: true });
              });

              // Touch events
              container.addEventListener('touchstart', (e) => {
                mouseDown = true;
                document.addEventListener('touchmove', handleMove, { passive: false });
                document.addEventListener('touchend', () => {
                  mouseDown = false;
                  document.removeEventListener('touchmove', handleMove);
                }, { once: true });
              });
            };

            // Initialize slider when DOM is loaded
            document.addEventListener('DOMContentLoaded', () => {
              slider('.slider');
            });

            // Initialize immediately since we're injecting after DOM load
            slider('.slider');
          </script>
        </body>
        </html>
      `;
    }
  );

  context.subscriptions.push(
    updateFile,
    updateAll,
    updateDir,
    updateSelectedTest,
    showSnapshotDiff
  );

  // Debounce the cursor movement handler
  const updateTestContext = debounce(
    async (editor: vscode.TextEditor, position: vscode.Position) => {
      const tests = testCache.getTests(editor.document);
      const test = tests.find(
        (t) => position.line >= t.startLine && position.line <= t.endLine
      );

      await vscode.commands.executeCommand(
        "setContext",
        "playwright-helpers.isInTestBlock",
        !!test
      );
    },
    100
  );

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

async function runPlaywrightUpdate({path, testName, confirm}: {path?: string, testName?: string, confirm: boolean}) {
  let command: string;
  let confirmMessage: string;

  if (testName && path) {
    // Update specific test in specific file
    const escapedTestName = testName.replace(/["']/g, '\\"');
    command = `npx playwright test "${path}" -u -g "${escapedTestName}"`;
    confirmMessage = `Are you sure you want to update snapshots for test "${testName}"?`;
    outputChannel.appendLine(`Updating snapshots for test "${testName}" in ${path}`);
  } else if (path) {
    // Update all tests in specific file/directory
    command = `npx playwright test "${path}" -u`;
    confirmMessage = `Are you sure you want to update all snapshots in "${path}"?`;
    outputChannel.appendLine(`Updating all snapshots in ${path}`);
  } else {
    // Update all tests in project
    command = "npx playwright test -u";
    confirmMessage = "Are you sure you want to update all snapshots in the project?";
    outputChannel.appendLine("Updating all snapshots in project");
  }

  let answer: string | undefined;
  if (confirm) {
    answer = await vscode.window.showWarningMessage(
      confirmMessage,
      { modal: true },
      'Yes, Update',
    );
  }

  if (!confirm || answer === 'Yes, Update') {
    outputChannel.appendLine(`Executing command: ${command}`);
    const terminal = vscode.window.createTerminal("Playwright Update");
    terminal.show();
    terminal.sendText(command);
  } else {
    outputChannel.appendLine('Snapshot update cancelled by user');
  }
}

export function deactivate() {}
