# Change Log

All notable changes to the "playwright-helpers" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.15] - 2026-01-14

### Improved
- **Route Display**: Route extraction now reads directly from `urls` field in test-results.json
  - Requires Playwright reporter to output `urls` field on specs (much more accurate than previous method)
  - Removed error-context.md parsing - cleaner and more reliable
  - Routes are displayed in the modal footer and can be clicked to copy

## [0.0.14] - 2026-01-14

### Added
- **Go to Test from Modal**: Added "Go to Test" button in the modal header to open the test file and scroll directly to the test line
  - Click the file path in the modal footer to also navigate to the test
  - Works with the line number extracted from test results for precise navigation

## [0.0.13] - 2026-01-14

### Fixed
- **Modal Navigation Fix**: Fixed issue where arrow key navigation in the test results modal would cycle between only two tests instead of progressing through all tests
  - Tests with the same name (e.g., parameterized tests in different describe blocks) now have unique IDs by including the line number
  - Fixed location extraction from Playwright's JSON reporter format where location is nested inside `errors[0].location`
  - Added debug logging to help diagnose navigation issues

## [0.0.11] - 2024-11-21

### Fixed
- **Windows Compatibility**: Fixed critical issues preventing Windows users from viewing snapshot galleries
  - Replaced hardcoded macOS platform identifier (`-darwin.png`) with cross-platform detection
  - Fixed path parsing that used forward slashes instead of OS-agnostic path operations
  - Normalized all glob patterns to work correctly on Windows
  - Added `nodir: true` to glob operations to exclude directories with `.png` extensions
- Snapshot Gallery now correctly displays snapshots on Windows, macOS, and Linux
- Failed Test Gallery file reading now works on all platforms
- All file path operations now use Node's `path` module for cross-platform compatibility

## [0.0.10] - Previous

- Snapshot Gallery improvements and bug fixes

## [0.0.6]

### Added
- Snapshot Gallery: Browse all snapshots in a convenient grid layout
- Search functionality within the Snapshot Gallery
- Modal view for examining individual snapshots in detail

## [0.0.5]

- Initial release with snapshot update and diff features