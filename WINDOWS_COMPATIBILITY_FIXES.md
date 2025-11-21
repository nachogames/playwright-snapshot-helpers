# Windows Compatibility Fixes

## Issues Found

### Critical Issue #1: Hardcoded Platform Identifier (`darwin`)
**Impact:** Windows and Linux users couldn't view any snapshots in the gallery or access snapshot comparison features.

**Problem:**
The extension was hardcoded to only look for snapshot files ending with `-chromium-darwin.png`, which is the macOS naming convention. Windows uses `-chromium-win32.png` and Linux uses `-chromium-linux.png`.

**Locations:**
- Line 230-244: Snapshot path finding logic
- Line 260-264: Flexible pattern search
- Line 467: Gallery snapshot pattern

**Example of broken code:**
```typescript
const snapshotPattern = join(workspaceRoot, "**/__snapshots__/visual-tests/**/*-chromium-darwin.png");
```

### Critical Issue #2: Hardcoded Forward Slashes in Path Operations
**Impact:** Path parsing failed on Windows where backslashes (`\`) are used instead of forward slashes (`/`).

**Problem:**
The code used `.split("/")` to parse file paths, which doesn't work on Windows.

**Locations:**
- Line 173: `testFilePath.split("/").pop()`
- Line 240: `testFilePath.split("/").pop()`
- Line 482-485: `file.split("/__snapshots__/visual-tests/")`

**Example of broken code:**
```typescript
const testFileName = testFilePath.split("/").pop() || "";
// On Windows: "C:\Users\test\project\test.spec.ts" won't split correctly
```

## Fixes Applied

### Fix #1: Cross-Platform Snapshot Pattern Detection

**Added helper functions:**

1. **`getPlatformIdentifier()`** - Detects the current OS and returns the correct platform identifier:
   - macOS → `darwin`
   - Windows → `win32`
   - Linux → `linux`

2. **`getSnapshotPatterns(basePath)`** - Generates glob patterns for all platforms and browsers:
   - Supports: `darwin`, `win32`, `linux`
   - Supports: `chromium`, `webkit`, `firefox`
   - Creates comprehensive pattern arrays to find snapshots regardless of platform

**Example:**
```typescript
const patterns = getSnapshotPatterns(basePath);
// Returns: [
//   "path/*-chromium-darwin.png",
//   "path/*-chromium-win32.png",
//   "path/*-chromium-linux.png",
//   "path/*-webkit-darwin.png",
//   // ... etc for all combinations
// ]
```

### Fix #2: Proper Path Parsing

**Replaced all hardcoded path separators with Node.js `path` module functions:**

**Before:**
```typescript
const testFileName = testFilePath.split("/").pop() || "";
```

**After:**
```typescript
const testFileName = basename(testFilePath);
```

**Before:**
```typescript
const pathParts = file.split("/__snapshots__/visual-tests/");
const specFile = pathParts[1].split("/")[0];
```

**After:**
```typescript
const normalizedPath = file.replace(/\\/g, '/');
const pathParts = normalizedPath.split("/__snapshots__/visual-tests/");
const specFile = pathParts[1].split("/")[0];
```

### Fix #3: Cross-Platform Glob Patterns

Updated glob patterns to work on all platforms by:
1. Using `*.png` wildcards instead of platform-specific patterns
2. Normalizing paths for the glob library (which prefers forward slashes)
3. Searching for all snapshot file variations

**Before:**
```typescript
const snapshotPattern = join(workspaceRoot, "**/__snapshots__/visual-tests/**/*-chromium-darwin.png");
```

**After:**
```typescript
const snapshotPattern = join(workspaceRoot, "**/__snapshots__/visual-tests/**/*.png").replace(/\\/g, '/');
```

## Testing Recommendations

To verify these fixes work on Windows:

1. **Test Snapshot Gallery:**
   - Command Palette → "Playwright Helpers: View Snapshot Gallery"
   - Verify snapshots appear correctly
   - Verify clicking snapshots opens them

2. **Test Failed Test Gallery:**
   - Command Palette → "Playwright Helpers: View Failed Test Gallery"
   - Verify failed tests with screenshots appear
   - Verify diff comparison works

3. **Test CodeLens Features:**
   - Open a test file
   - Verify "View Snapshot" CodeLens appears above tests with snapshots
   - Verify clicking it opens the correct snapshot image

4. **Test Path Resolution:**
   - Verify paths display correctly in the gallery
   - Verify clicking "Open File" buttons navigates to correct test files

## Additional Notes

- The glob library used (`glob@11.0.0`) handles path separators correctly when patterns use forward slashes, even on Windows
- Node's `path` module functions (`join`, `basename`, `dirname`) are cross-platform and should always be used instead of manual string manipulation
- When normalizing paths for display or comparison, use `.replace(/\\/g, '/')` to convert backslashes to forward slashes

## Files Modified

- `src/extension.ts` - Main extension file with all snapshot and gallery logic
  - Added OS module import
  - Added `getPlatformIdentifier()` function
  - Added `getSnapshotPatterns()` function
  - Fixed all path parsing operations
  - Updated snapshot finding logic to be cross-platform
  - Updated gallery snapshot loading to be cross-platform


