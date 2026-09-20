"""High-level synchronous API for running complete Harness activity intervals.

This module turns the lower-level JSON-RPC transport into three user-facing
concepts:

* :class:`DeepSeekHarness` owns one reusable runtime subprocess.
* :class:`Session` identifies one durable conversation in that runtime.
* :class:`RunResult` projects the root Session events collected for one prompt.

The important activity boundary is not the ``session/prompt`` response. That
response only confirms that the message was queued. A run begins when the
matching message appears in the durable inbox event and ends when the root
agent next reports ``idle``. This distinction prevents notifications from an
earlier activity on a reused Session from entering the new result.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .client import HarnessClient, HarnessConfig
from .errors import SdkProtocolError
from .models import JsonObject, Notification

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class DeepSeekHarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    """

    provider: str = "deepseek-official"  # Provider route registered by the selected profile.
    model: str = "deepseek-v4-flash"  # Provider-owned model identifier.
    reasoning_effort: str | None = None  # Optional effort understood by that provider/model pair.
    max_tokens: int | None = None  # Per-request output ceiling; None keeps the provider default.
    cwd: str | None = None  # Workspace exposed to the root agent.
    runtime_cwd: str | None = None  # Process cwd; defaults to the agent workspace.
    dsh_bin: str | None = None  # Alternate dsh executable; None selects the bundled runtime.
    profile: str = "sdk"  # Cordis composition loaded by dsh.
    patches: tuple[str, ...] = ()  # Ordered invocation-specific Cordis patches.
    dsh_home: str | None = None  # Isolated profile, credential, and Session storage root.
    env: dict[str, str] = field(default_factory=dict)  # Explicit child-environment overrides.
    initialize_timeout_seconds: float = 30.0  # Bound for startup and profile validation.
    request_timeout_seconds: float | None = None  # Default bound for ordinary JSON-RPC calls.
    shutdown_timeout_seconds: float | None = 1.0  # Grace period before process termination.
    base_url: str | None = None  # Explicit DEEPSEEK_BASE_URL override for the child.
    api_key: str | None = None  # Explicit DEEPSEEK_API_KEY override for the child.


@dataclass(slots=True)
class RunResult:
    """Materialized root-Session result for one accepted prompt interval."""

    session_id: str
    """Durable Session identity used for this run."""
    final_response: str
    """Text blocks from the last committed root assistant message."""
    finish_reason: str | None
    """Kind from the last root ``turn/end``, or ``None`` when no turn ended."""
    events: list[JsonObject]
    """Root-Session events committed after the matching inbox receipt."""
    notifications: list[Notification]
    """Root and discovered-descendant notifications in observed wire order."""


