# Clipboard Image Saver

Desktop helper that watches the Windows clipboard for images (screenshots, copied pictures) and saves them automatically to a folder you choose. Built with Tkinter, Pillow, and PyInstaller; packaged via Poetry and shipped through GitHub Actions with an attached Windows build artifact.

## Features
- Watches the clipboard and saves new images as sequential `img_<n>.png` files.
- Remembers up to 10 recently used save folders.
- Start/stop controls, live log, and status updates.
- Windows-friendly: uses `pywin32` and produces a GUI-only executable (no console).

## Screenshots (placeholders)
Replace these inline placeholders with real screenshots when you have them. You can also drop images under `docs/images/` and link to them instead.

- UI preview  
  ![Clipboard Image Saver UI](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y8Y3W4AAAAASUVORK5CYII=)
- History dialog  
  ![Folder history dialog](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAZ8dR64AAAAASUVORK5CYII=)

## Requirements
- Windows (clipboard access uses `pywin32`).
- Python `>=3.11,<3.14`.
- Poetry 1.8.x (for dependency management and scripting).

## Quick start
```powershell
poetry install --no-interaction --with dev
poetry run clipboard-manager
```
Or run via the thin entrypoint:
```powershell
poetry run python main.py
```

## Build a Windows executable locally
```powershell
pwsh ./scripts/build_exe.ps1
```
The packaged app will be under `dist/ClipboardImageSaver/`; the workflow also zips this to `ClipboardImageSaver.zip`.

## CI/CD
- `.github/workflows/build.yml` builds on Windows, zips the PyInstaller output, and on pushes to `main`/`master` creates a GitHub release (tag `v${{ github.run_number }}`) with the zip attached. Requires `contents: write` permissions on `GITHUB_TOKEN`.

## Project layout
- `clipboard_manager/` — application package (`app.py`, `clipboard.py`, configs, entrypoint).
- `scripts/build_exe.ps1` — local helper to build with PyInstaller via Poetry.
- `pyproject.toml` — Poetry config with runtime and dev dependencies.
- `main.py` — legacy entrypoint that delegates to the package.

## Customizing screenshots
- Capture real UI images, place them in `docs/images/`, and update the links in the Screenshots section, e.g. `![UI](docs/images/ui.png)`.
- For richer docs, consider adding a short GIF showing start/stop and auto-save behavior.

## Troubleshooting
- If CI release fails with 403, verify the workflow has `contents: write` and runs in a repository (not a fork) where the token can publish releases.
- Ensure Python is in the supported range (`>=3.11,<3.14`); PyInstaller currently requires `<3.14`.

