# Application icon

`icon.png` is the original image supplied for the AsterJot application icon.

Regenerate desktop icon assets from the repository root:

```powershell
pnpm tauri icon apps/desktop/src-tauri/icons/source/icon.png --output apps/desktop/src-tauri/icons
```

Only desktop assets are tracked; omit the generated `android/` and `ios/` directories.