class DeepSeekHarness:
    """Reusable synchronous SDK for running DeepSeek Harness agent turns.

    The runtime subprocess starts lazily and remains owned by this instance
    across calls to :meth:`run`. Use the instance as a context manager, or call
    :meth:`close` explicitly when finished, so the subprocess is always reaped.
    """

    def __init__(
        self,
        config: DeepSeekHarnessConfig | None = None,
        *,
        _launch_args: tuple[str, ...] | None = None,
        **kwargs: object,
    ) -> None:
        """Create a lazy runtime owner without starting its subprocess."""
        if config is not None and kwargs:
            raise TypeError("pass either DeepSeekHarnessConfig or keyword options, not both")
        self.config = config or DeepSeekHarnessConfig(**kwargs)
        # Resolve both paths before launch so the runtime never depends on a
        # later caller-side chdir. The agent workspace and process cwd are
        # separate because an embedding application may own its launch folder.
        cwd = str(Path(self.config.cwd or Path.cwd()).resolve())
        runtime_cwd = str(Path(self.config.runtime_cwd).resolve()) if self.config.runtime_cwd is not None else cwd
        self._cwd = cwd
        # Copy the caller mapping before injecting convenience overrides; the
        # configuration object remains reusable and never receives secrets as
        # an incidental mutation.
        env = dict(self.config.env)
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client = HarnessClient(
            HarnessConfig(
                dsh_bin=self.config.dsh_bin,
                profile=self.config.profile,
                patches=self.config.patches,
                dsh_home=self.config.dsh_home,
                cwd=runtime_cwd,
                env=env,
                initialize_timeout_seconds=self.config.initialize_timeout_seconds,
                request_timeout_seconds=self.config.request_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
            ),
            _launch_args=_launch_args,
        )
        self._initialized = False

    def __enter__(self) -> "DeepSeekHarness":
        """Initialize the owned runtime and return this reusable SDK handle."""
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        """Reap the runtime on normal and exceptional context-manager exits."""
        self.close()

    @property
    def client(self) -> HarnessClient:
        """Expose the initialized transport owner for lower-level RPC access."""
        return self._client

    def start(self) -> None:
        """Start and initialize the runtime exactly once for this owner."""
        if self._initialized:
            logger.debug("harness start skipped state=initialized")
            return
        logger.debug(
            "harness initializing profile=%s provider=%s model=%s",
            self.config.profile,
            self.config.provider,
            self.config.model,
        )
        # Process creation and protocol initialization are separate so startup
        # failures can include stderr diagnostics from the already-owned child.
        self._client.start()
        self._client.initialize(
            cwd=self._cwd,
            provider=self.config.provider,
            model=self.config.model,
            reasoning_effort=self.config.reasoning_effort,
            max_tokens=self.config.max_tokens,
        )
        self._initialized = True
        logger.debug("harness initialized")

    def close(self) -> None:
        """Flush and reap the owned runtime; repeated calls are safe."""
        logger.debug("harness closing")
        self._client.close()
        self._initialized = False
        logger.debug("harness closed")

    def start_session(self, session_id: str | None = None) -> "Session":
        """Return a handle for one durable conversation, starting lazily."""
        self.start()
        return Session(self, session_id or f"session-{uuid.uuid4().hex}")

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Create or select a Session and run one prompt activity interval."""
        return self.start_session(session_id).run(input, on_notification=on_notification)


class Session:
    """One durable Harness conversation addressed by a stable Session id.

    A Session object is a lightweight handle. The runtime process and transport
    stay owned by its parent :class:`DeepSeekHarness`, so multiple calls reuse
    provider connections, loaded plugins, and persisted conversation state.
    """

    def __init__(self, harness: DeepSeekHarness, session_id: str) -> None:
        """Bind a durable Session id to its parent runtime owner."""
        self.harness = harness
        self.id = session_id

    def run(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Run one activity interval from inbox receipt through agent idle.

        ``session/prompt`` returns after queueing, before model work completes.
        This method therefore subscribes first, submits the prompt second, then
        waits for two ordered facts: the matching durable inbox receipt and the
        next root ``idle`` status. Only notifications inside that interval are
        projected into the returned result.
        """
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []
        logger.debug("session run starting session=%s blocks=%d", self.id, len(content_blocks))

        def collect(notification: Notification) -> None:
            """Retain wire order while projecting only root events into the result."""
            # The callback observes the same ordered objects retained in the
            # result. Root Session events receive a second projection because
            # final_response and finish_reason must exclude descendant events.
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if (
                notification.method == "session.event"
                and notification.payload.get("sessionId") == self.id
            ):
                event = notification.payload.get("event")
                if isinstance(event, dict):
                    events.append(event)
                    logger.debug(
                        "session event accepted session=%s event=%s",
                        self.id,
                        _event_type(event),
                    )

        # Subscribe before sending. Otherwise a fast local runtime could emit
        # the receipt between its response and our subscription registration.
        with self.harness.client.subscribe_session_notifications(self.id) as subscription:
            message_id = self.harness.client.session_prompt(
                self.id,
                content_blocks,
                notification_subscription=subscription,
            )
            logger.debug("session prompt queued session=%s message=%s", self.id, message_id)

            # Notifications that preceded the matching durable inbox receipt
            # belong to earlier activity on a reused session and stay outside
            # this run's result interval.
            received = False
            while True:
                notification = subscription.next()
                if not received:
                    if not _is_inbox_receipt(notification, self.id, message_id):
                        continue
                    received = True
                    logger.debug("session prompt received session=%s message=%s", self.id, message_id)
                collect(notification)
                if (
                    notification.method == "session.status"
                    and notification.payload.get("sessionId") == self.id
                    and notification.payload.get("status") == "idle"
                ):
                    logger.debug("session idle observed session=%s", self.id)
                    break

        result = RunResult(
            session_id=self.id,
            final_response=final_response(events),
            finish_reason=finish_reason(events),
            events=events,
            notifications=notifications,
        )
        logger.debug(
            "session run completed session=%s events=%d notifications=%d reason=%s",
            self.id,
            len(events),
            len(notifications),
            result.finish_reason or "-",
        )
        return result


def _is_inbox_receipt(notification: Notification, session_id: str, message_id: str) -> bool:
    """Return whether an inbox event durably inserted the submitted message."""
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(message, dict) and message.get("id") == message_id for message in inserted
    )


def normalize_input(input: str | list[JsonObject]) -> list[JsonObject]:
    """Promote plain text to one model content block without copying block lists."""
    if isinstance(input, str):
        return [{"type": "text", "text": input}]
    return input


def final_response(events: list[JsonObject]) -> str:
    """Project text from the most recent committed assistant message."""
    # Reverse traversal makes the projection independent of how many tool or
    # lifecycle events followed the final assistant response.
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        content_owner = message if isinstance(message, dict) else data
        content = content_owner.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""


def finish_reason(events: list[JsonObject]) -> str | None:
    """Return the last turn-ending kind.

    The input must contain root-session events from one owned run interval.

    Raises:
        SdkProtocolError: The last ``turn/end`` has no string reason kind.
    """
    for event in reversed(events):
        if event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if not isinstance(kind, str):
            raise SdkProtocolError("turn/end event requires a string data.reason.kind")
        return kind
    return None


def _event_type(event: JsonObject) -> str:
    """Return a privacy-safe event label for diagnostics."""
    event_type = event.get("type")
    return event_type if isinstance(event_type, str) else "-"
