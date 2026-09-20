"""Public import surface for the DeepSeek Harness Python SDK.

Most applications need :class:`DeepSeekHarness` and its high-level
:class:`Session`. :class:`HarnessClient` exposes the lower-level JSON-RPC
transport for integrations that must answer runtime requests or manage
notifications themselves. Protocol models are re-exported here so callers do
not need to depend on the package's internal module layout.
"""

from .api import DeepSeekHarness, DeepSeekHarnessConfig, RunResult, Session
from .client import HarnessClient, HarnessConfig
from .errors import SdkProtocolError
from .models import IncomingRequest, InitializeResponse, JsonObject, Notification, ServerInfo

# Keep the intended stable import surface explicit. Internal helpers in api.py
# and client.py remain free to evolve without becoming accidental SDK APIs.
__all__ = [
    "DeepSeekHarness",
    "DeepSeekHarnessConfig",
    "Session",
    "RunResult",
    "HarnessClient",
    "HarnessConfig",
    "SdkProtocolError",
    "IncomingRequest",
    "InitializeResponse",
    "JsonObject",
    "Notification",
    "ServerInfo",
]
