# Playwright Helpers

VS Code extension that helps manage Playwright snapshots directly from your editor.

## Features

- Update snapshots for specific tests using CodeLens or context menu
- Update snapshots for entire files
- Update snapshots for directories
- Smart detection of Playwright test files and test blocks
- Context-aware menu items that only appear when relevant

## Usage

### In Test Files
- Click the CodeLens "Update Snapshot" button above any test
- Right-click inside a test block and select "Update Snapshots for Selected Test"
- Right-click anywhere in a test file and select "Update Snapshots for Current File"

### In File Explorer
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
