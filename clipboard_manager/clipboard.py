from __future__ import annotations

import threading
from typing import Callable, Optional

import win32clipboard
from PIL import Image, ImageGrab

LogFn = Callable[[str], None]


class ClipboardContext:
    def __init__(self, log: LogFn):
        self._log = log

    def __enter__(self):
        try:
            win32clipboard.OpenClipboard()
        except Exception as exc:  # pragma: no cover - UI logging path
            self._log(f"Error opening clipboard: {exc}")

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            # Ignore errors while closing
            pass


def get_clipboard_image(log: LogFn, lock: threading.Lock) -> Optional[Image.Image]:
    """
    Return a PIL.Image if the clipboard currently holds an image, else None.
    Uses CF_DIB to capture screenshots/images from the Windows clipboard.
    """
    try:
        with lock, ClipboardContext(log):
            if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_DIB):
                img = ImageGrab.grabclipboard()
                if hasattr(img, "save"):
                    return img  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover - UI logging path
        log(f"Clipboard access error: {exc}")
        return None

    return None


def get_clipboard_signature(log: LogFn, lock: threading.Lock) -> Optional[bytes]:
    """Return a byte signature of the current clipboard image (or None)."""
    image = get_clipboard_image(log, lock)
    if image is None:
        return None

    try:
        return image.tobytes()
    except Exception:
        return None

