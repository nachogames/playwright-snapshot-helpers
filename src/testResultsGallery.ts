import * as vscode from "vscode";
import { dirname, join, basename, isAbsolute, relative, normalize, sep } from "path";
import { existsSync, readFileSync } from "fs";
import { glob } from "glob";

let outputChannel: vscode.OutputChannel;

/**
 * Represents a discovered test results location
 */
interface TestResultsLocation {
  /** Full path to the test-results.json file */
  path: string;
  /** Relative path for display purposes */
  relativePath: string;
  /** Parent directory name (for display) */
  displayName: string;
  /** The base directory containing this results file */
  baseDir: string;
}

/**
 * Find all test-results.json files across ALL workspace folders at any nesting level
 * Uses VS Code's built-in file index for fast searching
 */
async function findAllTestResultsFiles(): Promise<TestResultsLocation[]> {
  const locations: TestResultsLocation[] = [];
  
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine("No workspace folders found");
    return locations;
  }
  
  outputChannel.appendLine(`Searching for test results using VS Code file index...`);
  
  const foundFiles = new Set<string>();
  
  // Use VS Code's fast file search for different result file patterns
  const patterns = [
    '**/test-results.json',
    '**/test-results/results.json',
    '**/playwright-report/results.json'
  ];
  
  for (const pattern of patterns) {
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
    files.forEach(f => foundFiles.add(f.fsPath));
  }
  
  outputChannel.appendLine(`Found ${foundFiles.size} potential test results files`);
  
  for (const filePath of foundFiles) {
    // Verify it's a valid JSON file with test results structure
    try {
      const content = readFileSync(filePath, 'utf8');
      const json = JSON.parse(content);
      
      // Basic validation - check if it looks like test results
      if (json && (json.suites || json.tests || json.results || 
          Object.keys(json).some(k => k.toLowerCase().includes('test')))) {
        
        // Find which workspace folder this file belongs to
        const workspaceFolder = workspaceFolders.find(f => filePath.startsWith(f.uri.fsPath));
        const workspaceRoot = workspaceFolder?.uri.fsPath || dirname(filePath);
        const workspaceName = workspaceFolder?.name || basename(dirname(filePath));
        
        const relativePath = relative(workspaceRoot, filePath);
        const baseDir = dirname(filePath);
        
        // Create a clean display name - just the workspace folder name for multi-root
        let displayName: string;
        
        if (workspaceFolders.length > 1) {
          // Multi-root workspace: just show the workspace folder name
          displayName = workspaceName;
        } else {
          // Single workspace: show relative path
          displayName = relativePath;
        }
        
        locations.push({
          path: filePath,
          relativePath: workspaceFolders.length > 1 ? `${workspaceName}/${relativePath}` : relativePath,
          displayName,
          baseDir
        });
        
        outputChannel.appendLine(`Valid test results file: ${workspaceName}/${relativePath}`);
      }
    } catch (error) {
      outputChannel.appendLine(`Skipping invalid file ${filePath}: ${error}`);
    }
  }
  
  // Sort by workspace name then by path
  locations.sort((a, b) => {
    return a.displayName.localeCompare(b.displayName);
  });
  
  outputChannel.appendLine(`Found ${locations.length} valid test results locations`);
  return locations;
}

/**
 * Show a QuickPick to select from multiple test results locations
 */
async function selectTestResultsLocation(locations: TestResultsLocation[]): Promise<TestResultsLocation | undefined> {
  if (locations.length === 0) {
    return undefined;
  }
  
  if (locations.length === 1) {
    return locations[0];
  }
  
  // Create QuickPick with items
  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Select project';
  quickPick.items = locations.map(loc => ({ label: loc.displayName }));
  quickPick.show();
  
  // Wait for selection
  return new Promise<TestResultsLocation | undefined>((resolve) => {
    let resolved = false;
    quickPick.onDidAccept(() => {
      if (resolved) return;
      resolved = true;
      const selected = quickPick.activeItems[0];
      quickPick.dispose();
      if (selected) {
        resolve(locations.find(loc => loc.displayName === selected.label));
      } else {
        resolve(undefined);
      }
    });
    quickPick.onDidHide(() => {
      if (resolved) return;
      resolved = true;
      quickPick.dispose();
      resolve(undefined);
    });
  });
}

/**
 * Opens a gallery view that displays test results with screenshots
 */
export async function openTestResultsGallery(providedOutputChannel?: vscode.OutputChannel) {
  // Use the provided output channel or create a temporary one
  if (providedOutputChannel) {
    outputChannel = providedOutputChannel;
  } else {
    outputChannel = vscode.window.createOutputChannel("Test Results Gallery", {
      log: true,
    });
  }
  
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage("No workspace folder found");
      return;
    }

    outputChannel.appendLine("Finding all test results locations...");
    
    // Create QuickPick immediately with loading state
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Scanning for test results...';
    quickPick.busy = true;
    quickPick.show();
    
    // Find all test results files across ALL workspace folders
    const allLocations = await findAllTestResultsFiles();
    
    // Also check the Playwright config in each workspace folder for configured reporter paths
    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      const configPath = await findPlaywrightConfig(folderPath);
      if (configPath) {
        const jsonReporterPath = await getJsonReporterPath(configPath, folderPath);
        if (jsonReporterPath && existsSync(jsonReporterPath)) {
          const alreadyFound = allLocations.some(loc => loc.path === jsonReporterPath);
          if (!alreadyFound) {
            const relativePath = relative(folderPath, jsonReporterPath);
            const displayName = workspaceFolders.length > 1 ? folder.name : relativePath;
            allLocations.unshift({
              path: jsonReporterPath,
              relativePath: workspaceFolders.length > 1 ? `${folder.name}/${relativePath}` : relativePath,
              displayName,
              baseDir: dirname(jsonReporterPath)
            });
          }
        }
      }
    }
    
    if (allLocations.length === 0) {
      quickPick.dispose();
      vscode.window.showErrorMessage("No test results files found in any workspace folder");
      return;
    }
    
    // If only one location, auto-select it
    if (allLocations.length === 1) {
      quickPick.dispose();
      await openGalleryWithResults(allLocations[0], allLocations, allLocations[0].baseDir);
      return;
    }
    
    // Multiple locations - populate QuickPick and let user choose
    quickPick.busy = false;
    quickPick.placeholder = 'Select project';
    quickPick.items = allLocations.map(loc => ({ label: loc.displayName }));
    
    // Wait for selection
    const selectedLocation = await new Promise<TestResultsLocation | undefined>((resolve) => {
      let resolved = false;
      quickPick.onDidAccept(() => {
        if (resolved) return;
        resolved = true;
        const selected = quickPick.activeItems[0];
        quickPick.dispose();
        if (selected) {
          resolve(allLocations.find(loc => loc.displayName === selected.label));
        } else {
          resolve(undefined);
        }
      });
      quickPick.onDidHide(() => {
        if (resolved) return;
        resolved = true;
        quickPick.dispose();
        resolve(undefined);
      });
    });
    
    if (!selectedLocation) {
      return; // User cancelled
    }
    
    // Now open the gallery with the selected results
    await openGalleryWithResults(selectedLocation, allLocations, selectedLocation.baseDir);
    
  } catch (error) {
    outputChannel.appendLine(`Error opening test results gallery: ${error}`);
    vscode.window.showErrorMessage(`Failed to open test results gallery: ${error}`);
  }
}

/**
 * Opens the gallery panel with specific test results
 */
async function openGalleryWithResults(
  initialLocation: TestResultsLocation, 
  allLocations: TestResultsLocation[],
  workspaceRoot: string
) {
  // Track the currently selected location (mutable)
  let currentLocation = initialLocation;
  
  // Get all workspace folders for local resource access
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const localResourceRoots = workspaceFolders.map(f => vscode.Uri.file(f.uri.fsPath));
  
  // Also add the selected location's base directory
  localResourceRoots.push(vscode.Uri.file(initialLocation.baseDir));
  
  // Create a webview panel
  const panel = vscode.window.createWebviewPanel(
    'testResultsGallery',
    `Failed Test Gallery - ${initialLocation.displayName}`,
    vscode.ViewColumn.One,
    { 
      enableScripts: true, 
      retainContextWhenHidden: true,
      localResourceRoots
    }
  );
  
  // Set initial loading screen
  panel.webview.html = getLoadingHtml();

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'openTestFile':
          try {
            const filePath = message.filePath;
            outputChannel.appendLine(`Opening test file: ${filePath}`);
            
            if (existsSync(filePath)) {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
              await vscode.window.showTextDocument(doc);
              
              // If there's a line number, scroll to it
              if (message.line) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                  const line = parseInt(message.line) - 1; // Convert to 0-based
                  editor.revealRange(
                    new vscode.Range(line, 0, line, 0),
                    vscode.TextEditorRevealType.InCenter
                  );
                  // Set cursor position
                  editor.selection = new vscode.Selection(line, 0, line, 0);
                }
              }
            } else {
              vscode.window.showErrorMessage(`File not found: ${filePath}`);
            }
          } catch (error) {
            outputChannel.appendLine(`Error opening test file: ${error}`);
            vscode.window.showErrorMessage(`Error opening test file: ${error}`);
          }
          break;
          
        case 'viewComparisonDiff':
          try {
            // Call showSnapshotDiff command with the paths
            await vscode.commands.executeCommand(
              'playwright-helpers.showSnapshotDiff',
              message.actual,
              message.expected,
              message.diff
            );
          } catch (error) {
            outputChannel.appendLine(`Error showing diff: ${error}`);
            vscode.window.showErrorMessage(`Error showing diff: ${error}`);
          }
          break;
          
        case 'getImageUris':
          try {
            // Convert file paths to webview URIs
            const uris: {expected?: string, actual?: string, diff?: string} = {};
            
            if (message.expected && existsSync(message.expected)) {
              uris.expected = panel.webview.asWebviewUri(vscode.Uri.file(message.expected)).toString();
            }
            
            if (message.actual && existsSync(message.actual)) {
              uris.actual = panel.webview.asWebviewUri(vscode.Uri.file(message.actual)).toString();
            }
            
            if (message.diff && existsSync(message.diff)) {
              uris.diff = panel.webview.asWebviewUri(vscode.Uri.file(message.diff)).toString();
            }
            
            // Send the URIs back to the webview
            panel.webview.postMessage({
              command: 'imageUris',
              uris
            });
          } catch (error) {
            outputChannel.appendLine(`Error getting image URIs: ${error}`);
          }
          break;
          
        case 'switchResultSet':
          try {
            // User wants to switch to a different result set
            const newLocation = allLocations.find(loc => loc.relativePath === message.relativePath);
            if (newLocation) {
              outputChannel.appendLine(`Switching to result set: ${newLocation.relativePath}`);
              currentLocation = newLocation; // Update current location
              await loadAndDisplayResults(panel, currentLocation, allLocations, workspaceRoot);
            }
          } catch (error) {
            outputChannel.appendLine(`Error switching result set: ${error}`);
            vscode.window.showErrorMessage(`Error switching result set: ${error}`);
          }
          break;
          
        case 'refreshGallery':
          try {
            outputChannel.appendLine(`Refreshing failed test gallery for: ${currentLocation.displayName}`);
            // Show loading screen during refresh
            panel.webview.html = getLoadingHtml("Refreshing Gallery...", "Reloading test results, please wait...");
            // Reload the current location (not the initial one)
            await loadAndDisplayResults(panel, currentLocation, allLocations, workspaceRoot);
            vscode.window.showInformationMessage("Gallery refreshed successfully.");
          } catch (error) {
            outputChannel.appendLine(`Error refreshing gallery: ${error}`);
            vscode.window.showErrorMessage(`Error refreshing gallery: ${error}`);
          }
          break;
      }
    },
    undefined,
    []
  );

  // Load and display the results
  await loadAndDisplayResults(panel, currentLocation, allLocations, workspaceRoot);
}

