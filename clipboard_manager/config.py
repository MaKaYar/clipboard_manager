import json
import os
from pathlib import Path

from dataclasses import dataclass, field

APP_NAME = "Clipboard Image Saver"
WINDOW_GEOMETRY = "720x420"
MIN_WINDOW_SIZE = (640, 360)

POLL_INTERVAL_SEC = 1.0
LOG_POLL_MS = 150
MAX_FOLDER_HISTORY = 10

HISTORY_FILE = Path("folder_history.json")
GOOGLE_SETTINGS_FILE = Path("google_sync.json")


@dataclass
class GoogleSyncSettings:
    enabled: bool = False
    auth_mode: str = "service"  # "service" | "oauth"
    credentials_file: str = ""
    client_secret_file: str = ""
    token_file: str = "google_token.json"
    spreadsheet_id: str = ""
    sheet_name: str = "Sheet1"
    search_term: str = "add"
    drive_folder_id: str | None = None

    @classmethod
    def from_env(cls) -> "GoogleSyncSettings":
        creds = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
        spreadsheet_id = os.getenv("GOOGLE_SPREADSHEET_ID", "")
        sheet_name = os.getenv("GOOGLE_SHEET_NAME", "Sheet1")
        search_term = os.getenv("GOOGLE_SEARCH_TERM", "add")
        drive_folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID") or None
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET_JSON", "")
        token_file = os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")
        auth_mode = os.getenv("GOOGLE_AUTH_MODE", "service")

        enabled = bool(spreadsheet_id and ((auth_mode == "service" and creds) or (auth_mode == "oauth" and client_secret)))
        return cls(
            enabled=enabled,
            auth_mode=auth_mode,
            credentials_file=creds,
            client_secret_file=client_secret,
            token_file=token_file,
            spreadsheet_id=spreadsheet_id,
            sheet_name=sheet_name,
            search_term=search_term,
            drive_folder_id=drive_folder_id,
        )

    @classmethod
    def from_dict(cls, data: dict) -> "GoogleSyncSettings":
        return cls(
            enabled=bool(data.get("enabled", False)),
            auth_mode=str(data.get("auth_mode", "service")),
            credentials_file=str(data.get("credentials_file", "")),
            client_secret_file=str(data.get("client_secret_file", "")),
            token_file=str(data.get("token_file", "google_token.json")),
            spreadsheet_id=str(data.get("spreadsheet_id", "")),
            sheet_name=str(data.get("sheet_name", "Sheet1")),
            search_term=str(data.get("search_term", "add")),
            drive_folder_id=data.get("drive_folder_id") or None,
        )

    @classmethod
    def load(cls, path: Path | None = None) -> "GoogleSyncSettings":
        target = path or GOOGLE_SETTINGS_FILE
        if target.exists():
            try:
                with target.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
                return cls.from_dict(data)
            except Exception:
                # fall back to env if file is malformed
                pass
        return cls.from_env()

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "auth_mode": self.auth_mode,
            "credentials_file": self.credentials_file,
            "client_secret_file": self.client_secret_file,
            "token_file": self.token_file,
            "spreadsheet_id": self.spreadsheet_id,
            "sheet_name": self.sheet_name,
            "search_term": self.search_term,
            "drive_folder_id": self.drive_folder_id,
        }

    def save(self, path: Path | None = None):
        target = path or GOOGLE_SETTINGS_FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, ensure_ascii=False, indent=2)

