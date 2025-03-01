import * as vscode from "vscode";
import { dirname, join, basename } from "path";
import { existsSync, readFileSync } from "fs";
import { glob } from "glob";

let outputChannel: vscode.OutputChannel;

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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found");
      return;
    }

    // Create a webview panel to show loading indicator first
    const panel = vscode.window.createWebviewPanel(
      'testResultsGallery',
      'Failed Test Gallery',
      vscode.ViewColumn.One,
      { 
        enableScripts: true, 
        retainContextWhenHidden: true,
        // Allow access to local file resources
        localResourceRoots: [vscode.Uri.file(workspaceRoot)]
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
        }
      },
      undefined,
      []
    );

    outputChannel.appendLine("Finding test results...");
    
    // First check if we have a file open in the editor that might be results
    let testResultsJson: any = null;
    let testResultsPath: string | null = null;
    
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const filePath = activeEditor.document.uri.fsPath;
      if (filePath.endsWith('.json')) {
        try {
          const content = activeEditor.document.getText();
          testResultsJson = JSON.parse(content);
          testResultsPath = filePath;
          outputChannel.appendLine(`Parsed JSON from active editor: ${filePath}`);
        } catch (error) {
          outputChannel.appendLine(`Error parsing JSON from editor: ${error}`);
        }
      }
    }
    
    // If we didn't get results from the editor, look for the results file in the Playwright config
    if (!testResultsJson) {
      // Find the Playwright config file
      const configPath = await findPlaywrightConfig(workspaceRoot);
      
      if (configPath) {
        outputChannel.appendLine(`Found Playwright config at: ${configPath}`);
        
        // Parse the config to find the reporter output file
        const jsonReporterPath = await getJsonReporterPath(configPath, workspaceRoot);
        
        if (jsonReporterPath) {
          outputChannel.appendLine(`Found JSON reporter output path: ${jsonReporterPath}`);
          
          if (existsSync(jsonReporterPath)) {
            try {
              const content = readFileSync(jsonReporterPath, 'utf8');
              testResultsJson = JSON.parse(content);
              testResultsPath = jsonReporterPath;
              outputChannel.appendLine(`Successfully parsed JSON from reporter output: ${jsonReporterPath}`);
            } catch (error) {
              outputChannel.appendLine(`Error parsing JSON from reporter output: ${error}`);
            }
          } else {
            outputChannel.appendLine(`Reporter output file does not exist: ${jsonReporterPath}`);
          }
        } else {
          outputChannel.appendLine('Could not find JSON reporter configuration in Playwright config');
        }
      } else {
        outputChannel.appendLine('Could not find Playwright config file');
      }
    }
    
    // If still not found, try common locations
    if (!testResultsJson) {
      // First, try the specific file mentioned in the user's config
      const specificFile = join(workspaceRoot, "test-results", "test-results.json");
      outputChannel.appendLine(`Checking for specific file at: ${specificFile}`);
      
      if (existsSync(specificFile)) {
        try {
          outputChannel.appendLine(`Found specific file: ${specificFile}`);
          const content = readFileSync(specificFile, 'utf8');
          
          // Log a snippet of the file content for debugging
          const contentSnippet = content.length > 500 
            ? content.substring(0, 500) + '...' 
            : content;
          outputChannel.appendLine(`File content snippet: ${contentSnippet}`);
          
          testResultsJson = JSON.parse(content);
          testResultsPath = specificFile;
          outputChannel.appendLine(`Successfully parsed JSON from specific file`);
          
          // Log the structure of the parsed JSON
          outputChannel.appendLine(`JSON structure: Top-level keys: ${Object.keys(testResultsJson).join(', ')}`);
          
          // Check if it has suites or tests
          if (testResultsJson.suites) {
            outputChannel.appendLine(`Found ${testResultsJson.suites.length} suites`);
          }
          if (testResultsJson.tests) {
            outputChannel.appendLine(`Found ${testResultsJson.tests.length} tests`);
          }
        } catch (error) {
          outputChannel.appendLine(`Error parsing JSON from specific file: ${error}`);
        }
      } else {
        outputChannel.appendLine(`Specific file does not exist: ${specificFile}`);
      }
      
      // Then try other common locations
      const possibleResultFiles = [
        join(workspaceRoot, "playwright-report", "results.json"),
        join(workspaceRoot, "test-results", "results.json"),
        join(workspaceRoot, "test-results.json")
      ];
      
      // Try each possible location
      for (const resultFile of possibleResultFiles) {
        if (existsSync(resultFile)) {
          try {
            const content = readFileSync(resultFile, 'utf8');
            testResultsJson = JSON.parse(content);
            testResultsPath = resultFile;
            outputChannel.appendLine(`Parsed JSON from file: ${resultFile}`);
            break;
          } catch (error) {
            outputChannel.appendLine(`Error parsing JSON from ${resultFile}: ${error}`);
          }
        }
      }
      
      // If still not found, try a glob pattern
      if (!testResultsJson) {
        const resultFiles = await glob(join(workspaceRoot, "**", "*results*.json"));
        if (resultFiles.length > 0) {
          try {
            const content = readFileSync(resultFiles[0], 'utf8');
            testResultsJson = JSON.parse(content);
            testResultsPath = resultFiles[0];
            outputChannel.appendLine(`Parsed JSON from glob result: ${resultFiles[0]}`);
          } catch (error) {
            outputChannel.appendLine(`Error parsing JSON from glob result: ${error}`);
          }
        }
      }
    }
    
    if (!testResultsJson) {
      panel.webview.html = getNoResultsHtml();
      vscode.window.showErrorMessage("No test results found");
      return;
    }
    
    // Process the test results to extract test information and screenshots
    const testResults = processTestResults(testResultsJson, workspaceRoot);
    
    if (testResults.length === 0) {
      panel.webview.html = getNoResultsHtml();
      vscode.window.showErrorMessage("No test results with screenshots found");
      return;
    }
    
    // Generate HTML for the gallery view
    const htmlContent = generateGalleryHtml(testResults, panel, workspaceRoot);
    panel.webview.html = htmlContent;
    
  } catch (error) {
    outputChannel.appendLine(`Error opening test results gallery: ${error}`);
    vscode.window.showErrorMessage(`Failed to open test results gallery: ${error}`);
  }
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
  const configPaths = await glob(join(workspaceRoot, "**/playwright.config.{ts,js,mjs,cjs}"));
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
    
    // First, try to find any reporter with an outputFile parameter
    // This will match custom reporters too, not just the standard json reporter
    const customReporterRegex = /reporter\s*:.*?\[\s*\[.*?\]\s*,\s*\[\s*['"`](.*?)['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const customMatch = configContent.match(customReporterRegex);
    
    if (customMatch && customMatch[2]) {
      const reporterPath = customMatch[1];
      const outputFile = customMatch[2];
      outputChannel.appendLine(`Found custom reporter: ${reporterPath} with outputFile: ${outputFile}`);
      return join(workspaceRoot, outputFile);
    }
    
    // Try to match the specific pattern in the user's config
    // reporter: [['html'], ['./tests/reporters/custom-json-reporter.ts', { outputFile: 'test-results/test-results.json' }]]
    const specificPatternRegex = /reporter\s*:.*?\[\s*\[['"`].*?['"`]\]\s*,\s*\[\s*['"`](.*?)['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const specificMatch = configContent.match(specificPatternRegex);
    
    if (specificMatch && specificMatch[2]) {
      const reporterPath = specificMatch[1];
      const outputFile = specificMatch[2];
      outputChannel.appendLine(`Found specific pattern with reporter: ${reporterPath} and outputFile: ${outputFile}`);
      return join(workspaceRoot, outputFile);
    }
    
    // Look for JSON reporter configuration (standard format)
    const jsonReporterRegex = /reporter\s*:.*?\[\s*['"`]json['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const match = configContent.match(jsonReporterRegex);
    
    if (match && match[1]) {
      // Get the output file path and resolve it relative to workspace root
      const outputFile = match[1];
      outputChannel.appendLine(`Found standard json reporter with outputFile: ${outputFile}`);
      return join(workspaceRoot, outputFile);
    }
    
    // Try alternative format: reporter: [['json', { outputFile: 'path' }]]
    const altJsonReporterRegex = /reporter\s*:.*?\[\s*\[\s*['"`]json['"`]\s*,\s*{\s*outputFile\s*:\s*['"`](.*?)['"`]/s;
    const altMatch = configContent.match(altJsonReporterRegex);
    
    if (altMatch && altMatch[1]) {
      outputChannel.appendLine(`Found alternative json reporter format with outputFile: ${altMatch[1]}`);
      return join(workspaceRoot, altMatch[1]);
    }
    
    // Generic approach: look for any outputFile in the reporter section
    const genericOutputFileRegex = /reporter\s*:.*?outputFile\s*:\s*['"`](.*?)['"`]/s;
    const genericMatch = configContent.match(genericOutputFileRegex);
    
    if (genericMatch && genericMatch[1]) {
      outputChannel.appendLine(`Found generic outputFile in reporter section: ${genericMatch[1]}`);
      return join(workspaceRoot, genericMatch[1]);
    }
    
    outputChannel.appendLine(`No reporter with outputFile found in config`);
    return undefined;
  } catch (error) {
    outputChannel.appendLine(`Error parsing Playwright config: ${error}`);
    return undefined;
  }
}

/**
 * Process the test results JSON to extract test information and screenshots
 */
function processTestResults(resultsJson: any, workspaceRoot: string): TestResult[] {
  const testResults: TestResult[] = [];
  
  // Log the structure to help with debugging
  outputChannel.appendLine(`Processing test results JSON with keys: ${Object.keys(resultsJson).join(', ')}`);
  
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
              
              const relativePath = attachment.path.replace(workspaceRoot, '');
              
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
      processTestSuite(suite, testResults, workspaceRoot);
    }
  }
  
  // Some JSON formats might have tests at the top level
  if (resultsJson.tests && Array.isArray(resultsJson.tests)) {
    outputChannel.appendLine(`Processing ${resultsJson.tests.length} top-level tests`);
    for (const test of resultsJson.tests) {
      const testFile = test.file || 'Unknown';
      const testResult = processTest(test, testFile, workspaceRoot);
      if (testResult) {
        testResults.push(testResult);
      }
    }
  }
  
  outputChannel.appendLine(`Found ${testResults.length} test results with screenshots`);
  return testResults;
}

// Extract test results from a suite, processing recursively
function processTestSuite(suite: any, results: TestResult[], workspaceRoot: string) {
  outputChannel.appendLine(`Processing suite: ${suite.title || 'Unnamed Suite'}`);
  
  // Process tests in this suite
  if (suite.tests) {
    outputChannel.appendLine(`Suite has ${suite.tests.length} tests`);
    for (const test of suite.tests) {
      const testResult = processTest(test, suite.file, workspaceRoot);
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
      processTestSuite(childSuite, results, workspaceRoot);
    }
  } else {
    outputChannel.appendLine(`Suite has no child suites`);
  }
  
  // Some formats might have specs instead of tests
  if (suite.specs) {
    outputChannel.appendLine(`Suite has ${suite.specs.length} specs`);
    for (const spec of suite.specs) {
      const testResult = processTest(spec, suite.file, workspaceRoot);
      if (testResult) {
        results.push(testResult);
      }
    }
  }
}

// Extract relevant information from a test
function processTest(test: any, testFile: string, workspaceRoot: string): TestResult | null {
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
      if (attachmentPath && !attachmentPath.startsWith('/')) {
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
      
      const relativePath = attachmentPath ? attachmentPath.replace(workspaceRoot, '') : '';
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
          
          let attachmentPath = attachment.path;
          
          // If path is relative, resolve it
          if (attachmentPath && !attachmentPath.startsWith('/')) {
            attachmentPath = join(workspaceRoot, attachmentPath);
          }
          
          outputChannel.appendLine(`Processing attachment: ${attachmentPath}`);
          
          // Check if the file exists
          if (attachmentPath && !existsSync(attachmentPath)) {
            outputChannel.appendLine(`Attachment file does not exist: ${attachmentPath}`);
            
            // Try alternative paths
            const alternativePaths = [
              join(workspaceRoot, 'test-results', basename(attachmentPath)),
              join(workspaceRoot, 'playwright-report', basename(attachmentPath)),
              join(dirname(testFile), basename(attachmentPath))
            ];
            
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
          
          const relativePath = attachmentPath ? attachmentPath.replace(workspaceRoot, '') : '';
          
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
        
        let attachmentPath = attachment.path;
        
        // If path is relative, resolve it
        if (attachmentPath && !attachmentPath.startsWith('/')) {
          attachmentPath = join(workspaceRoot, attachmentPath);
        }
        
        outputChannel.appendLine(`Processing attachment: ${attachmentPath}`);
        
        // Check if the file exists
        if (attachmentPath && !existsSync(attachmentPath)) {
          outputChannel.appendLine(`Attachment file does not exist: ${attachmentPath}`);
          
          // Try alternative paths
          const alternativePaths = [
            join(workspaceRoot, 'test-results', basename(attachmentPath)),
            join(workspaceRoot, 'playwright-report', basename(attachmentPath)),
            join(dirname(testFile), basename(attachmentPath))
          ];
          
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
        
        const relativePath = attachmentPath ? attachmentPath.replace(workspaceRoot, '') : '';
        
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
            let path = test[key];
            if (!path.startsWith('/')) {
              path = join(workspaceRoot, path);
            }
            
            if (existsSync(path)) {
              testResult.attachments.push({
                name: `${key}-${basename(path)}`,
                path,
                relativePath: path.replace(workspaceRoot, ''),
                contentType: 'image/png',
                type: 'screenshot'
              });
            }
          } else if (Array.isArray(test[key])) {
            // Array of paths or objects
            for (const item of test[key]) {
              if (typeof item === 'string') {
                let path = item;
                if (!path.startsWith('/')) {
                  path = join(workspaceRoot, path);
                }
                
                if (existsSync(path)) {
                  testResult.attachments.push({
                    name: `${key}-${basename(path)}`,
                    path,
                    relativePath: path.replace(workspaceRoot, ''),
                    contentType: 'image/png',
                    type: 'screenshot'
                  });
                }
              } else if (typeof item === 'object' && item !== null) {
                // Object with path or other properties
                if (item.path) {
                  let path = item.path;
                  if (!path.startsWith('/')) {
                    path = join(workspaceRoot, path);
                  }
                  
                  if (existsSync(path)) {
                    testResult.attachments.push({
                      name: item.name || `${key}-${basename(path)}`,
                      path,
                      relativePath: path.replace(workspaceRoot, ''),
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
  } else if (attachment.contentType === 'application/zip' || attachment.path?.endsWith('.zip') || attachment.type === 'trace') {
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
    const path = screenshot.path.toLowerCase();
    
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
function getLoadingHtml(): string {
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
        <h2>Loading Test Results...</h2>
        <div class="spinner"></div>
        <p>Searching for test results and screenshots...</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate HTML for when no results are found
 */
function getNoResultsHtml(): string {
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
          max-width: 500px;
          padding: 20px;
        }
        h2 {
          margin: 0 0 20px 0;
          padding: 0;
        }
        code {
          display: block;
          padding: 10px;
          background: var(--vscode-editor-inactiveSelectionBackground);
          border-radius: 4px;
          margin: 10px 0;
        }
      </style>
    </head>
    <body>
      <div class="empty-container">
        <h2>No Test Results Found</h2>
        <p>Couldn't find any test results with screenshots. Make sure you've run your tests with screenshots enabled.</p>
        <p>If you're using Playwright, make sure you have these configurations:</p>
        <code>
          // Add the JSON reporter to your playwright.config.ts<br>
          reporter: [['json', { outputFile: 'test-results/results.json' }]]
        </code>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate the HTML for the gallery view
 */
function generateGalleryHtml(testResults: TestResult[], panel: vscode.WebviewPanel, workspaceRoot: string): string {
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
        
        h1 {
          margin: 0 0 15px 0;
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
          max-height: 95%;
          width: 95%;
          height: 90vh; /* Set a fixed height */
          display: flex;
          flex-direction: column;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 5px 20px rgba(0, 0, 0, 0.3);
          box-sizing: border-box;
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
          overflow: auto; /* Enable scrolling */
          display: flex;
          flex-direction: row;
          gap: 20px;
          background: var(--vscode-editor-inactiveSelectionBackground);
          flex: 1; /* Take up remaining space */
          width: 100%;
          box-sizing: border-box;
          align-items: flex-start; /* Align items at the top */
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
          height: auto; /* Allow height to adjust to content */
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
          width: 100%;
          box-sizing: border-box;
          height: auto; /* Allow height to adjust to content */
        }
        
        .image-container img {
          max-width: 100%;
          object-fit: contain;
          display: block;
          width: auto; /* Allow natural width */
          height: auto; /* Allow natural height */
          cursor: pointer; /* Add pointer cursor to indicate clickable */
        }
        
        /* Single image view styles */
        .modal-body.single-view {
          flex-direction: column;
          align-items: center;
        }
        
        .modal-body.single-view .image-container {
          width: 100%;
          max-width: 90%;
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
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Failed Test Gallery</h1>
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
            <h3 class="modal-title" id="modal-title">Screenshot</h3>
            <div class="modal-header-buttons">
              <button id="modal-diff-button" class="nav-button" onclick="viewDiffFromModal()" style="display: none;">
                View Diff
              </button>
              <button class="close-button" onclick="closeModal()">&times;</button>
            </div>
          </div>
          <div class="modal-body">
            <div class="image-container">
              <div class="image-label">Expected</div>
              <div class="image-content">
                <img id="expected-image" src="" alt="Expected" onclick="console.log('Expected image clicked - switching to single view'); showSingleImage('expected'); console.log('After showSingleImage, singleImageView =', singleImageView);" />
              </div>
            </div>
            <div class="image-container">
              <div class="image-label">Actual</div>
              <div class="image-content">
                <img id="actual-image" src="" alt="Actual" onclick="console.log('Actual image clicked - switching to single view'); showSingleImage('actual'); console.log('After showSingleImage, singleImageView =', singleImageView);" />
              </div>
            </div>
            <div class="image-container">
              <div class="image-label">Diff</div>
              <div class="image-content">
                <img id="diff-image" src="" alt="Diff" onclick="console.log('Diff image clicked - switching to single view'); showSingleImage('diff'); console.log('After showSingleImage, singleImageView =', singleImageView);" />
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
          
          const expectedContainer = document.querySelector('.image-container:nth-child(1)');
          const actualContainer = document.querySelector('.image-container:nth-child(2)');
          const diffContainer = document.querySelector('.image-container:nth-child(3)');
          
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
        function openScreenshotModal(imgElement) {
          console.log("Opening screenshot modal");
          
          const modal = document.getElementById('screenshot-modal');
          const expectedImage = document.getElementById('expected-image');
          const actualImage = document.getElementById('actual-image');
          const diffImage = document.getElementById('diff-image');
          const modalTitle = document.getElementById('modal-title');
          const modalInfo = document.getElementById('modal-info');
          const prevButton = document.getElementById('prev-button');
          const nextButton = document.getElementById('next-button');
          const modalDiffButton = document.getElementById('modal-diff-button');
          
          // Reset view state
          singleImageView = false;
          currentImageType = null;
          console.log("Reset view state: singleImageView=" + singleImageView + ", currentImageType=" + currentImageType);
          
          // Remove single view class if it exists
          document.querySelector('.modal-body').classList.remove('single-view');
          
          // Remove back button if it exists
          const backButton = document.querySelector('.back-to-grid');
          if (backButton) {
            backButton.remove();
            console.log("Removed back button");
          }
          
          // Get test item and set as current
          const testItem = imgElement.closest('.test-item');
          currentTestId = testItem.id;
          console.log("Set currentTestId=" + currentTestId);
          console.log("Test item datasets: " + 
                    "expected=" + (testItem.dataset.expected ? "yes" : "no") + ", " +
                    "actual=" + (testItem.dataset.actual ? "yes" : "no") + ", " +
                    "diff=" + (testItem.dataset.diff ? "yes" : "no"));
          
          // Highlight the current item
          document.querySelectorAll('.test-item').forEach(item => {
            item.classList.remove('active');
          });
          testItem.classList.add('active');
          
          // Get test name and file
          const testName = testItem.querySelector('.test-name').textContent;
          const testFile = testItem.dataset.file || testItem.closest('.test-group').dataset.file;
          
          // Set placeholder or loading state
          expectedImage.src = '';
          actualImage.src = '';
          diffImage.src = '';
          
          // Get all image containers
          const expectedContainer = document.querySelector('.image-container:nth-child(1)');
          const actualContainer = document.querySelector('.image-container:nth-child(2)');
          const diffContainer = document.querySelector('.image-container:nth-child(3)');
          
          // Always show all containers in grid view
          expectedContainer.style.display = 'flex';
          actualContainer.style.display = 'flex';
          diffContainer.style.display = 'flex';
          
          modalTitle.textContent = testName;
          modalInfo.textContent = testFile;
          
          // Show/hide diff button based on availability of diff image
          if (testItem.dataset.diff) {
            modalDiffButton.style.display = 'inline-block';
          } else {
            modalDiffButton.style.display = 'none';
          }
          
          // Update navigation buttons
          updateNavigationButtons();
          
          // Show the modal
          modal.style.display = 'flex';
          
          // Update keyboard hint for grid view
          document.querySelector('.keyboard-hint').textContent = 'Use ← → arrow keys to navigate between test cases';
          
          // Request image URIs from the extension
          if (testItem.dataset.expected || testItem.dataset.actual || testItem.dataset.diff) {
            vscode.postMessage({
              command: 'getImageUris',
              expected: testItem.dataset.expected,
              actual: testItem.dataset.actual,
              diff: testItem.dataset.diff
            });
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
            if (!modalBody) {
              console.error("Modal body element not found");
              return;
            }
            
            // Use more robust selectors that will work even after DOM changes
            const expectedContainer = modalBody.querySelector('.image-container:nth-of-type(1)');
            const actualContainer = modalBody.querySelector('.image-container:nth-of-type(2)');
            const diffContainer = modalBody.querySelector('.image-container:nth-of-type(3)');
            
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
            
            // Create back button if it doesn't exist
            if (!modalBody.querySelector('.back-to-grid')) {
              const backButton = document.createElement('button');
              backButton.className = 'back-to-grid';
              backButton.textContent = '← Back to Grid View';
              backButton.onclick = backToGridView;
              modalBody.insertBefore(backButton, modalBody.firstChild);
            }
            
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
            if (!modalBody) {
              console.error("Modal body element not found");
              return;
            }
            
            const backButton = modalBody.querySelector('.back-to-grid');
            
            // Reset state
            singleImageView = false;
            currentImageType = null;
            console.log("Reset state: singleImageView=false, currentImageType=null");
            
            // Remove single view class
            modalBody.classList.remove('single-view');
            
            // Remove back button
            if (backButton) {
              backButton.remove();
            }
            
            // Get all image containers with more robust selectors
            const expectedContainer = modalBody.querySelector('.image-container:nth-of-type(1)');
            const actualContainer = modalBody.querySelector('.image-container:nth-of-type(2)');
            const diffContainer = modalBody.querySelector('.image-container:nth-of-type(3)');
            
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
          const visibleItems = getVisibleTestItems();
          if (visibleItems.length === 0) return;
          
          // Find the current index
          const currentIndex = visibleItems.findIndex(item => item.id === currentTestId);
          if (currentIndex === -1) return;
          
          // Calculate the new index
          let newIndex = currentIndex;
          if (direction === 'next' && currentIndex < visibleItems.length - 1) {
            newIndex = currentIndex + 1;
          } else if (direction === 'prev' && currentIndex > 0) {
            newIndex = currentIndex - 1;
          }
          
          // If the index changed, navigate to the new item
          if (newIndex !== currentIndex) {
            const nextItem = visibleItems[newIndex];
            const imgElement = nextItem.querySelector('.screenshot-image');
            openScreenshotModal(imgElement);
            
            // Scroll the item into view
            nextItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
              // Update the image sources with the URIs provided by the extension
              const expectedImage = document.getElementById('expected-image');
              const actualImage = document.getElementById('actual-image');
              const diffImage = document.getElementById('diff-image');
              
              if (message.uris.expected) {
                expectedImage.src = message.uris.expected;
              }
              
              if (message.uris.actual) {
                actualImage.src = message.uris.actual;
              }
              
              if (message.uris.diff) {
                diffImage.src = message.uris.diff;
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