/**
 * Load test results and update the panel display
 */
async function loadAndDisplayResults(
  panel: vscode.WebviewPanel,
  selectedLocation: TestResultsLocation,
  allLocations: TestResultsLocation[],
  workspaceRoot: string
) {
  outputChannel.appendLine(`Loading results from: ${selectedLocation.path}`);
  
  let testResultsJson: any = null;
  
  try {
    const content = readFileSync(selectedLocation.path, 'utf8');
    testResultsJson = JSON.parse(content);
    outputChannel.appendLine(`Successfully parsed JSON from: ${selectedLocation.path}`);
  } catch (error) {
    outputChannel.appendLine(`Error parsing JSON: ${error}`);
    panel.webview.html = getNoResultsHtml('no-file');
    vscode.window.showErrorMessage(`Failed to parse test results: ${error}`);
    return;
  }
  
  // Process the test results to extract test information and screenshots
  const testResults = processTestResults(testResultsJson, workspaceRoot, selectedLocation.path);
  
  if (testResults.length === 0) {
    // Determine if we have tests but no screenshots or just no failed tests
    const hasTests = testResultsJson.tests?.length > 0 || 
                    (testResultsJson.suites && Array.isArray(testResultsJson.suites) && testResultsJson.suites.length > 0) ||
                    Object.keys(testResultsJson).some(key => 
                      key.toLowerCase().includes('test') || 
                      key.toLowerCase().includes('spec') ||
                      key.toLowerCase().includes('case'));
                      
    if (hasTests) {
      panel.webview.html = getNoResultsHtml('no-screenshots');
      vscode.window.showErrorMessage("No test results with screenshots found");
    } else {
      panel.webview.html = getNoResultsHtml('no-failed-tests');
      vscode.window.showInformationMessage("No failed tests found");
    }
    return;
  }
  
  // Update panel title
  panel.title = `Failed Test Gallery - ${selectedLocation.displayName}`;
  
  // Generate HTML for the gallery view with result set selector
  const htmlContent = generateGalleryHtml(testResults, panel, workspaceRoot, selectedLocation, allLocations);
  panel.webview.html = htmlContent;
}

/**
 * Find the Playwright config file in the workspace
 */
async function findPlaywrightConfig(workspaceRoot: string): Promise<string | undefined> {
  const configFiles = [
    join(workspaceRoot, "playwright.config.ts"),
    join(workspaceRoot, "playwright.config.js"),
    join(workspaceRoot, "playwright.config.mjs"),
    join(workspaceRoot, "playwright.config.cjs")
  ];

  for (const configFile of configFiles) {
    if (existsSync(configFile)) {
      return configFile;
    }
  }
  
  // If not found in root, try to find it with glob
  // Normalize path for glob (prefers forward slashes even on Windows)
  const configPattern = join(workspaceRoot, "**/playwright.config.{ts,js,mjs,cjs}").replace(/\\/g, '/');
  const configPaths = await glob(configPattern);
  return configPaths.length > 0 ? configPaths[0] : undefined;
}

/**
 * Parse the Playwright config to find the JSON reporter output file path
 */
