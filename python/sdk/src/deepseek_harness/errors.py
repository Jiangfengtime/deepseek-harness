"""Exception taxonomy shared by both Python SDK layers."""

from __future__ import annotations


class HarnessError(Exception):
    """Base exception for SDK and runtime failures."""


class TransportClosedError(HarnessError):
    """Raised when the runtime subprocess exits or closes stdout."""


class SdkProtocolError(HarnessError):
    """Raised when the runtime sends data outside the SDK protocol."""


class JsonRpcError(HarnessError):
    """Raised when the runtime returns a JSON-RPC error response.

    ``message`` remains the runtime's human-readable diagnostic, while ``code``
    and ``data`` preserve the protocol fields for callers that need structured
    recovery. Transport failures use :class:`TransportClosedError` instead, so
    a caller can distinguish a valid remote rejection from a broken subprocess.
    """

    def __init__(self, code: int | None, message: str, data: object | None = None) -> None:
        """Store the original JSON-RPC error fields without coercing ``data``."""
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
