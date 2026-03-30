"""COROS Training Hub API client using unofficial endpoints."""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx

from .auth import Credentials, hash_password

API_BASES: dict[str, str] = {
    "global": "https://teamapi.coros.com",
    "cn": "https://teamcnapi.coros.com",
    "eu": "https://teameuapi.coros.com",
}

RESULT_SUCCESS = "0000"
RESULT_TOKEN_INVALID = "0101"
RESULT_TOKEN_EXPIRED = "0102"
RESULT_WRONG_REGION = "1019"


class CorosAPIError(Exception):
    pass


class CorosAuthError(CorosAPIError):
    pass


class CorosClient:
    def __init__(self, credentials: Credentials | None = None, request_delay: float = 0.5):
        self._creds = credentials or Credentials.load()
        self._delay = request_delay
        self._client = httpx.Client(timeout=30.0)
        self._relogin_lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> CorosClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    # --- Authentication ---

    def login(self, email: str, password: str) -> Credentials:
        pwd_hash = hash_password(password)
        data = self._post_raw(
            f"{API_BASES['global']}/account/login",
            json={"account": email, "accountType": 2, "pwd": pwd_hash},
        )
        code = data.get("result") or data.get("apiCode")
        if code != RESULT_SUCCESS:
            raise CorosAuthError(f"Login failed: {data.get('message', data)}")

        token = data["data"]["accessToken"]
        user_id = str(data["data"].get("userId", ""))
        region = self._detect_region(token)

        self._creds = Credentials(
            email=email,
            pwd_hash=pwd_hash,
            access_token=token,
            region=region,
            user_id=user_id,
        )
        self._creds.save()
        return self._creds

    def _detect_region(self, token: str) -> str:
        for region, base in API_BASES.items():
            try:
                resp = self._client.get(
                    f"{base}/account/query",
                    headers={"accesstoken": token},
                )
                data = resp.json()
                code = data.get("result") or data.get("apiCode")
                if code != RESULT_WRONG_REGION:
                    return region
            except httpx.HTTPError:
                continue
        return "global"

    def _relogin(self) -> str:
        if not self._creds.email or not self._creds.pwd_hash:
            raise CorosAuthError("No stored credentials. Run: coros-sync login")
        data = self._post_raw(
            f"{API_BASES['global']}/account/login",
            json={"account": self._creds.email, "accountType": 2, "pwd": self._creds.pwd_hash},
        )
        code = data.get("result") or data.get("apiCode")
        if code != RESULT_SUCCESS:
            raise CorosAuthError("Auto re-login failed. Run: coros-sync login")
        token = data["data"]["accessToken"]
        region = self._detect_region(token)
        self._creds.access_token = token
        self._creds.region = region
        self._creds.save()
        return token

    # --- Low-level request helpers ---

    def _post_raw(self, url: str, **kwargs: Any) -> dict:
        resp = self._client.post(url, **kwargs)
        resp.raise_for_status()
        return resp.json()

    @property
    def _base(self) -> str:
        return API_BASES.get(self._creds.region, API_BASES["global"])

    def _request(self, method: str, path: str, params: dict | None = None) -> dict:
        if not self._creds.access_token:
            raise CorosAuthError("Not logged in. Run: coros-sync login")

        url = f"{self._base}{path}"
        old_token = self._creds.access_token

        def do_request(token: str) -> dict:
            h = {"accesstoken": token}
            resp = self._client.request(method, url, params=params, headers=h)
            resp.raise_for_status()
            return resp.json()

        data = do_request(old_token)
        code = data.get("result") or data.get("apiCode")

        if code in (RESULT_TOKEN_EXPIRED, RESULT_TOKEN_INVALID, RESULT_WRONG_REGION):
            with self._relogin_lock:
                # Check if another thread already refreshed the token
                if self._creds.access_token == old_token:
                    self._relogin()
            # Re-build URL in case region changed
            url = f"{self._base}{path}"
            data = do_request(self._creds.access_token)
            code = data.get("result") or data.get("apiCode")

        if code != RESULT_SUCCESS and code is not None:
            raise CorosAPIError(f"[{code}] {data.get('message', data)}")

        time.sleep(self._delay)
        return data

    def _request_json(self, path: str, body: dict) -> dict:
        """POST with JSON body and yfheader (needed for training/workout endpoints)."""
        if not self._creds.access_token:
            raise CorosAuthError("Not logged in. Run: coros-sync login")

        url = f"{self._base}{path}"
        headers = {
            "accesstoken": self._creds.access_token,
            "Content-Type": "application/json",
            "yfheader": f'{{"userId":"{self._creds.user_id}"}}',
        }

        resp = self._client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        code = data.get("result") or data.get("apiCode")

        if code in (RESULT_TOKEN_EXPIRED, RESULT_TOKEN_INVALID, RESULT_WRONG_REGION):
            self._relogin()
            headers["accesstoken"] = self._creds.access_token
            url = f"{self._base}{path}"
            resp = self._client.post(url, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            code = data.get("result") or data.get("apiCode")

        if code != RESULT_SUCCESS and code is not None:
            raise CorosAPIError(f"[{code}] {data.get('message', data)}")

        time.sleep(self._delay)
        return data

    # --- Activity endpoints ---

    def list_activities(self, page: int = 1, size: int = 20) -> dict:
        return self._request("GET", "/activity/query", {"size": size, "pageNumber": page})

    def get_activity_detail(self, label_id: str, sport_type: int) -> dict:
        return self._request("POST", "/activity/detail/query", {"labelId": label_id, "sportType": sport_type})

    # --- Health endpoints ---

    def get_analyse(self) -> dict:
        return self._request("GET", "/analyse/query")

    def get_dashboard(self) -> dict:
        return self._request("GET", "/dashboard/query")

    def get_dashboard_detail(self) -> dict:
        return self._request("GET", "/dashboard/detail/query")

    # --- Workout/Training Schedule endpoints ---

    def calculate_workout(self, program: dict, entity: dict) -> dict:
        return self._request_json("/training/program/calculate", program)

    def estimate_workout(self, program: dict, entity: dict) -> dict:
        return self._request_json("/training/program/estimate", {"program": program, "entity": entity})

    def update_schedule(self, entities: list[dict], programs: list[dict], version_objects: list[dict], pb_version: int = 2) -> dict:
        return self._request_json("/training/schedule/update", {
            "entities": entities,
            "programs": programs,
            "versionObjects": version_objects,
            "pbVersion": pb_version,
        })

    def delete_scheduled_workout(self, entity: dict, plan_id: str) -> dict:
        """Delete a workout from the schedule. Requires entity fields from query_schedule."""
        return self._request_json("/training/schedule/update", {
            "versionObjects": [{
                "id": str(entity.get("idInPlan", entity.get("planProgramId", ""))),
                "labelId": str(entity.get("id", "")),
                "planProgramId": str(entity.get("planProgramId", entity.get("idInPlan", ""))),
                "planId": plan_id,
                "status": 3,
            }],
            "pbVersion": 2,
        })

    def query_schedule(self, start_date: str, end_date: str) -> dict:
        return self._request("GET", "/training/schedule/query", {
            "startDate": start_date,
            "endDate": end_date,
            "supportRestExercise": 1,
        })
