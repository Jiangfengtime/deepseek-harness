"""Small typed values shared by the high- and low-level Python SDK APIs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from pydantic import BaseModel

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    """JSON-RPC notification after the transport removes its wire envelope."""

    method: str
    """Notification method used for routing."""
    payload: JsonObject
    """Method params retained as JSON-compatible data."""


@dataclass(slots=True)
class IncomingRequest:
    """Server-to-client JSON-RPC request awaiting an explicit SDK response."""

    id: str | int
    """Correlation id that :meth:`HarnessClient.respond` must echo."""
    method: str
    """Requested client-side operation."""
    payload: JsonObject
    """Request params retained as JSON-compatible data."""


class ServerInfo(BaseModel):
    """Optional runtime identity returned by the initialize handshake."""

    name: str | None = None
    version: str | None = None


class InitializeResponse(BaseModel):
    """Validated result of the SDK profile's initialize request."""

    serverInfo: ServerInfo | None = None
