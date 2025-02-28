import * as vscode from "vscode";
import { dirname, join, basename } from "path";
import { existsSync, readFileSync } from "fs";
import { glob } from "glob";
import { createHash } from 'crypto';
import { openTestResultsGallery } from './testResultsGallery';

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

interface SnapshotCache {
  version: number;
  timestamp: number;
  snapshots: {
    [path: string]: {
      thumbnail: string;
      fullImage?: string;
      hash: string;
      lastModified: number;
    }
  };
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

async function openSnapshotGallery() {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found");
      return;
    }

    // Create a webview panel first to show loading indicator
    const panel = vscode.window.createWebviewPanel(
      'snapshotGallery',
      'Playwright Snapshot Gallery',
      vscode.ViewColumn.One,
      { 
        enableScripts: true, 
        retainContextWhenHidden: true,
        // Allow access to local file resources
        localResourceRoots: [vscode.Uri.file(workspaceRoot)]
      }
    );
    
    // Set initial loading screen
    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { 
            font-family: system-ui;
            margin: 0;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
          }
          .loader-container {
            text-align: center;
          }
          h2 {
            margin: 0;
            padding: 0;
          }
        </style>
      </head>
      <body>
        <div class="loader-container">
          <h2>Loading Snapshots...</h2>
          <p>Searching for snapshot files, please wait...</p>
        </div>
      </body>
      </html>
    `;

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'openTestFile':
            try {
              outputChannel.appendLine(`Attempting to open test file: ${message.testFile}`);
              
              // Get test directory from Playwright config
              const configPath = await findPlaywrightConfig(workspaceRoot);
              let testDir = 'tests';
              
              if (configPath) {
                try {
                  const configContent = readFileSync(configPath, "utf8");
                  const testDirMatch = configContent.match(/testDir:\s*['"`](.*?)['"`]/);
                  if (testDirMatch) {
                    testDir = testDirMatch[1];
                    outputChannel.appendLine(`Found testDir in config: ${testDir}`);
                  }
                } catch (error) {
                  // Fallback to default paths if config can't be read
                  outputChannel.appendLine(`Error reading Playwright config: ${error}`);
                }
              }
              
              // Try primary path from config first
              const testFilePath = join(workspaceRoot, testDir, message.testFile);
              outputChannel.appendLine(`Trying primary path: ${testFilePath}`);
              
              // Fallback paths if primary path doesn't exist
              const fallbackPaths = [
                join(workspaceRoot, 'tests', message.testFile),
                join(workspaceRoot, 'tests/visual', message.testFile),
                join(workspaceRoot, 'e2e', message.testFile)
              ];
              
              // Try to find the file
              let filePath = '';
              if (existsSync(testFilePath)) {
                filePath = testFilePath;
                outputChannel.appendLine(`Found file at primary path: ${filePath}`);
              } else {
                // Try fallback paths
                outputChannel.appendLine('Primary path not found, trying fallbacks...');
                for (const path of fallbackPaths) {
                  outputChannel.appendLine(`Trying fallback path: ${path}`);
                  if (existsSync(path)) {
                    filePath = path;
                    outputChannel.appendLine(`Found file at fallback path: ${filePath}`);
                    break;
                  }
                }
                
                // If still not found, use glob as last resort
                if (!filePath) {
                  outputChannel.appendLine('File not found in standard paths, using glob search...');
                  const pattern = join(workspaceRoot, '**', message.testFile);
                  const files = await glob(pattern);
                  if (files.length > 0) {
                    filePath = files[0];
                    outputChannel.appendLine(`Found file with glob: ${filePath}`);
                  } else {
                    outputChannel.appendLine(`File not found: ${message.testFile}`);
                    vscode.window.showErrorMessage(`Could not find test file: ${message.testFile}`);
                    return;
                  }
                }
              }
              
              // Open the file in the editor
              outputChannel.appendLine(`Opening file: ${filePath}`);
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
              await vscode.window.showTextDocument(doc);
              outputChannel.appendLine('File opened successfully');
            } catch (error) {
              outputChannel.appendLine(`Error opening test file: ${error}`);
              vscode.window.showErrorMessage(`Error opening test file: ${error}`);
            }
            break;
        }
      },
      undefined,
      []
    );

    outputChannel.appendLine("Searching for snapshots...");
    
    // Find all snapshots in __snapshots__/visual-tests
    const snapshotPattern = join(workspaceRoot, "**/__snapshots__/visual-tests/**/*-chromium-darwin.png");
    const snapshotFiles = await glob(snapshotPattern);
    
    if (snapshotFiles.length === 0) {
      vscode.window.showInformationMessage("No snapshot files found in __snapshots__/visual-tests");
      return;
    }
    
    outputChannel.appendLine(`Found ${snapshotFiles.length} snapshot files`);
    
    // Group snapshots by test file
    const testFileGroups: Record<string, string[]> = {};
    
    for (const file of snapshotFiles) {
      // Extract test file name from path
      const pathParts = file.split("/__snapshots__/visual-tests/");
      if (pathParts.length < 2) continue;
      
      const specFile = pathParts[1].split("/")[0];
      if (!testFileGroups[specFile]) {
        testFileGroups[specFile] = [];
      }
      
      testFileGroups[specFile].push(file);
    }
    
    // Map test files to their routes
    const routeMapping: Record<string, string> = {
      "dashboard.spec.ts": "/",
      "training-library.spec.ts": "/training-library",
      "training-library-trainingAssetId.spec.ts": "/training-library/:trainingAssetId",
      // Add more mappings as needed
    };
    
    // Get the default route pattern for unmapped files
    const getDefaultRoute = (filename: string): string => {
      // Remove .spec.ts or .test.ts extension
      let route = filename.replace(/\.(spec|test)\.(ts|js)$/, "");
      
      // Handle dynamic parameters (kebab-case with IDs)
      if (route.includes("-")) {
        const parts = route.split("-");
        // Check if the last part looks like a parameter name (e.g., userId, accountId)
        const lastPart = parts[parts.length - 1];
        if (lastPart.toLowerCase().includes("id")) {
          // Convert to route parameter format
          parts[parts.length - 1] = `:${lastPart}`;
        }
        route = parts.join("/");
      }
      
      return `/${route}`;
    };
    
    // Get the path prefix to remove from displayed paths
    const pathPrefixToRemove = workspaceRoot;
    
    // Generate HTML for the panel
    let htmlContent = `
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
          h2 {
            margin-top: 40px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .file-badge {
            font-size: 12px;
            background: var(--vscode-editor-background);
            color: var(--vscode-textLink-foreground);
            padding: 3px 8px;
            border-radius: 4px;
            font-weight: normal;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
            margin-left: auto;
            border: 1px solid var(--vscode-textLink-foreground);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
          }
          .file-badge:hover {
            background: var(--vscode-textLink-foreground);
            color: var(--vscode-editor-background);
            transform: translateY(-1px);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          }
          .file-badge svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
          }
          .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
          }
          .gallery-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            transition: transform 0.2s;
            padding: 10px;
            border-radius: 6px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
          }
          .gallery-item:hover {
            transform: scale(1.02);
            background-color: var(--vscode-list-hoverBackground);
          }
          .thumbnail {
            width: 100%;
            height: 150px;
            object-fit: contain;
            border-radius: 4px;
            margin-bottom: 10px;
          }
          .filename {
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
            text-align: center;
          }
          .modal {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.8);
            align-items: center;
            justify-content: center;
            z-index: 100;
            padding: 20px;
            flex-direction: column;
          }
          .modal-content {
            max-width: 90%;
            max-height: 85%;
            display: flex;
            flex-direction: column;
            background: var(--vscode-editor-background);
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--vscode-widget-border);
          }
          .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 10px;
          }
          .modal-header h3 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
          }
          .modal-image-container {
            position: relative;
            margin-bottom: 15px;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            padding: 20px;
            min-height: 200px;
            flex: 1;
            overflow: auto;
          }
          .modal-image {
            max-width: 100%;
            max-height: 70vh;
            object-fit: contain;
            display: block;
            margin: 0 auto;
          }
          .modal-filename {
            font-size: 14px;
            margin-bottom: 15px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            padding: 10px;
          }
          .path-container {
            display: flex;
            flex-direction: column;
            gap: 5px;
          }
          .path-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
          }
          .path-value {
            font-family: monospace;
            font-size: 13px;
            word-break: break-all;
            line-height: 1.4;
            white-space: pre-wrap;
            padding: 4px 0;
          }
          .modal-test-file {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
          }
          .modal-controls {
            display: flex;
            justify-content: space-between;
            width: 100%;
            margin-top: 5px;
            gap: 10px;
          }
          .nav-button, .close-button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            flex: 1;
            max-width: 120px;
            transition: all 0.2s ease;
          }
          .nav-button:hover, .close-button:hover {
            background: var(--vscode-button-hoverBackground);
          }
          .nav-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .close-button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          .close-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
          }
          .keyboard-hint {
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 12px;
          }
          .search-container {
            margin-bottom: 20px;
          }
          #search-input {
            width: 100%;
            padding: 8px;
            font-size: 14px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
          }
          .stats {
            margin-top: 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <h1>Playwright Snapshot Gallery</h1>
        
        <div class="stats">
          Loaded ${snapshotFiles.length} snapshots. Click on any thumbnail to view full size.
        </div>
        
        <div class="search-container">
          <input type="text" id="search-input" placeholder="Search for snapshots..." />
        </div>
        
        <div id="gallery-container">
    `;
    
    // Get sorted entries of test file groups
    const isShowcaseFile = (filename: string) => 
      filename.toLowerCase().startsWith('showcase');
    
    const sortedTestFiles = Object.entries(testFileGroups).sort((a, b) => {
      const aIsShowcase = isShowcaseFile(a[0]);
      const bIsShowcase = isShowcaseFile(b[0]);
      
      // If one is showcase and the other isn't, showcase goes after non-showcase
      if (aIsShowcase && !bIsShowcase) return 1;
      if (!aIsShowcase && bIsShowcase) return -1;
      
      // If both are showcase or both are not showcase, sort alphabetically
      return a[0].localeCompare(b[0]);
    });
    
    // Add galleries grouped by test file
    for (const [testFile, snapshots] of sortedTestFiles) {
      const route = routeMapping[testFile] || getDefaultRoute(testFile);
      
      htmlContent += `
        <div class="test-group" data-test-file="${testFile}">
          <h2>
            ${testFile}
            <span class="file-badge" onclick="openTestFile('${testFile}')">
              <svg viewBox="0 0 16 16">
                <path d="M13.71 4.29l-3-3L10 2h-.59L4 2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h9c.55 0 1-.45 1-1V5l-.29-.71zM13 13H4V3h5v3h4v7z"/>
              </svg>
              Open File
            </span>
          </h2>
          <div class="gallery">
      `;
      
      // Sort snapshots into regular and showcase categories
      const isShowcaseSnapshot = (filename: string) => 
        basename(filename).toLowerCase().startsWith('showcase');
      
      // Sort snapshots, putting showcase ones after other files alphabetically
      const sortedSnapshots = [...snapshots].sort((a, b) => {
        const aIsShowcase = isShowcaseSnapshot(a);
        const bIsShowcase = isShowcaseSnapshot(b);
        
        // If one is showcase and the other isn't, showcase goes after non-showcase
        if (aIsShowcase && !bIsShowcase) return 1;
        if (!aIsShowcase && bIsShowcase) return -1;
        
        // If both are showcase or both are not showcase, sort alphabetically
        return basename(a).localeCompare(basename(b));
      });
      
      for (const snapshotFile of sortedSnapshots) {
        const fileName = basename(snapshotFile);
        const relativeFilePath = snapshotFile.replace(pathPrefixToRemove, '');
        
        // Convert the file path to a webview URI that can be used in the webview
        const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(snapshotFile));
        
        htmlContent += `
          <div class="gallery-item" data-file-path="${relativeFilePath}" data-full-path="${snapshotFile}" data-webview-uri="${webviewUri}" data-test-file="${testFile}" data-is-showcase="${isShowcaseSnapshot(snapshotFile)}" onclick="openModal('${relativeFilePath}', '${webviewUri}', '${testFile}')">
            <img src="${webviewUri}" class="thumbnail" alt="${fileName}" />
            <div class="filename">${fileName}</div>
          </div>
        `;
      }
      
      htmlContent += `
          </div>
        </div>
      `;
    }
    
    // Add modal for image preview with navigation buttons
    htmlContent += `
        </div>
        
        <div class="modal" id="image-modal">
          <div class="modal-content">
            <div class="modal-header">
              <h3 id="modal-test-file-header">Snapshot Preview</h3>
              <span id="modal-test-file" class="modal-test-file"></span>
            </div>
            <div class="modal-image-container">
              <img id="modal-image" class="modal-image" />
            </div>
            <div class="modal-filename">
              <div class="path-container">
                <div class="path-label">File path:</div>
                <div id="modal-path" class="path-value"></div>
              </div>
            </div>
            <div class="modal-controls">
              <button class="nav-button nav-button-prev" onclick="navigateImages('prev')" id="prev-button">Previous</button>
              <button class="close-button" onclick="closeModal()">Close</button>
              <button class="nav-button nav-button-next" onclick="navigateImages('next')" id="next-button">Next</button>
            </div>
          </div>
          <div class="keyboard-hint">Use ← → arrow keys to navigate between images</div>
        </div>
        
        <script>
          // Initialize a connection to the extension host
          const vscode = acquireVsCodeApi();
          
          // Get all gallery items for navigation
          const getAllGalleryItems = () => {
            return Array.from(document.querySelectorAll('.gallery-item:not([style*="display: none"])'));
          };
          
          let currentImageIndex = -1;
          let currentTestFile = '';
          
          // Open test file
          function openTestFile(testFile) {
            console.log('Opening test file:', testFile);
            // Send a message to the extension host
            vscode.postMessage({
              command: 'openTestFile',
              testFile: testFile
            });
          }
          
          function openModal(filePath, webviewUri, testFile) {
            const modal = document.getElementById('image-modal');
            const modalImage = document.getElementById('modal-image');
            const modalPath = document.getElementById('modal-path');
            const modalTestFile = document.getElementById('modal-test-file');
            const modalTestFileHeader = document.getElementById('modal-test-file-header');
            
            // Store the current test file
            currentTestFile = testFile;
            
            // Update the header with the test file name
            if (testFile) {
              modalTestFileHeader.textContent = \`Snapshot from \${testFile}\`;
            } else {
              modalTestFileHeader.textContent = 'Snapshot Preview';
            }
            
            // Set image source directly
            modalImage.src = webviewUri;
            
            // Show the modal
            modal.style.display = 'flex';
            
            // Get the item that was clicked and set the current index
            const items = getAllGalleryItems();
            currentImageIndex = items.findIndex(item => item.getAttribute('data-file-path') === filePath);
            
            // Update navigation buttons state
            updateNavigationButtons();
            
            // Format and display the file path
            const formattedPath = filePath;
            modalPath.textContent = formattedPath;
            
            // Set the test file with a link to open it
            modalTestFile.innerHTML = testFile ? 
              \`<span class="file-badge" onclick="openTestFile('\${testFile}')">
                <svg viewBox="0 0 16 16">
                  <path d="M13.71 4.29l-3-3L10 2h-.59L4 2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h9c.55 0 1-.45 1-1V5l-.29-.71zM13 13H4V3h5v3h4v7z"/>
                </svg>
                Open File
               </span>\` : '';
          }
          
          function closeModal() {
            document.getElementById('image-modal').style.display = 'none';
          }
          
          function navigateImages(direction) {
            const visibleItems = getAllGalleryItems();
            
            if (visibleItems.length === 0) return;
            
            let newIndex = currentImageIndex;
            if (direction === 'next' && currentImageIndex < visibleItems.length - 1) {
              newIndex = currentImageIndex + 1;
            } else if (direction === 'prev' && currentImageIndex > 0) {
              newIndex = currentImageIndex - 1;
            }
            
            if (newIndex !== currentImageIndex) {
              const nextItem = visibleItems[newIndex];
              if (nextItem) {
                const filePath = nextItem.getAttribute('data-file-path');
                const webviewUri = nextItem.getAttribute('data-webview-uri');
                const testFile = nextItem.getAttribute('data-test-file');
                currentImageIndex = newIndex; // Set new index first to prevent bounce
                openModal(filePath, webviewUri, testFile);
              }
            }
          }
          
          function updateNavigationButtons() {
            const visibleItems = getAllGalleryItems();
            const prevButton = document.getElementById('prev-button');
            const nextButton = document.getElementById('next-button');
            
            if (prevButton) prevButton.disabled = currentImageIndex <= 0;
            if (nextButton) nextButton.disabled = currentImageIndex >= visibleItems.length - 1;
          }
          
          // Close modal when clicking outside content
          document.getElementById('image-modal').addEventListener('click', function(event) {
            if (event.target === this) {
              closeModal();
            }
          });
          
          // Keyboard navigation
          document.addEventListener('keydown', function(event) {
            if (document.getElementById('image-modal').style.display !== 'flex') return;
            
            if (event.key === 'ArrowRight') {
              navigateImages('next');
              event.preventDefault();
            } else if (event.key === 'ArrowLeft') {
              navigateImages('prev');
              event.preventDefault();
            } else if (event.key === 'Escape') {
              closeModal();
              event.preventDefault();
            }
          });
          
          // Search functionality
          document.getElementById('search-input').addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const testGroups = document.querySelectorAll('.test-group');
            
            testGroups.forEach(group => {
              const testFile = group.getAttribute('data-test-file').toLowerCase();
              const items = group.querySelectorAll('.gallery-item');
              let hasVisibleItems = false;
              
              items.forEach(item => {
                const filePath = item.getAttribute('data-file-path').toLowerCase();
                const shouldShow = testFile.includes(searchTerm) || filePath.includes(searchTerm);
                
                item.style.display = shouldShow ? 'flex' : 'none';
                if (shouldShow) hasVisibleItems = true;
              });
              
              group.style.display = hasVisibleItems ? 'block' : 'none';
            });
            
            // Update navigation if we're in the modal
            if (document.getElementById('image-modal').style.display === 'flex') {
              updateNavigationButtons();
            }
          });
        </script>
      </body>
      </html>
    `;
    
    panel.webview.html = htmlContent;
    
  } catch (error: any) {
    outputChannel.appendLine(`Error opening snapshot gallery: ${error}`);
    vscode.window.showErrorMessage(`Failed to open snapshot gallery: ${error}`);
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

  // View Snapshot Gallery
  let viewSnapshotGallery = vscode.commands.registerCommand(
    "playwright-helpers.viewSnapshotGallery",
    openSnapshotGallery
  );

  // View Visual Testing Report Gallery
  let viewVisualTestingReportGallery = vscode.commands.registerCommand(
    "playwright-helpers.viewVisualTestingReportGallery",
    () => openTestResultsGallery(outputChannel)
  );

  context.subscriptions.push(
    updateFile,
    updateAll,
    updateDir,
    updateSelectedTest,
    showSnapshotDiff,
    viewSnapshotGallery,
    viewVisualTestingReportGallery
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