async function getJsonReporterPath(configPath: string, workspaceRoot: string): Promise<string | undefined> {
  try {
    const configContent = readFileSync(configPath, 'utf8');
    outputChannel.appendLine(`Parsing Playwright config for reporter configuration...`);
    
    // Log a snippet of the config for debugging
    const configSnippet = configContent.length > 500 
      ? configContent.substring(0, 500) + '...' 
      : configContent;
    outputChannel.appendLine(`Config snippet: ${configSnippet}`);
    
    // Try to match the specific pattern in the user's config first (highest priority)
    // reporter: [['html'], ['./tests/reporters/custom-json-reporter.ts', { outputFile: 'test-results/test-results.json' }]]
    const specificPatternRegex = /reporter\s*:.*?\[\s*\[.*?\]\s*,\s*\[\s*['"`](.*?)['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const specificMatch = configContent.match(specificPatternRegex);
    
    if (specificMatch && specificMatch[2]) {
      const reporterPath = specificMatch[1];
      const outputFile = specificMatch[2];
      outputChannel.appendLine(`Found specific pattern with reporter: ${reporterPath} and outputFile: ${outputFile}`);
      const resolvedPath = join(workspaceRoot, outputFile);
      outputChannel.appendLine(`Resolved output path: ${resolvedPath}`);
      
      // Check if file exists
      if (existsSync(resolvedPath)) {
        outputChannel.appendLine(`Custom reporter output file exists at: ${resolvedPath}`);
        return resolvedPath;
      } else {
        outputChannel.appendLine(`Custom reporter output file does not exist at: ${resolvedPath}`);
      }
    }
    
    // First, try to find any reporter with an outputFile parameter
    // This will match custom reporters too, not just the standard json reporter
    const customReporterRegex = /reporter\s*:.*?\[\s*\[.*?\]\s*,\s*\[\s*['"`](.*?)['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const customMatch = configContent.match(customReporterRegex);
    
    if (customMatch && customMatch[2]) {
      const reporterPath = customMatch[1];
      const outputFile = customMatch[2];
      outputChannel.appendLine(`Found custom reporter: ${reporterPath} with outputFile: ${outputFile}`);
      const resolvedPath = join(workspaceRoot, outputFile);
      outputChannel.appendLine(`Resolved output path: ${resolvedPath}`);
      
      // Check if file exists
      if (existsSync(resolvedPath)) {
        outputChannel.appendLine(`Custom reporter output file exists at: ${resolvedPath}`);
        return resolvedPath;
      } else {
        outputChannel.appendLine(`Custom reporter output file does not exist at: ${resolvedPath}`);
      }
    }
    
    // Look for JSON reporter configuration (standard format)
    const jsonReporterRegex = /reporter\s*:.*?\[\s*['"`]json['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const match = configContent.match(jsonReporterRegex);
    
    if (match && match[1]) {
      // Get the output file path and resolve it relative to workspace root
      const outputFile = match[1];
      outputChannel.appendLine(`Found standard json reporter with outputFile: ${outputFile}`);
      const resolvedPath = join(workspaceRoot, outputFile);
      outputChannel.appendLine(`Resolved output path: ${resolvedPath}`);
      
      // Check if file exists
      if (existsSync(resolvedPath)) {
        outputChannel.appendLine(`Standard reporter output file exists at: ${resolvedPath}`);
        return resolvedPath;
      } else {
        outputChannel.appendLine(`Standard reporter output file does not exist at: ${resolvedPath}`);
      }
    }
    
    // Try alternative format: reporter: [['json', { outputFile: 'path' }]]
    const altJsonReporterRegex = /reporter\s*:.*?\[\s*\[\s*['"`]json['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const altMatch = configContent.match(altJsonReporterRegex);
    
    if (altMatch && altMatch[1]) {
      outputChannel.appendLine(`Found alternative json reporter format with outputFile: ${altMatch[1]}`);
      const resolvedPath = join(workspaceRoot, altMatch[1]);
      outputChannel.appendLine(`Resolved output path: ${resolvedPath}`);
      
      // Check if file exists
      if (existsSync(resolvedPath)) {
        outputChannel.appendLine(`Alternative reporter output file exists at: ${resolvedPath}`);
        return resolvedPath;
      } else {
        outputChannel.appendLine(`Alternative reporter output file does not exist at: ${resolvedPath}`);
      }
    }
    
    // Generic approach: look for any outputFile in the reporter section
    const genericOutputFileRegex = /reporter\s*:.*?outputFile\s*:\s*['"`](.*?)['"`]/s;
    const genericMatch = configContent.match(genericOutputFileRegex);
    
    if (genericMatch && genericMatch[1]) {
      outputChannel.appendLine(`Found generic outputFile in reporter section: ${genericMatch[1]}`);
      const resolvedPath = join(workspaceRoot, genericMatch[1]);
      outputChannel.appendLine(`Resolved output path: ${resolvedPath}`);
      
      // Check if file exists
      if (existsSync(resolvedPath)) {
        outputChannel.appendLine(`Generic reporter output file exists at: ${resolvedPath}`);
        return resolvedPath;
      } else {
        outputChannel.appendLine(`Generic reporter output file does not exist at: ${resolvedPath}`);
      }
    }
    
    // Specific hard-coded fallback for the known pattern
    outputChannel.appendLine(`Trying hard-coded fallback for test-results/test-results.json`);
    const hardcodedPath = join(workspaceRoot, 'test-results', 'test-results.json');
    if (existsSync(hardcodedPath)) {
      outputChannel.appendLine(`Found fallback file at: ${hardcodedPath}`);
      return hardcodedPath;
    } else {
      outputChannel.appendLine(`Fallback file not found at: ${hardcodedPath}`);
    }
    
    outputChannel.appendLine(`No reporter with outputFile found in config`);
    return undefined;
  } catch (error) {
    outputChannel.appendLine(`Error parsing Playwright config: ${error}`);
    return undefined;
  }
}

/**
 * Resolve attachment path, handling moved projects where absolute paths might be invalid
 */
function resolveAttachmentPath(originalPath: string, workspaceRoot: string, resultsFilePath: string, testFile?: string): string | null {
  if (!originalPath) return null;
  
  let attachmentPath = originalPath;
  
  // If path is relative, resolve it against workspace root (standard behavior)
  if (!isAbsolute(attachmentPath)) {
    attachmentPath = join(workspaceRoot, attachmentPath);
  }
  
  // If file exists, we're good
  if (existsSync(attachmentPath)) {
    return attachmentPath;
  }
  
  // File doesn't exist - try to recover
  outputChannel.appendLine(`Attachment file does not exist at: ${attachmentPath}`);
  
  // Strategy 1: Rebase relative to the test-results.json file location
  // Playwright usually stores assets in a 'test-results' folder next to the report
  // Check if we can find 'test-results' in the original path
  const testResultsDir = dirname(resultsFilePath);
  
  // Try to find common path segments
  const pathSegments = originalPath.split(/[/\\]/);
  
  // Look for 'test-results' segment
  const testResultsIndex = pathSegments.lastIndexOf('test-results');
  if (testResultsIndex !== -1 && testResultsIndex < pathSegments.length - 1) {
    // Extract everything after 'test-results'
    const relativePart = pathSegments.slice(testResultsIndex + 1).join(sep);
    // Try looking in the directory of the json file (which is usually inside test-results)
    const rebasedPath = join(testResultsDir, relativePart);
    if (existsSync(rebasedPath)) {
      outputChannel.appendLine(`Found attachment by rebasing from test-results: ${rebasedPath}`);
      return rebasedPath;
    }
    
    // Also try looking in the parent of the json file (if json is IN test-results, and images are siblings)
    // Actually, if json is IN test-results, and images are in subfolders of test-results...
    // resultsFilePath: .../test-results/test-results.json
    // testResultsDir: .../test-results
    // relativePart: my-test/image.png
    // rebasedPath: .../test-results/my-test/image.png (Matches above)
  }
  
  // Strategy 2: Just use the basename in common locations
  const fileName = basename(originalPath);
  const alternativePaths = [
    join(testResultsDir, fileName),
    join(workspaceRoot, 'test-results', fileName),
    join(workspaceRoot, 'playwright-report', fileName),
  ];
  
  if (testFile) {
    alternativePaths.push(join(dirname(testFile), fileName));
  }
  
  for (const altPath of alternativePaths) {
    if (existsSync(altPath)) {
      outputChannel.appendLine(`Found attachment at alternative path: ${altPath}`);
      return altPath;
    }
  }
  
  outputChannel.appendLine(`Could not recover attachment path`);
  return null;
}

/**
 * Process the test results JSON to extract test information and screenshots
 */
function processTestResults(resultsJson: any, workspaceRoot: string, resultsFilePath: string): TestResult[] {
  const testResults: TestResult[] = [];
  
  // Log the structure to help with debugging
  outputChannel.appendLine(`Processing test results JSON with keys: ${Object.keys(resultsJson).join(', ')}`);
  
  // Special handling for test-results/test-results.json format which might have a different structure
  if (Object.keys(resultsJson).length > 0 && !resultsJson.suites && !resultsJson.tests && !resultsJson.results) {
    outputChannel.appendLine(`Handling possibly custom JSON format with keys: ${Object.keys(resultsJson).join(', ')}`);
    
    // Try to identify any structure that might contain tests and screenshots
    // This is a more exhaustive approach for custom formats
    
    // Look for any keys that contain 'test' in their name
    const testKeys = Object.keys(resultsJson).filter(key => 
      key.toLowerCase().includes('test') || 
      key.toLowerCase().includes('spec') ||
      key.toLowerCase().includes('case')
    );
    
    if (testKeys.length > 0) {
      outputChannel.appendLine(`Found potential test keys: ${testKeys.join(', ')}`);
      
      for (const key of testKeys) {
        if (Array.isArray(resultsJson[key])) {
          outputChannel.appendLine(`Found array at key '${key}' with ${resultsJson[key].length} items`);
          
          // Process each item in the array as a potential test
          for (const item of resultsJson[key]) {
            outputChannel.appendLine(`Processing possible test with keys: ${Object.keys(item).join(', ')}`);
            
            // Look for attachments
            let attachments: Array<{name?: string, path?: string, contentType?: string, body?: string}> = [];
            
            // Check common attachment keys
            const attachmentKeys = ['attachments', 'screenshots', 'artifacts', 'images'];
            
            for (const attachKey of attachmentKeys) {
              if (item[attachKey] && Array.isArray(item[attachKey])) {
                outputChannel.appendLine(`Found ${item[attachKey].length} attachments at key '${attachKey}'`);
                attachments = attachments.concat(item[attachKey]);
              }
            }
            
            // Also look for image paths in any key of the item
            for (const itemKey of Object.keys(item)) {
              if (typeof item[itemKey] === 'string' && 
                  (item[itemKey].endsWith('.png') || item[itemKey].includes('screenshot'))) {
                outputChannel.appendLine(`Found image path in key '${itemKey}': ${item[itemKey]}`);
                attachments.push({
                  name: itemKey,
                  path: item[itemKey],
                  contentType: 'image/png'
                });
              }
            }
            
            if (attachments.length > 0) {
              outputChannel.appendLine(`Creating test result from custom format with ${attachments.length} attachments`);
              
              // Create test result
              const testResult: TestResult = {
                name: item.title || item.name || key,
                status: item.status || 'unknown',
                duration: item.duration || 0,
                testFile: item.file || item.filename || 'Unknown',
                location: item.location,
                error: item.error?.message || item.errorMessage || '',
                attachments: []
              };
              
              // Process attachments
              for (const attachment of attachments) {
                if (!attachment.path && !attachment.body) {
                  outputChannel.appendLine(`Attachment missing path and body: ${JSON.stringify(attachment)}`);
                  continue;
                }
                
                const attachmentPath = (attachment.path ? resolveAttachmentPath(attachment.path, workspaceRoot, resultsFilePath, testResult.testFile) : undefined) || attachment.path;
                
                if (attachmentPath) {
                  outputChannel.appendLine(`Processing attachment: ${attachmentPath}`);
                }
                
                const relativePath = attachmentPath ? relative(workspaceRoot, attachmentPath) : '';
                
                testResult.attachments.push({
                  name: attachment.name || (attachmentPath ? basename(attachmentPath) : 'Unknown'),
                  path: attachmentPath || '',
                  relativePath,
                  contentType: attachment.contentType || 'image/png',
                  type: getAttachmentType(attachment)
                });
              }
              
              // Find screenshot sets
              const screenshotSet = findScreenshotSet(testResult.attachments);
              if (screenshotSet) {
                testResult.screenshotSet = screenshotSet;
                testResults.push(testResult);
                outputChannel.appendLine(`Added test result from custom format with screenshot set`);
              }
            }
          }
        }
      }
      
      if (testResults.length > 0) {
        outputChannel.appendLine(`Found ${testResults.length} test results from custom format`);
        return testResults;
      }
    }
  }
  
  // Check for custom format from the user's reporter
  if (resultsJson.results) {
    outputChannel.appendLine(`Found 'results' key at top level, might be custom format`);
    
    // Try to process this format
    if (Array.isArray(resultsJson.results)) {
      outputChannel.appendLine(`Results is an array with ${resultsJson.results.length} items`);
      
      for (const result of resultsJson.results) {
        // Log the structure of each result
        outputChannel.appendLine(`Result keys: ${Object.keys(result).join(', ')}`);
        
        // Check if it has attachments
        if (result.attachments && result.attachments.length > 0) {
          outputChannel.appendLine(`Found ${result.attachments.length} attachments`);
          
          // Check for screenshots
          const screenshots = result.attachments.filter((a: any) => 
            a.contentType === 'image/png' || a.name?.includes('.png') || a.path?.includes('.png')
          );
          
          if (screenshots.length > 0) {
            outputChannel.appendLine(`Found ${screenshots.length} screenshots`);
            
            // Create a test result for this
            const testResult: TestResult = {
              name: result.title || result.name || 'Unknown Test',
              status: result.status || 'unknown',
              duration: result.duration || 0,
              testFile: result.file || 'Unknown',
              location: result.location,
              error: result.error?.message || '',
              attachments: []
            };
            
            // Process attachments
            for (const attachment of result.attachments) {
              if (!attachment.path) {
                outputChannel.appendLine(`Attachment missing path: ${JSON.stringify(attachment)}`);
                continue;
              }
              
              outputChannel.appendLine(`Processing attachment: ${attachment.path}`);
              
              // Check if the file exists
              if (!existsSync(attachment.path)) {
                outputChannel.appendLine(`Attachment file does not exist: ${attachment.path}`);
                continue;
              }
              
              const relativePath = relative(workspaceRoot, attachment.path);
              
              testResult.attachments.push({
                name: attachment.name || basename(attachment.path),
                path: attachment.path,
                relativePath,
                contentType: attachment.contentType || 'application/octet-stream',
                type: getAttachmentType(attachment)
              });
            }
            
            // Find screenshot sets
            const screenshotSet = findScreenshotSet(testResult.attachments);
            if (screenshotSet) {
              testResult.screenshotSet = screenshotSet;
              testResults.push(testResult);
              outputChannel.appendLine(`Added test result with screenshot set`);
            } else {
              outputChannel.appendLine(`No screenshot set found for test`);
            }
          } else {
            outputChannel.appendLine(`No screenshots found in attachments`);
          }
        }
      }
    }
  }
  
  if (!resultsJson.suites && !resultsJson.tests) {
    outputChannel.appendLine("Results JSON doesn't have expected structure (missing suites or tests)");
    return testResults;
  }
  
  // Process each suite recursively if available
  if (resultsJson.suites) {
    outputChannel.appendLine(`Processing ${resultsJson.suites.length} suites`);
    for (const suite of resultsJson.suites) {
      processTestSuite(suite, testResults, workspaceRoot, resultsFilePath);
    }
  }
  
  // Some JSON formats might have tests at the top level
  if (resultsJson.tests && Array.isArray(resultsJson.tests)) {
    outputChannel.appendLine(`Processing ${resultsJson.tests.length} top-level tests`);
    for (const test of resultsJson.tests) {
      const testFile = test.file || 'Unknown';
      const testResult = processTest(test, testFile, workspaceRoot, resultsFilePath);
      if (testResult) {
        testResults.push(testResult);
      }
    }
  }
  
  outputChannel.appendLine(`Found ${testResults.length} test results with screenshots`);
  return testResults;
}

// Extract test results from a suite, processing recursively
function processTestSuite(suite: any, results: TestResult[], workspaceRoot: string, resultsFilePath: string) {
  outputChannel.appendLine(`Processing suite: ${suite.title || 'Unnamed Suite'}`);
  
  // Process tests in this suite
  if (suite.tests) {
    outputChannel.appendLine(`Suite has ${suite.tests.length} tests`);
    for (const test of suite.tests) {
      const testResult = processTest(test, suite.file, workspaceRoot, resultsFilePath);
      if (testResult) {
        results.push(testResult);
      }
    }
  } else {
    outputChannel.appendLine(`Suite has no tests array`);
  }
  
  // Process child suites recursively
  if (suite.suites) {
    outputChannel.appendLine(`Suite has ${suite.suites.length} child suites`);
    for (const childSuite of suite.suites) {
      processTestSuite(childSuite, results, workspaceRoot, resultsFilePath);
    }
  } else {
    outputChannel.appendLine(`Suite has no child suites`);
  }
  
  // Some formats might have specs instead of tests
  if (suite.specs) {
    outputChannel.appendLine(`Suite has ${suite.specs.length} specs`);
    for (const spec of suite.specs) {
      const testResult = processTest(spec, suite.file, workspaceRoot, resultsFilePath);
      if (testResult) {
        results.push(testResult);
      }
    }
  }
}

// Extract relevant information from a test
function processTest(test: any, testFile: string, workspaceRoot: string, resultsFilePath: string): TestResult | null {
  outputChannel.appendLine(`Processing test: ${test.title || test.name || 'Unnamed Test'}`);
  outputChannel.appendLine(`Test keys: ${Object.keys(test).join(', ')}`);
  
  // Log the test object for debugging
  try {
    const testJson = JSON.stringify(test, null, 2);
    const snippet = testJson.length > 500 ? testJson.substring(0, 500) + '...' : testJson;
    outputChannel.appendLine(`Test object: ${snippet}`);
  } catch (error) {
    outputChannel.appendLine(`Error stringifying test object: ${error}`);
  }
  
  // Special handling for the format seen in Untitled-2.json
  if (test.snippet && test.attachments) {
    outputChannel.appendLine(`Found potential Untitled-2.json format with snippet and attachments`);
    
    // Create test result object
    const testResult: TestResult = {
      name: test.title || test.name || 'Unknown Test',
      status: test.status || 'unknown',
      duration: test.duration || 0,
      testFile: test.file || testFile || 'Unknown',
      location: test.location,
      error: test.error?.message || '',
      attachments: []
    };
    
    // Process attachments
    for (const attachment of test.attachments) {
      outputChannel.appendLine(`Processing attachment from Untitled-2 format: ${JSON.stringify(attachment)}`);
      
      if (!attachment.path && !attachment.name) {
        outputChannel.appendLine(`Attachment missing path and name`);
        continue;
      }
      
      let attachmentPath = attachment.path;
      
      // If path is relative, resolve it
      if (attachmentPath && !isAbsolute(attachmentPath)) {
        attachmentPath = join(workspaceRoot, attachmentPath);
      }
      
      // Check if the file exists
      if (attachmentPath && !existsSync(attachmentPath)) {
        outputChannel.appendLine(`Attachment file does not exist: ${attachmentPath}`);
        
        // Try alternative paths
        const alternativePaths = [
          join(workspaceRoot, 'test-results', basename(attachmentPath)),
          join(workspaceRoot, 'playwright-report', basename(attachmentPath)),
          join(dirname(testFile), basename(attachmentPath)),
          // Try paths from the attachment name
          attachment.name ? join(workspaceRoot, attachment.name) : '',
          attachment.name ? join(workspaceRoot, 'test-results', attachment.name) : '',
          attachment.name ? join(workspaceRoot, 'playwright-report', attachment.name) : ''
        ].filter(Boolean);
        
        let found = false;
        for (const altPath of alternativePaths) {
          if (existsSync(altPath)) {
            attachmentPath = altPath;
            outputChannel.appendLine(`Found attachment at alternative path: ${altPath}`);
            found = true;
            break;
          }
        }
        
        if (!found) {
          outputChannel.appendLine(`Could not find attachment file at any alternative path`);
          continue;
        }
      }
      
      const relativePath = relative(workspaceRoot, attachmentPath || '');
      const contentType = attachment.contentType || 
                         (attachment.name && attachment.name.endsWith('.png')) ? 'image/png' : 
                         'application/octet-stream';
      
      testResult.attachments.push({
        name: attachment.name || (attachmentPath ? basename(attachmentPath) : 'Unknown'),
        path: attachmentPath || '',
        relativePath,
        contentType,
        type: contentType === 'image/png' ? 'screenshot' : 'other'
      });
    }
    
    // Find screenshot sets
    const screenshotSet = findScreenshotSet(testResult.attachments);
    if (screenshotSet) {
      testResult.screenshotSet = screenshotSet;
      outputChannel.appendLine(`Created test result with screenshot set from Untitled-2 format`);
      return testResult;
    } else {
      outputChannel.appendLine(`No screenshot set found for test in Untitled-2 format`);
    }
  }
  
  // Handle different test result formats
  
  // Format 1: test has results array with attachments
  if (test.results && test.results.length) {
    outputChannel.appendLine(`Test has ${test.results.length} results`);
    
    // Get the first result that has attachments
    const result = test.results.find((r: any) => r.attachments && r.attachments.length > 0) || test.results[0];
    
    outputChannel.appendLine(`Result keys: ${Object.keys(result).join(', ')}`);
    
    // Check for attachments
    if (result.attachments && result.attachments.length > 0) {
      outputChannel.appendLine(`Result has ${result.attachments.length} attachments`);
      
      // Log attachment details
      for (const attachment of result.attachments) {
        outputChannel.appendLine(`Attachment: ${JSON.stringify(attachment)}`);
      }
      
      // Check if any attachments are screenshots
      const hasScreenshots = result.attachments.some((a: any) => 
        a.contentType === 'image/png' || 
        (a.name && a.name.endsWith('.png')) || 
        (a.path && a.path.endsWith('.png'))
      );
      
      if (hasScreenshots) {
        outputChannel.appendLine(`Found screenshots in attachments`);
        
        // Create test result object
        const testResult: TestResult = {
          name: test.title || test.name || 'Unknown Test',
          status: result.status || test.status || 'unknown',
          duration: result.duration || test.duration || 0,
          testFile: test.file || testFile || 'Unknown',
          location: result.location || test.location,
          error: result.error?.message || test.error?.message || '',
          attachments: []
        };
        
        // Process attachments
        for (const attachment of result.attachments) {
          if (!attachment.path && !attachment.body) {
            outputChannel.appendLine(`Attachment missing path and body: ${JSON.stringify(attachment)}`);
            continue;
          }
          
          const attachmentPath = (attachment.path ? resolveAttachmentPath(attachment.path, workspaceRoot, resultsFilePath, testFile) : undefined) || attachment.path;
          
          if (attachmentPath) {
             outputChannel.appendLine(`Processing attachment: ${attachmentPath}`);
          }
          
          const relativePath = attachmentPath ? relative(workspaceRoot, attachmentPath) : '';
          
          testResult.attachments.push({
            name: attachment.name || (attachmentPath ? basename(attachmentPath) : 'Unknown'),
            path: attachmentPath || '',
            relativePath,
            contentType: attachment.contentType || 'application/octet-stream',
            type: getAttachmentType(attachment)
          });
        }
        
        // Find screenshot sets
        const screenshotSet = findScreenshotSet(testResult.attachments);
        if (screenshotSet) {
          testResult.screenshotSet = screenshotSet;
          outputChannel.appendLine(`Created test result with screenshot set`);
          return testResult;
        } else {
          outputChannel.appendLine(`No screenshot set found for test`);
        }
      } else {
        outputChannel.appendLine(`Result has no attachments`);
      }
    } else {
      outputChannel.appendLine(`Result has no attachments`);
    }
  } else if (test.attachments && test.attachments.length) {
    // Format 2: test has attachments directly
    outputChannel.appendLine(`Test has ${test.attachments.length} direct attachments`);
    
    // Log attachment details
    for (const attachment of test.attachments) {
      outputChannel.appendLine(`Attachment: ${JSON.stringify(attachment)}`);
    }
    
    // Check if any attachments are screenshots
    const hasScreenshots = test.attachments.some((a: any) => 
      a.contentType === 'image/png' || 
      (a.name && a.name.endsWith('.png')) || 
      (a.path && a.path.endsWith('.png'))
    );
    
    if (hasScreenshots) {
      outputChannel.appendLine(`Found screenshots in direct attachments`);
      
      // Create test result object
      const testResult: TestResult = {
        name: test.title || test.name || 'Unknown Test',
        status: test.status || 'unknown',
        duration: test.duration || 0,
        testFile: test.file || testFile || 'Unknown',
        location: test.location,
        error: test.error?.message || '',
        attachments: []
      };
      
      // Process attachments
      for (const attachment of test.attachments) {
        if (!attachment.path && !attachment.body) {
          outputChannel.appendLine(`Attachment missing path and body: ${JSON.stringify(attachment)}`);
          continue;
        }
        
        const attachmentPath = (attachment.path ? resolveAttachmentPath(attachment.path, workspaceRoot, resultsFilePath, testFile) : undefined) || attachment.path;
        
        if (attachmentPath) {
          outputChannel.appendLine(`Processing attachment: ${attachmentPath}`);
        }
        
        const relativePath = attachmentPath ? relative(workspaceRoot, attachmentPath) : '';
        
        testResult.attachments.push({
          name: attachment.name || (attachmentPath ? basename(attachmentPath) : 'Unknown'),
          path: attachmentPath || '',
          relativePath,
          contentType: attachment.contentType || 'application/octet-stream',
          type: getAttachmentType(attachment)
        });
      }
      
      // Find screenshot sets
      const screenshotSet = findScreenshotSet(testResult.attachments);
      if (screenshotSet) {
        testResult.screenshotSet = screenshotSet;
        outputChannel.appendLine(`Created test result with screenshot set`);
        return testResult;
      } else {
        outputChannel.appendLine(`No screenshot set found for test`);
      }
    } else {
      outputChannel.appendLine(`No screenshots found in direct attachments`);
    }
  } else {
    // Format 3: Check for special keys that might indicate screenshots
    const specialKeys = ['screenshot', 'screenshots', 'image', 'images', 'actual', 'expected', 'diff'];
    const hasSpecialKeys = specialKeys.some(key => test[key]);
    
    if (hasSpecialKeys) {
      outputChannel.appendLine(`Test has special keys that might indicate screenshots`);
      
      // Create test result object
      const testResult: TestResult = {
        name: test.title || test.name || 'Unknown Test',
        status: test.status || 'unknown',
        duration: test.duration || 0,
        testFile: test.file || testFile || 'Unknown',
        location: test.location,
        error: test.error?.message || '',
        attachments: []
      };
      
      // Process special keys
      for (const key of specialKeys) {
        if (test[key]) {
          outputChannel.appendLine(`Processing special key: ${key} = ${test[key]}`);
          
          // Handle different types of values
          if (typeof test[key] === 'string') {
            // String path
            const resolvedPath = resolveAttachmentPath(test[key], workspaceRoot, resultsFilePath, testFile);
            
            if (resolvedPath) {
              testResult.attachments.push({
                name: `${key}-${basename(resolvedPath)}`,
                path: resolvedPath,
                relativePath: relative(workspaceRoot, resolvedPath),
                contentType: 'image/png',
                type: 'screenshot'
              });
            }
          } else if (Array.isArray(test[key])) {
            // Array of paths or objects
            for (const item of test[key]) {
              if (typeof item === 'string') {
                const resolvedPath = resolveAttachmentPath(item, workspaceRoot, resultsFilePath, testFile);
                
                if (resolvedPath) {
                  testResult.attachments.push({
                    name: `${key}-${basename(resolvedPath)}`,
                    path: resolvedPath,
                    relativePath: relative(workspaceRoot, resolvedPath),
                    contentType: 'image/png',
                    type: 'screenshot'
                  });
                }
              } else if (typeof item === 'object' && item !== null) {
                // Object with path or other properties
                if (item.path) {
                  const resolvedPath = resolveAttachmentPath(item.path, workspaceRoot, resultsFilePath, testFile);
                  
                  if (resolvedPath) {
                    testResult.attachments.push({
                      name: item.name || `${key}-${basename(resolvedPath)}`,
                      path: resolvedPath,
                      relativePath: relative(workspaceRoot, resolvedPath),
                      contentType: item.contentType || 'image/png',
                      type: 'screenshot'
                    });
                  }
                }
              }
            }
          }
        }
      }
      
      // Find screenshot sets
      const screenshotSet = findScreenshotSet(testResult.attachments);
      if (screenshotSet) {
        testResult.screenshotSet = screenshotSet;
        outputChannel.appendLine(`Created test result with screenshot set from special keys`);
        return testResult;
      }
    }
  }
  
  outputChannel.appendLine(`No screenshots found for test`);
  return null;
}

// Determine the type of attachment
function getAttachmentType(attachment: any): 'screenshot' | 'trace' | 'other' {
  if (attachment.contentType === 'image/png' || attachment.type === 'screenshot') {
    return 'screenshot';
  } else if (attachment.contentType === 'application/zip' || 
             (attachment.path && attachment.path.toLowerCase().endsWith('.zip')) || 
             attachment.type === 'trace') {
    return 'trace';
  }
  return 'other';
}

// Find sets of related screenshots (expected, actual, diff)
function findScreenshotSet(attachments: Attachment[]): ScreenshotSet | null {
  const screenshots = attachments.filter(a => a.type === 'screenshot');
  if (screenshots.length === 0) return null;
  
  const set: ScreenshotSet = {};
  
  // Try to identify the expected, actual, and diff screenshots
  for (const screenshot of screenshots) {
    const name = screenshot.name.toLowerCase();
    const path = normalize(screenshot.path.toLowerCase());
    
    if (name.includes('expected') || path.includes('expected')) {
      set.expected = screenshot;
    } else if (name.includes('actual') || path.includes('actual')) {
      set.actual = screenshot;
    } else if (name.includes('diff') || path.includes('diff')) {
      set.diff = screenshot;
    } else if (!set.actual) {
      // If we can't identify the type, default to actual
      set.actual = screenshot;
    }
  }
  
  return Object.keys(set).length > 0 ? set : null;
}

// Type definitions
interface TestResult {
  name: string;
  status: string;
  duration: number;
  testFile: string;
  location?: {
    file: string;
    line: number;
    column: number;
  };
  error?: string;
  attachments: Attachment[];
  screenshotSet?: ScreenshotSet;
}

interface Attachment {
  name: string;
  path: string;
  relativePath: string;
  contentType: string;
  type: 'screenshot' | 'trace' | 'other';
}

interface ScreenshotSet {
  expected?: Attachment;
  actual?: Attachment;
  diff?: Attachment;
}

/**
 * Generate HTML for the loading screen
 */
function getLoadingHtml(message: string = "Loading Test Results...", detail: string = "Searching for test results and screenshots..."): string {
  return `
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
        .spinner {
          border: 4px solid rgba(255, 255, 255, 0.1);
          border-radius: 50%;
          border-top: 4px solid var(--vscode-button-background);
          width: 40px;
          height: 40px;
          margin: 20px auto;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="loader-container">
        <div class="spinner"></div>
        <h2>${message}</h2>
        <p>${detail}</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate HTML for when no results are found
 */
function getNoResultsHtml(reason?: 'no-file' | 'no-failed-tests' | 'no-screenshots'): string {
  let title = "No Test Results Found";
  let message = "";
  let additionalInfo = "";

  switch (reason) {
    case 'no-file':
      message = "Couldn't find a test results JSON file in your workspace.";
      additionalInfo = "Make sure you have run your tests with a JSON reporter configured:";
      break;
    case 'no-failed-tests':
      title = "No Failed Tests Found";
      message = "Your tests are all passing! There are no failed tests to display in the gallery.";
      additionalInfo = "The gallery only shows failed tests with screenshots. To see screenshots in the gallery, you need failing tests.";
      break;
    case 'no-screenshots':
      title = "No Screenshots Found";
      message = "Found test results, but there are no screenshots attached to your tests.";
      additionalInfo = "Make sure you've enabled screenshots in your Playwright configuration:";
      break;
    default:
      message = "Couldn't find any test results with screenshots.";
      additionalInfo = "Make sure you've run your tests with screenshots enabled and a JSON reporter configured:";
  }

  return `
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
        .empty-container {
          text-align: center;
          max-width: 600px;
          padding: 20px;
        }
        h2 {
          margin: 0 0 20px 0;
          padding: 0;
        }
        p {
          margin-bottom: 15px;
        }
        code {
          display: block;
          padding: 10px;
          background: var(--vscode-editor-inactiveSelectionBackground);
          border-radius: 4px;
          margin: 10px 0;
          text-align: left;
          white-space: pre;
        }
        .config-example {
          margin-top: 25px;
        }
      </style>
    </head>
    <body>
      <div class="empty-container">
        <h2>${title}</h2>
        <p>${message}</p>
        <p>${additionalInfo}</p>
        
        ${reason !== 'no-failed-tests' ? `
        <div class="config-example">
          <code>
// In your playwright.config.ts:

// 1. Add a JSON reporter
reporter: [
  ['html'], // Keep your existing reporters
  ['json', { outputFile: 'test-results/test-results.json' }]
],

// 2. Configure screenshots for tests
use: {
  // Capture screenshots on test failures
  screenshot: 'only-on-failure'
}
          </code>
        </div>
        ` : ''}
        
        ${reason === 'no-screenshots' ? `
        <p>Or add screenshots manually in your tests:</p>
        <code>
// Add in your test:
await page.screenshot({ path: 'screenshot.png' });
        </code>
        ` : ''}
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate the HTML for the gallery view
 */
function generateGalleryHtml(
  testResults: TestResult[], 
  panel: vscode.WebviewPanel, 
  workspaceRoot: string,
  selectedLocation?: TestResultsLocation,
  allLocations?: TestResultsLocation[]
): string {
  // Group test results by test file
  const resultsByFile: { [file: string]: TestResult[] } = {};
  
  for (const result of testResults) {
    const file = result.testFile || 'Unknown';
    if (!resultsByFile[file]) {
      resultsByFile[file] = [];
    }
    resultsByFile[file].push(result);
  }
  
  // Generate HTML for each test group
  let testGroupsHtml = '';
  const fileNames = Object.keys(resultsByFile).sort();
  
  for (const file of fileNames) {
    const results = resultsByFile[file];
    const fileName = basename(file);
    
    testGroupsHtml += `
      <div class="test-group" data-file="${file}">
        <div class="test-file-header">
          <h2>${fileName}</h2>
          <button class="file-button" onclick="openTestFile('${file}')">
            <svg viewBox="0 0 16 16" width="16" height="16">
              <path fill="currentColor" d="M13.71 4.29l-3-3L10 2h-.59L4 2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h9c.55 0 1-.45 1-1V5l-.29-.71zM13 13H4V3h5v3h4v7z"/>
            </svg>
            Open File
          </button>
        </div>
        <div class="tests-grid">
    `;
    
    for (const result of results) {
      // Skip if no screenshot set
      if (!result.screenshotSet) continue;
      
      // Convert screenshot paths to webview URIs for display
      const screenshots: {
        expected?: string;
        actual?: string;
        diff?: string;
      } = {};
      
      if (result.screenshotSet.expected && existsSync(result.screenshotSet.expected.path)) {
        screenshots.expected = panel.webview.asWebviewUri(
          vscode.Uri.file(result.screenshotSet.expected.path)
        ).toString();
      }
      
      if (result.screenshotSet.actual && existsSync(result.screenshotSet.actual.path)) {
        screenshots.actual = panel.webview.asWebviewUri(
          vscode.Uri.file(result.screenshotSet.actual.path)
        ).toString();
      }
      
      if (result.screenshotSet.diff && existsSync(result.screenshotSet.diff.path)) {
        screenshots.diff = panel.webview.asWebviewUri(
          vscode.Uri.file(result.screenshotSet.diff.path)
        ).toString();
      }
      
      // Choose which image to display in the gallery
      let primaryImage = screenshots.diff || screenshots.actual || screenshots.expected;
      if (!primaryImage) continue; // Skip if no images available
      
      // Set status class and badge
      const statusClass = result.status === 'passed' ? 'passed' : 
                          result.status === 'failed' ? 'failed' : 'skipped';
      
      // Create location data for navigation
      const locationAttr = result.location ? 
        `data-file="${result.location.file}" data-line="${result.location.line}" data-column="${result.location.column}"` : 
        `data-file="${result.testFile}"`;
      
      // Format duration
      const duration = result.duration ? `${(result.duration / 1000).toFixed(2)}s` : '';
      
      // Create screenshot comparison data
      let comparisonData = '';
      if (screenshots.expected && screenshots.actual && screenshots.diff) {
        comparisonData = `data-expected="${result.screenshotSet.expected?.path}" data-actual="${result.screenshotSet.actual?.path}" data-diff="${result.screenshotSet.diff?.path}"`;
      }
      
      // Create a unique ID for this test item
      const testId = `test-${result.testFile.replace(/[^a-zA-Z0-9]/g, '-')}-${result.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
      
      testGroupsHtml += `
        <div class="test-item ${statusClass}" id="${testId}" ${locationAttr} ${comparisonData}>
          <div class="screenshot-container">
            <img src="${primaryImage}" alt="${result.name}" class="screenshot-image" onclick="openScreenshotModal(this)" />
            <div class="status-badge ${statusClass}">${result.status}</div>
            ${screenshots.diff ? `<div class="diff-badge" onclick="viewDiff(this)">View Diff</div>` : ''}
          </div>
          <div class="test-info">
            <div class="test-name" title="${result.name}">${result.name}</div>
            <div class="test-meta">
              ${duration ? `<span class="duration">${duration}</span>` : ''}
              <span class="open-button" onclick="openTestLocation(this)">Go to Test</span>
            </div>
          </div>
        </div>
      `;
    }
    
    testGroupsHtml += `
        </div>
      </div>
    `;
  }
  
  // Generate result set selector if multiple locations available
  const hasMultipleLocations = allLocations && allLocations.length > 1;
  const resultSetSelectorHtml = hasMultipleLocations ? `
    <div class="result-set-selector">
      <label for="result-set-dropdown">Project:</label>
      <select id="result-set-dropdown" onchange="switchResultSet(this.value)">
        ${allLocations.map(loc => `
          <option value="${loc.relativePath}" ${loc.relativePath === selectedLocation?.relativePath ? 'selected' : ''}>
            ${loc.displayName}
          </option>
        `).join('')}
      </select>
      <button class="refresh-button" onclick="refreshGallery()" title="Refresh">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path fill="currentColor" d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 1 0 1.563-4.163l-.755-.756A6 6 0 1 1 2.006 8.267z"/>
        </svg>
      </button>
    </div>
  ` : `
    <button class="refresh-button" onclick="refreshGallery()" title="Refresh">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="currentColor" d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 1 0 1.563-4.163l-.755-.756A6 6 0 1 1 2.006 8.267z"/>
      </svg>
    </button>
  `;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          font-family: system-ui;
          margin: 0;
          padding: 0;
          background: var(--vscode-editor-background);
          color: var(--vscode-editor-foreground);
        }
        
        .header {
          position: sticky;
          top: 0;
          background: var(--vscode-editor-background);
          padding: 15px 20px;
          border-bottom: 1px solid var(--vscode-widget-border);
          z-index: 100;
        }
        
        .header-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 15px;
          flex-wrap: wrap;
          gap: 15px;
        }
        
        h1 {
          margin: 0;
        }
        
        .result-set-selector {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .result-set-selector label {
          font-size: 13px;
          font-weight: 500;
          color: var(--vscode-descriptionForeground);
          white-space: nowrap;
        }
        
        #result-set-dropdown {
          padding: 6px 12px;
          font-size: 13px;
          background: var(--vscode-dropdown-background);
          color: var(--vscode-dropdown-foreground);
          border: 1px solid var(--vscode-dropdown-border);
          border-radius: 4px;
          cursor: pointer;
          min-width: 180px;
        }
        
        #result-set-dropdown:hover {
          border-color: var(--vscode-focusBorder);
        }
        
        #result-set-dropdown:focus {
          outline: none;
          border-color: var(--vscode-focusBorder);
          box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }
        
        .refresh-button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: 1px solid var(--vscode-button-border, transparent);
          border-radius: 4px;
          cursor: pointer;
          transition: background-color 0.1s;
        }
        
        .refresh-button:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .refresh-button svg {
          flex-shrink: 0;
        }
        
        .stats {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          margin-bottom: 15px;
        }
        
        .search-container {
          margin-bottom: 15px;
        }
        
        #search-input {
          width: 100%;
          max-width: 400px;
          padding: 8px 12px;
          font-size: 14px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
        }
        
        .container {
          padding: 20px;
        }
        
        .test-group {
          margin-bottom: 40px;
        }
        
        .test-file-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 15px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        .test-file-header h2 {
          margin: 0;
        }
        
        .file-button {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s ease;
        }
        
        .file-button:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .tests-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 20px;
        }
        
        .test-item {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-widget-border);
          border-radius: 6px;
          overflow: hidden;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .test-item:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        .test-item.active {
          border: 2px solid var(--vscode-focusBorder);
          box-shadow: 0 0 0 2px var(--vscode-focusBorder);
        }
        
        .screenshot-container {
          position: relative;
          height: 200px;
          overflow: hidden;
          background: #f0f0f0;
        }
        
        .screenshot-image {
          width: 100%;
          height: 100%;
          object-fit: contain;
          cursor: pointer;
        }
        
        .status-badge {
          position: absolute;
          top: 10px;
          right: 10px;
          padding: 4px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }
        
        .status-badge.passed {
          background: var(--vscode-testing-iconPassed);
          color: white;
        }
        
        .status-badge.failed {
          background: var(--vscode-testing-iconFailed);
          color: white;
        }
        
        .status-badge.skipped {
          background: var(--vscode-testing-iconSkipped);
          color: white;
        }
        
        .diff-badge {
          position: absolute;
          bottom: 10px;
          right: 10px;
          padding: 4px 8px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
        }
        
        .test-info {
          padding: 12px;
        }
        
        .test-name {
          font-weight: 500;
          margin-bottom: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .test-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
        }
        
        .duration {
          color: var(--vscode-descriptionForeground);
        }
        
        .open-button {
          color: var(--vscode-textLink-foreground);
          cursor: pointer;
        }
        
        .open-button:hover {
          text-decoration: underline;
        }
        
        /* Modal */
        .modal {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
          z-index: 1000;
          align-items: center;
          justify-content: center;
          padding: 30px;
        }
        
        .modal-content {
          background: var(--vscode-editor-background);
          max-width: 95%;
          max-height: 90vh;
          width: auto;
          height: auto;
          display: flex;
          flex-direction: column;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 5px 20px rgba(0, 0, 0, 0.3);
          box-sizing: border-box;
          margin: 20px;
        }
        
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px;
          border-bottom: 1px solid var(--vscode-widget-border);
          flex-shrink: 0; /* Prevent header from shrinking */
        }
        
        .modal-title {
          margin: 0;
          font-size: 16px;
        }
        
        .modal-header-buttons {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        #back-to-grid {
          white-space: nowrap; /* Prevent text wrapping */
        }
        
        .file-button {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s ease;
        }
        
        .file-button:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .close-button {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: var(--vscode-editor-foreground);
        }
        
        .modal-body {
          padding: 10px;
          overflow: auto;
          display: flex;
          flex-direction: row;
          gap: 20px;
          background: var(--vscode-editor-inactiveSelectionBackground);
          flex: 1;
          width: 100%;
          box-sizing: border-box;
          align-items: stretch;
          min-height: 0; /* Allow container to shrink */
        }
        
        .image-container {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
          border: 1px solid var(--vscode-widget-border);
          border-radius: 4px;
          background: var(--vscode-editor-background);
          box-sizing: border-box;
          overflow: hidden;
          max-height: calc(80vh - 120px); /* Account for header and footer */
        }
        
        .image-label {
          font-weight: bold;
          margin: 0;
          text-align: center;
          width: 100%;
          padding: 8px 5px;
          border-bottom: 1px solid var(--vscode-widget-border);
          box-sizing: border-box;
          background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        
        .image-content {
          padding: 10px;
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          box-sizing: border-box;
          overflow: auto; /* Only show scrollbars when needed */
          flex: 1;
        }
        
        .image-container img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          display: block;
          margin: auto;
        }
        
        /* Single image view styles */
        .modal-body.single-view {
          flex-direction: column;
          align-items: center;
        }
        
        .modal-body.single-view .image-container {
          width: 100%;
          max-width: none;
          max-height: calc(85vh - 120px);
        }
        
        .modal-body.single-view .image-content {
          max-height: calc(85vh - 160px);
        }
        
        .modal-body.single-view img {
          max-height: calc(85vh - 180px);
        }
        
        .back-to-grid {
          margin-bottom: 10px;
          padding: 5px 10px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          align-self: flex-start;
        }
        
        .back-to-grid:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .modal-footer {
          padding: 15px;
          border-top: 1px solid var(--vscode-widget-border);
          flex-shrink: 0; /* Prevent footer from shrinking */
        }
        
        .footer-info {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          margin-bottom: 10px;
        }
        
        .modal-controls {
          display: flex;
          justify-content: space-between;
          width: 100%;
          gap: 10px;
        }
        
        .nav-button, .close-modal-button {
          padding: 8px 16px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
          flex: 1;
          max-width: 120px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
        }
        
        .nav-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .nav-button:hover:not(:disabled), .close-modal-button:hover {
          background: var(--vscode-button-hoverBackground);
        }
        
        .close-modal-button {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        
        .close-modal-button:hover {
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
        
        #screenshot-modal #diff-button-container {
          display: flex;
          justify-content: center;
          margin-top: 5px;
        }
        
        /* Add this CSS for loading state */
        .loading {
          position: relative;
        }
        
        .loading::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--vscode-editor-background);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-top">
          <h1>Failed Test Gallery</h1>
          ${resultSetSelectorHtml}
        </div>
        <div class="stats">
          ${testResults.length} failed test${testResults.length !== 1 ? 's' : ''} with screenshots${selectedLocation ? ` from ${selectedLocation.displayName}` : ''}. Click on any thumbnail to view full size.
        </div>
        <div class="search-container">
          <input type="text" id="search-input" placeholder="Search for tests..." />
        </div>
      </div>
      
      <div class="container">
        ${testGroupsHtml}
      </div>
      
      <div class="modal" id="screenshot-modal">
        <div class="modal-content">
          <div class="modal-header">
            <button id="back-to-grid" class="nav-button" onclick="backToGridView()" style="display: none;">
              ← Back to Grid
            </button>
            <h3 class="modal-title" id="modal-title">Screenshot</h3>
            <div class="modal-header-buttons">
              <button id="modal-diff-button" class="nav-button" onclick="viewDiffFromModal()" style="display: none;">
                View Diff
              </button>
              <button class="close-button" onclick="closeModal()">&times;</button>
            </div>
          </div>
          
          <div class="modal-body">
            <div class="image-container" id="expected-container">
              <div class="image-label">Expected</div>
              <div class="image-content">
                <img id="expected-image" src="" alt="Expected" onclick="showSingleImage('expected')" />
              </div>
            </div>
            <div class="image-container" id="actual-container">
              <div class="image-label">Actual</div>
              <div class="image-content">
                <img id="actual-image" src="" alt="Actual" onclick="showSingleImage('actual')" />
              </div>
            </div>
            <div class="image-container" id="diff-container">
              <div class="image-label">Diff</div>
              <div class="image-content">
                <img id="diff-image" src="" alt="Diff" onclick="showSingleImage('diff')" />
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <div class="footer-info" id="modal-info"></div>
            <div class="modal-controls">
              <button class="nav-button" id="prev-button" onclick="navigateImages('prev')">
                <svg viewBox="0 0 16 16" width="16" height="16">
                  <path fill="currentColor" d="M9.5 3.5L8.1 2 2 8l6.1 6 1.4-1.5L4.8 8z"/>
                </svg>
                Previous
              </button>
              <button class="close-modal-button" onclick="closeModal()">Close</button>
              <button class="nav-button" id="next-button" onclick="navigateImages('next')">
                Next
                <svg viewBox="0 0 16 16" width="16" height="16">
                  <path fill="currentColor" d="M6.5 12.5L7.9 14 14 8 7.9 2 6.5 3.5 11.2 8z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="keyboard-hint">Use ← → arrow keys to navigate between test cases</div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        let currentTestId = null;
        let singleImageView = false;
        let currentImageType = null; // 'expected', 'actual', or 'diff'
        
        // Switch to a different result set
        function switchResultSet(relativePath) {
          console.log('Switching to result set:', relativePath);
          vscode.postMessage({
            command: 'switchResultSet',
            relativePath: relativePath
          });
        }
        
        // Refresh the gallery
        function refreshGallery() {
          console.log('Refreshing gallery...');
          vscode.postMessage({
            command: 'refreshGallery'
          });
        }
        
        // Debug function to help diagnose issues
        function debugState() {
          console.log("=== DEBUG STATE ===");
          console.log("currentTestId:", currentTestId);
          console.log("singleImageView:", singleImageView);
          console.log("currentImageType:", currentImageType);
          
          const modal = document.getElementById('screenshot-modal');
          console.log("Modal display:", modal ? modal.style.display : "modal not found");
          
          const modalBody = document.querySelector('.modal-body');
          console.log("Modal body has single-view class:", modalBody ? modalBody.classList.contains('single-view') : "modal body not found");
          
          const expectedContainer = document.getElementById('expected-container');
          const actualContainer = document.getElementById('actual-container');
          const diffContainer = document.getElementById('diff-container');
          
          console.log("Expected container display:", expectedContainer ? expectedContainer.style.display : "not found");
          console.log("Actual container display:", actualContainer ? actualContainer.style.display : "not found");
          console.log("Diff container display:", diffContainer ? diffContainer.style.display : "not found");
          
          if (currentTestId) {
            const testItem = document.getElementById(currentTestId);
            if (testItem) {
              console.log("Test item datasets:", {
                expected: testItem.dataset.expected ? "yes" : "no",
                actual: testItem.dataset.actual ? "yes" : "no",
                diff: testItem.dataset.diff ? "yes" : "no"
              });
            } else {
              console.log("Test item not found");
            }
          }
          
          console.log("=== END DEBUG ===");
        }
        
        // Get all visible test items
        function getVisibleTestItems() {
          return Array.from(document.querySelectorAll('.test-item:not([style*="display: none"])'));
        }
        
        // Search functionality
        document.getElementById('search-input').addEventListener('input', function(e) {
          const searchTerm = e.target.value.toLowerCase();
          
          // Search in test names and files
          document.querySelectorAll('.test-item').forEach(item => {
            const testName = item.querySelector('.test-name').textContent.toLowerCase();
            const testFile = item.closest('.test-group').dataset.file.toLowerCase();
            
            if (testName.includes(searchTerm) || testFile.includes(searchTerm)) {
              item.style.display = 'block';
            } else {
              item.style.display = 'none';
            }
          });
          
          // Hide empty groups
          document.querySelectorAll('.test-group').forEach(group => {
            const hasVisibleTests = Array.from(group.querySelectorAll('.test-item'))
              .some(item => item.style.display !== 'none');
            
            group.style.display = hasVisibleTests ? 'block' : 'none';
          });
        });
        
        // Open test file
        function openTestFile(filePath) {
          vscode.postMessage({
            command: 'openTestFile',
            filePath: filePath
          });
        }
        
        // Open test location
        function openTestLocation(element) {
          const testItem = element.closest('.test-item');
          const filePath = testItem.dataset.file;
          const line = testItem.dataset.line;
          
          vscode.postMessage({
            command: 'openTestFile',
            filePath: filePath,
            line: line
          });
        }
        
        // View diff
        function viewDiff(element) {
          const testItem = element.closest('.test-item');
          
          vscode.postMessage({
            command: 'viewComparisonDiff',
            actual: testItem.dataset.actual,
            expected: testItem.dataset.expected,
            diff: testItem.dataset.diff
          });
        }
        
        // Open screenshot modal
        function openScreenshotModal(imgElement, viewState = null) {
          console.log("Opening screenshot modal with viewState:", viewState);
          
          const modal = document.getElementById('screenshot-modal');
          const modalBody = document.querySelector('.modal-body');
          const backButton = document.getElementById('back-to-grid');
          
          if (!modalBody) {
            console.error("Modal body element not found");
            return;
          }
          
          // Get test item and set as current
          const testItem = imgElement.closest('.test-item');
          currentTestId = testItem.id;
          
          // Highlight the current item
          document.querySelectorAll('.test-item').forEach(item => {
            item.classList.remove('active');
          });
          testItem.classList.add('active');
          
          // Get test name and file
          const testName = testItem.querySelector('.test-name').textContent;
          const testFile = testItem.dataset.file || testItem.closest('.test-group').dataset.file;
          
          // Set modal title and info
          document.getElementById('modal-title').textContent = testName;
          document.getElementById('modal-info').textContent = testFile;
          
          // Get all image containers
          const expectedContainer = document.getElementById('expected-container');
          const actualContainer = document.getElementById('actual-container');
          const diffContainer = document.getElementById('diff-container');
          
          // Get the already loaded image source from the thumbnail
          // This is already a valid webview URI so we can use it directly
          const thumbnailImage = imgElement.src;
          
          // Initialize view state
          if (!viewState && testItem.dataset.diff) {
            // If we have a diff image and no specific view state, start in diff view
            singleImageView = true;
            currentImageType = 'diff';
            
            // Add class for single view styling
            modalBody.classList.add('single-view');
            
            // Show back button
            backButton.style.display = 'inline-block';
            
            // Hide all containers except diff
            if (expectedContainer) expectedContainer.style.display = 'none';
            if (actualContainer) actualContainer.style.display = 'none';
            if (diffContainer) diffContainer.style.display = 'flex';
            
            // Set the diff image source directly from the thumbnail
            document.getElementById('diff-image').src = thumbnailImage;
            
            // Update keyboard hint
            const keyboardHint = document.querySelector('.keyboard-hint');
            if (keyboardHint) {
              keyboardHint.textContent = 'Use Ctrl/Cmd + ← → to navigate between images';
            }
          } else if (viewState) {
            // Restore provided view state
            singleImageView = viewState.singleView;
            currentImageType = viewState.imageType;
            
            if (singleImageView) {
              modalBody.classList.add('single-view');
              
              // Show back button
              backButton.style.display = 'inline-block';
              
              // Show only the selected container
              if (expectedContainer) expectedContainer.style.display = currentImageType === 'expected' ? 'flex' : 'none';
              if (actualContainer) actualContainer.style.display = currentImageType === 'actual' ? 'flex' : 'none';
              if (diffContainer) diffContainer.style.display = currentImageType === 'diff' ? 'flex' : 'none';
              
              // Update keyboard hint
              const keyboardHint = document.querySelector('.keyboard-hint');
              if (keyboardHint) {
                keyboardHint.textContent = 'Use Ctrl/Cmd + ← → to navigate between images';
              }
            } else {
              // Grid view
              modalBody.classList.remove('single-view');
              backButton.style.display = 'none';
              
              // Show all containers
              if (expectedContainer) expectedContainer.style.display = 'flex';
              if (actualContainer) actualContainer.style.display = 'flex';
              if (diffContainer) diffContainer.style.display = 'flex';
            }
          } else {
            // Default to grid view
            singleImageView = false;
            currentImageType = null;
            
            modalBody.classList.remove('single-view');
            backButton.style.display = 'none';
            
            // Show all containers
            if (expectedContainer) expectedContainer.style.display = 'flex';
            if (actualContainer) actualContainer.style.display = 'flex';
            if (diffContainer) diffContainer.style.display = 'flex';
            
            // Update keyboard hint
            const keyboardHint = document.querySelector('.keyboard-hint');
            if (keyboardHint) {
              keyboardHint.textContent = 'Use ← → arrow keys to navigate between test cases';
            }
          }
          
          // Show/hide diff button based on availability of diff image
          const modalDiffButton = document.getElementById('modal-diff-button');
          if (testItem.dataset.diff) {
            modalDiffButton.style.display = 'inline-block';
          } else {
            modalDiffButton.style.display = 'none';
          }
          
          // Update navigation buttons
          updateNavigationButtons();
          
          // Show the modal
          modal.style.display = 'flex';
          
          // Always request URIs from the extension to ensure all images are loaded
          vscode.postMessage({
            command: 'getImageUris',
            expected: testItem.dataset.expected,
            actual: testItem.dataset.actual,
            diff: testItem.dataset.diff
          });
          
          // But immediately set the current view's image if we have it from thumbnail
          if (singleImageView) {
            if (currentImageType === 'diff') {
              document.getElementById('diff-image').src = thumbnailImage;
            }
          } else {
            // Try to match which type this thumbnail is
            if (thumbnailImage) {
              // Look for keywords in the URL to determine which type it is
              if (thumbnailImage.includes('diff')) {
                document.getElementById('diff-image').src = thumbnailImage;
              } else if (thumbnailImage.includes('actual')) {
                document.getElementById('actual-image').src = thumbnailImage;
              } else if (thumbnailImage.includes('expected')) {
                document.getElementById('expected-image').src = thumbnailImage;
              } else {
                // If we can't determine, assume it's the actual image
                document.getElementById('actual-image').src = thumbnailImage;
              }
            }
          }
        }
        
        // View diff from modal
        function viewDiffFromModal() {
          // Get the current test item
          const testItem = document.getElementById(currentTestId);
          if (!testItem) return;
          
          // Call the same viewComparisonDiff command as the thumbnail view
          vscode.postMessage({
            command: 'viewComparisonDiff',
            actual: testItem.dataset.actual,
            expected: testItem.dataset.expected,
            diff: testItem.dataset.diff
          });
        }
        
        // Keyboard navigation
        document.addEventListener('keydown', function(e) {
          try {
            // Only handle keyboard navigation when modal is open
            const modal = document.querySelector('.modal');
            if (!modal || modal.style.display !== 'flex') {
              return;
            }
            
            console.log("Key event:", {
              key: e.key,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              altKey: e.altKey,
              shiftKey: e.shiftKey,
              which: e.which
            });
            
            // Check for modifier key (Ctrl or Cmd)
            const isModifierPressed = e.ctrlKey || e.metaKey;
            
            if (e.metaKey) {
              console.log("Command key is pressed!");
            }
            
            console.log("Current view mode:", singleImageView ? "single view" : "grid view");
            
            // Handle arrow keys
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault(); // Prevent scrolling
              
              const direction = e.key === 'ArrowLeft' ? 'prev' : 'next';
              
              console.log("Modifier key pressed:", isModifierPressed, "ctrlKey:", e.ctrlKey, "metaKey:", e.metaKey);
              
              // If in single image view and modifier key is pressed, navigate between images
              if (singleImageView && isModifierPressed) {
                console.log("Navigating images in single view:", direction);
                navigateSingleImages(direction);
              } 
              // Otherwise navigate between tests
              else {
                console.log("Navigating tests:", direction);
                navigateImages(direction);
              }
            }
            
            // Handle Escape key to close modal
            if (e.key === 'Escape') {
              // If in single view mode, go back to grid view
              if (singleImageView) {
                console.log("Escape pressed in single view mode - returning to grid view");
                backToGridView();
              } else {
                // If already in grid view, close the modal
                console.log("Escape pressed in grid view mode - closing modal");
                closeModal();
              }
            }
            
            // Handle 'g' key to go back to grid view
            if (e.key === 'g' && singleImageView) {
              backToGridView();
            }
            
            // Handle 'd' key with Ctrl/Cmd to debug
            if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
              e.preventDefault(); // Prevent browser's bookmark dialog
              console.log("Debug key pressed");
              debugState();
            }
          } catch (error) {
            console.error("Error in keyboard handler:", error);
          }
        });
        
        // Navigate between images in single view
        function navigateSingleImages(direction) {
          try {
            console.log("Navigating images in single view: " + direction);
            
            // Define the order of image types
            const imageTypes = ['expected', 'actual', 'diff'];
            
            // Find current index
            const currentIndex = imageTypes.indexOf(currentImageType);
            if (currentIndex === -1) {
              console.error("Current image type '" + currentImageType + "' not found in image types array");
              return;
            }
            
            // Calculate new index
            let newIndex;
            if (direction === 'next') {
              newIndex = (currentIndex + 1) % imageTypes.length;
            } else {
              newIndex = (currentIndex - 1 + imageTypes.length) % imageTypes.length;
            }
            
            // Get new image type
            const newImageType = imageTypes[newIndex];
            console.log("Navigating from " + currentImageType + " to " + newImageType);
            
            // Show the new image
            showSingleImage(newImageType);
          } catch (error) {
            console.error("Error in navigateSingleImages:", error);
          }
        }
        
        // Show single image view
        function showSingleImage(imageType) {
          console.log("showSingleImage called with imageType:", imageType);
          
          try {
            // Get all the elements we need
            const modalBody = document.querySelector('.modal-body');
            const backButton = document.getElementById('back-to-grid');
            
            if (!modalBody) {
              console.error("Modal body element not found");
              return;
            }
            
            // Get container elements by ID for more reliability
            const expectedContainer = document.getElementById('expected-container');
            const actualContainer = document.getElementById('actual-container');
            const diffContainer = document.getElementById('diff-container');
            
            console.log("Container elements found:", {
              expected: expectedContainer ? "yes" : "no",
              actual: actualContainer ? "yes" : "no",
              diff: diffContainer ? "yes" : "no"
            });
            
            if (!expectedContainer || !actualContainer || !diffContainer) {
              console.error("One or more image containers not found");
              return;
            }
            
            // Save current state
            singleImageView = true;
            currentImageType = imageType;
            console.log("Set state: singleImageView=true, currentImageType=", imageType);
            
            // Add class for single view styling
            modalBody.classList.add('single-view');
            
            // Show back button
            backButton.style.display = 'inline-block';
            
            // Hide all containers first
            expectedContainer.style.display = 'none';
            actualContainer.style.display = 'none';
            diffContainer.style.display = 'none';
            
            // Show only the selected container
            if (imageType === 'expected') {
              expectedContainer.style.display = 'flex';
            } else if (imageType === 'actual') {
              actualContainer.style.display = 'flex';
            } else if (imageType === 'diff') {
              diffContainer.style.display = 'flex';
            }
            
            // Update keyboard hint
            const keyboardHint = document.querySelector('.keyboard-hint');
            if (keyboardHint) {
              keyboardHint.textContent = 'Use ← → to navigate tests, Ctrl/Cmd+← Ctrl/Cmd+→ to navigate images';
            }
            
            // Debug the state after changes
            debugState();
          } catch (error) {
            console.error("Error in showSingleImage:", error);
          }
        }
        
        // Back to grid view
        function backToGridView() {
          console.log("backToGridView called");
          
          try {
            // Get all the elements we need
            const modalBody = document.querySelector('.modal-body');
            const backButton = document.getElementById('back-to-grid');
            
            if (!modalBody) {
              console.error("Modal body element not found");
              return;
            }
            
            // Reset state
            singleImageView = false;
            currentImageType = null;
            console.log("Reset state: singleImageView=false, currentImageType=null");
            
            // Remove single view class
            modalBody.classList.remove('single-view');
            
            // Hide back button
            if (backButton) {
              backButton.style.display = 'none';
            }
            
            // Get all image containers by ID
            const expectedContainer = document.getElementById('expected-container');
            const actualContainer = document.getElementById('actual-container');
            const diffContainer = document.getElementById('diff-container');
            
            if (!expectedContainer || !actualContainer || !diffContainer) {
              console.error("One or more image containers not found");
              return;
            }
            
            // Make all containers visible
            expectedContainer.style.display = 'flex';
            actualContainer.style.display = 'flex';
            diffContainer.style.display = 'flex';
            
            // Update keyboard hint
            const keyboardHint = document.querySelector('.keyboard-hint');
            if (keyboardHint) {
              keyboardHint.textContent = 'Use ← → arrow keys to navigate between test cases';
            }
            
            console.log('Returned to grid view, all containers should be visible');
            
            // Debug the state after changes
            debugState();
          } catch (error) {
            console.error("Error in backToGridView:", error);
          }
        }
        
        // Navigate between images
        function navigateImages(direction) {
          try {
            console.log("navigateImages called with direction: " + direction);
            const visibleItems = getVisibleTestItems();
            if (visibleItems.length === 0) {
              console.log("No visible test items found");
              return;
            }
            
            // Find the current index
            const currentIndex = visibleItems.findIndex(item => item.id === currentTestId);
            if (currentIndex === -1) {
              console.log("Current test ID not found in visible items");
              return;
            }
            
            // Calculate the new index
            let newIndex = currentIndex;
            if (direction === 'next' && currentIndex < visibleItems.length - 1) {
              newIndex = currentIndex + 1;
            } else if (direction === 'prev' && currentIndex > 0) {
              newIndex = currentIndex - 1;
            }
            
            // If the index changed, navigate to the new item
            if (newIndex !== currentIndex) {
              // Save current view state before navigating
              const currentViewState = {
                singleView: singleImageView,
                imageType: currentImageType
              };
              console.log("Saving view state before navigation:", currentViewState);
              
              const nextItem = visibleItems[newIndex];
              const imgElement = nextItem.querySelector('.screenshot-image');
              
              // Pass the current view state to openScreenshotModal
              openScreenshotModal(imgElement, currentViewState);
              
              // Scroll the item into view
              nextItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          } catch (error) {
            console.error("Error in navigateImages:", error);
          }
        }
        
        // Update navigation buttons state
        function updateNavigationButtons() {
          const visibleItems = getVisibleTestItems();
          const currentIndex = visibleItems.findIndex(item => item.id === currentTestId);
          
          const prevButton = document.getElementById('prev-button');
          const nextButton = document.getElementById('next-button');
          
          prevButton.disabled = currentIndex <= 0;
          nextButton.disabled = currentIndex >= visibleItems.length - 1 || currentIndex === -1;
        }
        
        // Close modal
        function closeModal() {
          document.getElementById('screenshot-modal').style.display = 'none';
          
          // Remove highlight from current item
          document.querySelectorAll('.test-item').forEach(item => {
            item.classList.remove('active');
          });
          
          currentTestId = null;
        }
        
        // Close modal when clicking outside
        window.addEventListener('click', function(event) {
          const modal = document.getElementById('screenshot-modal');
          if (event.target === modal) {
            closeModal();
          }
        });
        
        // Listen for messages from the extension
        window.addEventListener('message', event => {
          const message = event.data;
          
          switch (message.command) {
            case 'imageUris':
              // Remove loading class from containers
              document.getElementById('expected-container').classList.remove('loading');
              document.getElementById('actual-container').classList.remove('loading');
              document.getElementById('diff-container').classList.remove('loading');
              
              // Update image sources
              if (message.uris.expected) {
                document.getElementById('expected-image').src = message.uris.expected;
              }
              
              if (message.uris.actual) {
                document.getElementById('actual-image').src = message.uris.actual;
              }
              
              if (message.uris.diff) {
                document.getElementById('diff-image').src = message.uris.diff;
              }
              break;
          }
        });
        
        // Navigate between test cases
        function navigateTests(direction) {
          try {
            console.log("Navigating tests:", direction);
            
            // Get all test items
            const testItems = document.querySelectorAll('.test-item');
            if (!testItems || testItems.length === 0) {
              console.error("No test items found");
              return;
            }
            
            // Convert NodeList to Array for easier manipulation
            const testItemsArray = Array.from(testItems);
            
            // Find current test index
            const currentIndex = testItemsArray.findIndex(item => item.id === currentTestId);
            if (currentIndex === -1) {
              console.error("Current test not found in test items");
              return;
            }
            
            // Calculate new index
            let newIndex;
            if (direction === 'next') {
              newIndex = (currentIndex + 1) % testItemsArray.length;
            } else {
              newIndex = (currentIndex - 1 + testItemsArray.length) % testItemsArray.length;
            }
            
            // Get new test item
            const newTestItem = testItemsArray[newIndex];
            
            // Simulate click on the new test item
            console.log("Navigating to test:", newTestItem.id);
            newTestItem.click();
          } catch (error) {
            console.error("Error in navigateTests:", error);
          }
        }
      </script>
    </body>
    </html>
  `;
} 