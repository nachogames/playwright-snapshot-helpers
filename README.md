<p align="center">
  <img src="https://github.com/user-attachments/assets/ba066441-4def-494c-a675-082753b16b12" alt="Playwright Helpers Logo" width="250"/>
</p>

# Playwright Helpers

VS Code extension that enhances Playwright snapshot testing workflow with advanced management and comparison tools.

## Features

### Snapshot Management
- Update snapshots for specific tests using CodeLens or context menu
- Update snapshots for entire files or directories
- Smart detection of Playwright test files and test blocks
- Context-aware menu items that only appear when relevant
- Quick access to view existing snapshots directly from the test
- Confirmation dialogs to prevent accidental snapshot updates

### Visual Comparison Tools
- Interactive side-by-side diff view for failed snapshots
- Advanced image comparison slider with precise drag controls
- Visual indicators showing differences between expected and actual snapshots
- Quick access to all snapshot variations (expected, actual, and diff)

### Snapshot Gallery
- Browse all visual test snapshots in a convenient grid layout
- Group snapshots by test file for easy navigation
- Search functionality to quickly find specific snapshots
- Click on any snapshot to view it in full size with complete path information
- Access from the command palette with "Playwright Helpers: View Snapshot Gallery"

### Failed Test Gallery
> **Note:** Requires a custom JSON reporter that includes screenshot attachments in the test results to view failed tests with screenshots.


- Comprehensive view of all failed visual tests in a gallery format
- Filter test results by status (passed, failed, skipped)
- Quickly identify and analyze failed visual tests
- View test details including duration and error messages
- Preview and compare actual, expected, and diff images for failed tests
- Access from the command palette with "Playwright Helpers: View Failed Test Gallery"

## Usage

### Managing Snapshots
- Click the CodeLens "Update Snapshot" button above any test
- Click the CodeLens "View Snapshot" button to inspect the current snapshot
- Right-click inside a test block and select "Update Snapshots for Selected Test"
- Right-click anywhere in a test file and select "Update Snapshots for Current File"
- Confirm your intention when updating snapshots to prevent accidental updates

### Comparing Failed Snapshots
When a snapshot test fails:
1. Click the "View Snapshot Diff" CodeLens above the test
2. Choose between side-by-side view or interactive slider comparison
3. Use the slider to precisely compare differences between expected and actual states

### Browsing Snapshot Gallery
1. Open the command palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Type "Playwright Helpers: View Snapshot Gallery"
3. Browse snapshots grouped by test file
4. Use the search box to filter snapshots
5. Click on any snapshot to view it in full size

### Viewing Failed Test Gallery
1. Open the command palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Type "Playwright Helpers: View Failed Test Gallery"
3. Browse test results grouped by test file
4. Use filters to show passed, failed, or skipped tests
5. Click on any test result to view details and compare images for failed tests

### File Explorer Integration
- Right-click on a test file and select "Update Snapshots for Current File"
- Right-click on a directory and select "Update Snapshots in Current Directory"

## Requirements

- VS Code 1.60.0 or higher
- Playwright installed in your project

## Extension Settings

This extension contributes the following commands:

* `playwright-helpers.updateSelectedTest`: Update snapshots for the selected test
* `playwright-helpers.updateFile`: Update snapshots for the current file
* `playwright-helpers.updateDir`: Update snapshots in the current directory
* `playwright-helpers.updateAll`: Update all snapshots in the project
* `playwright-helpers.showSnapshotDiff`: View visual comparison of failed snapshots
* `playwright-helpers.viewSnapshotGallery`: View all snapshots in a gallery
* `playwright-helpers.viewFailedTestGallery`: View failed tests with screenshots in a gallery
