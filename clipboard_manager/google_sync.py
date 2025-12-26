from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials as UserCredentials
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google_auth_oauthlib.flow import InstalledAppFlow

from clipboard_manager.config import GoogleSyncSettings


SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]


@dataclass
class GoogleSyncResult:
    cell: str
    file_id: str
    link: str


class GoogleSheetSync:
    def __init__(self, settings: GoogleSyncSettings):
        if not settings.enabled:
            raise ValueError("Google sync is disabled (missing env vars).")
        self.settings = settings
        self.creds = self._load_credentials()
        self.sheets = build("sheets", "v4", credentials=self.creds, cache_discovery=False).spreadsheets()
        self.drive = build("drive", "v3", credentials=self.creds, cache_discovery=False)

    def _load_credentials(self):
        mode = (self.settings.auth_mode or "service").lower()
        if mode == "service":
            return self._load_service_credentials(Path(self.settings.credentials_file))
        if mode == "oauth":
            return self._load_user_credentials()
        raise ValueError(f"Unknown auth_mode: {mode}")

    def _load_service_credentials(self, path: Path) -> Credentials:
        if not path.exists():
            raise FileNotFoundError(f"Google credentials file not found: {path}")
        return Credentials.from_service_account_file(str(path), scopes=SCOPES)

    def _load_user_credentials(self) -> UserCredentials:
        secret_path = Path(self.settings.client_secret_file)
        token_path = Path(self.settings.token_file or "google_token.json")
        if not secret_path.exists():
            raise FileNotFoundError(f"OAuth client secret file not found: {secret_path}")

        creds: UserCredentials | None = None
        if token_path.exists():
            creds = UserCredentials.from_authorized_user_file(str(token_path), SCOPES)

        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        if not creds or not creds.valid:
            flow = InstalledAppFlow.from_client_secrets_file(str(secret_path), SCOPES)
            creds = flow.run_local_server(port=0)
            token_path.parent.mkdir(parents=True, exist_ok=True)
            token_path.write_text(creds.to_json(), encoding="utf-8")

        return creds

    def upload_and_update(self, image_path: Path) -> GoogleSyncResult:
        file_id = self._upload_to_drive(image_path)
        link = f"https://drive.google.com/uc?export=view&id={file_id}"
        cell = self._find_target_cell()
        if cell is None:
            raise RuntimeError(f"No cell containing '{self.settings.search_term}' found in sheet {self.settings.sheet_name}")
        self._update_cell_with_image(cell, link)
        return GoogleSyncResult(cell=cell, file_id=file_id, link=link)

    def _upload_to_drive(self, image_path: Path) -> str:
        file_metadata = {
            "name": image_path.name,
        }
        if self.settings.drive_folder_id:
            file_metadata["parents"] = [self.settings.drive_folder_id]

        with image_path.open("rb") as fh:
            media = MediaIoBaseUpload(io.BytesIO(fh.read()), mimetype="image/png")
        created = (
            self.drive.files()
            .create(
                body=file_metadata,
                media_body=media,
                fields="id",
                supportsAllDrives=True,
            )
            .execute()
        )
        file_id = created["id"]

        # Make it readable if it's not under a shared folder
        try:
            self.drive.permissions().create(
                fileId=file_id,
                body={"role": "reader", "type": "anyone"},
                fields="id",
                supportsAllDrives=True,
            ).execute()
        except Exception:
            # If permission fails (e.g., folder already shares), continue
            pass
        return file_id

    def _find_target_cell(self) -> Optional[str]:
        # Fetch a reasonable range; adjust if larger sheets are expected
        range_ref = f"{self.settings.sheet_name}!A1:Z200"
        resp = (
            self.sheets.values()
            .get(spreadsheetId=self.settings.spreadsheet_id, range=range_ref)
            .execute()
        )
        values = resp.get("values", [])
        search = self.settings.search_term.lower()

        for r_idx, row in enumerate(values, start=1):
            for c_idx, value in enumerate(row, start=1):
                if isinstance(value, str) and search in value.lower():
                    return f"{self.settings.sheet_name}!{self._a1(c_idx, r_idx)}"
        return None

    def _update_cell_with_image(self, cell_ref: str, link: str):
        body = {"values": [[f'=IMAGE("{link}")']]}
        self.sheets.values().update(
            spreadsheetId=self.settings.spreadsheet_id,
            range=cell_ref,
            valueInputOption="USER_ENTERED",
            body=body,
        ).execute()

    @staticmethod
    def _a1(col: int, row: int) -> str:
        """Convert 1-based column/row to A1 notation."""
        letters = ""
        x = col
        while x:
            x, rem = divmod(x - 1, 26)
            letters = chr(65 + rem) + letters
        return f"{letters}{row}"


