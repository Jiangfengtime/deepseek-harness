"""Threaded newline-delimited JSON-RPC transport for the Python SDK.

The caller thread writes requests and blocks on a per-request queue. One daemon
thread is the sole stdout reader and dispatches decoded envelopes; another
drains stderr into a bounded diagnostic tail. Locks protect only shared maps
and writes, so user callbacks never execute while the transport lock is held.

Debug logs deliberately contain routing metadata only. Protocol params,
results, error messages, stderr text, prompts, and tool content remain outside
the logging path.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeAlias, TypeVar

from pydantic import BaseModel

from .errors import JsonRpcError, TransportClosedError
from .models import IncomingRequest, InitializeResponse, JsonObject, JsonValue, Notification

ModelT = TypeVar("ModelT", bound=BaseModel)
NotificationFilter: TypeAlias = Callable[[Notification], bool]

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class HarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime."""

    dsh_bin: str | None = None  # Alternate executable; None resolves the bundled carrier.
    profile: str = "sdk"  # dsh profile containing the JSON-RPC server composition.
    patches: tuple[str, ...] = ()  # Ordered absolute-or-resolvable profile overlays.
    dsh_home: str | None = None  # Required explicit runtime state root.
    cwd: str | None = None  # Child process working directory.
    env: dict[str, str] | None = None  # Values merged over the inherited environment.
    initialize_timeout_seconds: float = 30.0  # Startup handshake bound.
    request_timeout_seconds: float | None = None  # Default ordinary-call bound.
    shutdown_timeout_seconds: float | None = 1.0  # Graceful shutdown and wait bound.


class HarnessClient:
    """Synchronous JSON-RPC client for the Harness runtime over stdio.

    One reader thread owns stdout and routes each JSON-RPC envelope to its
    request waiter, notification subscribers, or incoming-request queue. A
    separate stderr thread retains diagnostics without mixing them into the
    protocol stream.
    """

    def __init__(
        self,
        config: HarnessConfig | None = None,
        *,
        _launch_args: tuple[str, ...] | None = None,
    ) -> None:
        """Create transport state; :meth:`start` performs process creation.

        ``_launch_args`` is a test-only seam for fake JSON-RPC peers. Public
        callers select a bundled or explicit ``dsh`` executable through the
        configuration so production launches keep the supported profile path.
        """
        self.config = config or HarnessConfig()
        self._launch_args = _launch_args
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        # Each outbound request owns a size-one response queue. The reader
        # removes the map entry exactly once before delivering its outcome.
        self._responses: dict[str, queue.Queue[JsonValue | BaseException]] = {}
        # Unclaimed notifications preserve the low-level polling API, while
        # subscriptions provide isolated queues for high-level Session runs.
        self._notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        self._notification_subscribers: dict[
            str, tuple[queue.Queue[Notification | BaseException], NotificationFilter | None]
        ] = {}
        # Parent edges discovered from subagent notifications let a root
        # subscription follow descendants without inspecting message content.
        self._session_parents: dict[str, str] = {}
        self._requests: queue.Queue[IncomingRequest | BaseException] = queue.Queue()
        # Bounded retention prevents an unhealthy child from growing SDK memory
        # without limit while still preserving useful failure context.
        self._stderr_lines: deque[str] = deque(maxlen=400)
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None

    def __enter__(self) -> "HarnessClient":
        """Start the transport process and return this client."""
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        """Close the transport even when the caller leaves with an exception."""
        self.close()

    def start(self) -> None:
        """Spawn the configured runtime and start both drain threads."""
        if self._proc is not None:
            logger.debug("runtime start skipped state=running")
            return
        with self._lock:
            self._session_parents.clear()
        env = os.environ.copy()
        if self.config.env:
            env.update(self.config.env)
        args = list(self._launch_args or self._default_launch_args(env))
        logger.debug(
            "runtime starting profile=%s patches=%d",
            self.config.profile,
            len(self.config.patches),
        )
        # Text mode plus line buffering matches the runtime's NDJSON framing:
        # one stdout line is one complete JSON-RPC envelope.
        self._proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=None if self.config.cwd is None else str(Path(self.config.cwd).resolve()),
            env=env,
            bufsize=1,
        )
        self._start_reader_thread()
        self._start_stderr_thread()
        logger.debug("runtime started pid=%d", self._proc.pid)

    def close(self) -> None:
        """Close the runtime after a bounded opportunity to flush durable state."""
        proc = self._proc
        if proc is None:
            logger.debug("runtime close skipped state=closed")
            return
        logger.debug("runtime closing pid=%d", proc.pid)
        shutdown_completed = False
        try:
            self.request("shutdown", None, response_model=_ShutdownResponse, timeout_seconds=self.config.shutdown_timeout_seconds)
            shutdown_completed = True
        except Exception as exc:
            self._stderr_lines.append(f"shutdown request failed: {exc}")
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception as exc:
                self._stderr_lines.append(f"stdin close failed: {exc}")
        if shutdown_completed:
            try:
                proc.wait(timeout=self.config.shutdown_timeout_seconds)
            except subprocess.TimeoutExpired:
                pass
        if proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        if proc.poll() is None:
            try:
                proc.wait(timeout=self.config.shutdown_timeout_seconds)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self._proc = None
        self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime closed"))
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.5)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=0.5)
        logger.debug("runtime closed pid=%d exit_code=%s", proc.pid, proc.returncode)

    def initialize(
        self,
        *,
        cwd: str,
        provider: str,
        model: str,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
    ) -> InitializeResponse:
        """Validate the selected profile and establish the root model route."""
        payload: JsonObject = {
            "cwd": str(Path(cwd).resolve()),
            "provider": provider,
            "model": model,
        }
        if reasoning_effort is not None:
            payload["reasoningEffort"] = reasoning_effort
        if max_tokens is not None:
            payload["maxTokens"] = max_tokens
        try:
            return self.request(
                "initialize",
                payload,
                response_model=InitializeResponse,
                timeout_seconds=self.config.initialize_timeout_seconds,
            )
        except TimeoutError as error:
            self.close()
            raise TimeoutError(f"{error}\nselected dsh profile {self.config.profile!r}") from error
        except BaseException as error:
            self.close()
            diagnostics = self._runtime_diagnostics()
            if isinstance(error, JsonRpcError) and diagnostics:
                raise JsonRpcError(
                    error.code,
                    f"{error.message}\n{diagnostics}",
                    error.data,
                ) from error
            raise

    def session_prompt(
        self,
        session_id: str,
        content_blocks: list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> str:
        """Queue content for a Session and return its assigned inbox message id."""
        payload: JsonObject = {"sessionId": session_id, "contentBlocks": content_blocks}
        response = self.request(
            "session/prompt",
            payload,
            response_model=_SessionPromptResponse,
            on_notification=on_notification,
            notification_filter=self._notification_belongs_to_session_tree(session_id),
            notification_subscription=notification_subscription,
        )
        return response.messageId

    def request(
        self,
        method: str,
        params: JsonObject | None,
        *,
        response_model: type[ModelT],
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> ModelT:
        """Send one request and validate its object result with ``response_model``."""
        result = self._request_raw(
            method,
            params,
            timeout_seconds=timeout_seconds,
            on_notification=on_notification,
            notification_filter=notification_filter,
            notification_subscription=notification_subscription,
        )
        if not isinstance(result, dict):
            raise TypeError(f"{method} response must be a JSON object")
        return response_model.model_validate(result)

    def notify(self, method: str, params: JsonObject | None = None) -> None:
        """Send a JSON-RPC notification that expects no response."""
        message: JsonObject = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        logger.debug("rpc notification sending method=%s", method)
        self._write_message(message)

    def next_notification(self) -> Notification:
        """Block for the next notification not claimed by any subscription."""
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def subscribe_notifications(
        self,
        notification_filter: NotificationFilter | None = None,
    ) -> "NotificationSubscription":
        """Register an independent ordered notification queue."""
        subscription_id = str(uuid.uuid4())
        notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        with self._lock:
            self._notification_subscribers[subscription_id] = (notifications, notification_filter)
        return NotificationSubscription(self, subscription_id, notifications)

    def subscribe_session_notifications(self, session_id: str) -> "NotificationSubscription":
        """Subscribe to a session and descendants discovered from subagent lifecycle edges."""
        return self.subscribe_notifications(self._notification_belongs_to_session_tree(session_id))

    def next_request(self) -> IncomingRequest:
        """Block for the next server-to-client JSON-RPC request."""
        item = self._requests.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def respond(self, request_id: str | int, result: JsonValue) -> None:
        """Return a successful result for a server-to-client request."""
        self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
        data: JsonValue | None = None,
    ) -> None:
        """Return a structured error for a server-to-client request."""
        error: JsonObject = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write_message({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _request_raw(
        self,
        method: str,
        params: JsonObject | None = None,
        *,
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> JsonValue:
        """Correlate one request with its response while draining callbacks.

        When ``on_notification`` is supplied, short queue waits periodically
        drain its subscription on the caller thread. This preserves callback
        ordering and prevents the stdout reader from running user code. Without
        a callback, the caller blocks directly on its response queue.
        """
        request_id = str(uuid.uuid4())
        waiter: queue.Queue[JsonValue | BaseException] = queue.Queue(maxsize=1)
        temp_subscription: NotificationSubscription | None = None
        subscription = notification_subscription
        # Register before writing: the runtime may answer before this thread
        # returns from the flush, and the reader must already find the waiter.
        with self._lock:
            self._responses[request_id] = waiter
        if on_notification is not None and subscription is None:
            temp_subscription = self.subscribe_notifications(notification_filter)
            subscription = temp_subscription
        try:
            message: JsonObject = {"jsonrpc": "2.0", "id": request_id, "method": method}
            if params is not None:
                message["params"] = params
            logger.debug("rpc request sending id=%s method=%s", request_id, method)
            self._write_message(message)
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        # Use an absolute monotonic deadline. Repeated notification wakeups do
        # not extend the caller's configured request budget.
        timeout = self.config.request_timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                if on_notification is not None and subscription is not None:
                    subscription.drain(on_notification)
                wait_timeout = None
                if on_notification is not None:
                    wait_timeout = 0.05
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        with self._lock:
                            self._responses.pop(request_id, None)
                        diagnostics = self._runtime_diagnostics()
                        suffix = f"\n{diagnostics}" if diagnostics else ""
                        raise TimeoutError(
                            f"{method} timed out waiting for DeepSeek Harness runtime{suffix}"
                        )
                    wait_timeout = remaining if wait_timeout is None else min(wait_timeout, remaining)
                try:
                    item = waiter.get(timeout=wait_timeout)
                    if on_notification is not None and subscription is not None:
                        subscription.drain(on_notification)
                    break
                except queue.Empty:
                    continue
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        finally:
            if temp_subscription is not None:
                temp_subscription.close()
        if isinstance(item, BaseException):
            logger.debug(
                "rpc request failed id=%s method=%s error=%s",
                request_id,
                method,
                type(item).__name__,
            )
            raise item
        logger.debug("rpc request completed id=%s method=%s", request_id, method)
        return item

    def _write_message(self, message: JsonObject) -> None:
        """Serialize and flush one complete envelope without interleaved writers."""
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise TransportClosedError("DeepSeek Harness runtime is not running")
        try:
            payload = json.dumps(message, separators=(",", ":")) + "\n"
            # Multiple caller threads may issue requests concurrently. Holding
            # the lock across write and flush keeps each NDJSON frame atomic.
            with self._write_lock:
                proc.stdin.write(payload)
                proc.stdin.flush()
        except Exception as exc:
            raise self._runtime_closed_error("Failed to write to DeepSeek Harness runtime") from exc

    def _start_reader_thread(self) -> None:
        """Start the sole stdout reader that owns JSON-RPC frame decoding."""
        self._reader_thread = threading.Thread(target=self._reader_loop, name="dsh-runtime-reader", daemon=True)
        self._reader_thread.start()

    def _start_stderr_thread(self) -> None:
        """Drain stderr so the child cannot block and retain a diagnostic tail."""
        self._stderr_thread = threading.Thread(target=self._stderr_loop, name="dsh-runtime-stderr", daemon=True)
        self._stderr_thread.start()

    def _reader_loop(self) -> None:
        """Own stdout reads and hand complete JSON-RPC envelopes to the router."""
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("rpc input ignored reason=invalid-json")
                    continue
                self._handle_message(message)
        except BaseException as exc:
            logger.debug("rpc reader failed error=%s", type(exc).__name__)
            self._fail_waiters(exc)
        finally:
            logger.debug("rpc reader stopped")
            self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime stdout closed"))

    def _stderr_loop(self) -> None:
        """Continuously drain stderr so a verbose child cannot block on its pipe."""
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            self._stderr_lines.append(line.rstrip())

    def _handle_message(self, message: object) -> None:
        """Route one decoded envelope without logging its payload or content."""
        if not isinstance(message, dict):
            logger.debug("rpc input ignored reason=non-object")
            return
        msg_id = message.get("id")
        method = message.get("method")
        if isinstance(msg_id, (str, int)) and isinstance(method, str):
            # An envelope with both id and method is a request initiated by the
            # runtime. The embedding application owns its eventual response.
            params = message.get("params")
            logger.debug("rpc incoming request id=%s method=%s", msg_id, method)
            self._requests.put(IncomingRequest(id=msg_id, method=method, payload=params if isinstance(params, dict) else {}))
            return
        if isinstance(msg_id, (str, int)):
            # Responses have an id but no method. Pop-before-delivery guarantees
            # duplicate responses cannot complete the same waiter twice.
            with self._lock:
                waiter = self._responses.pop(str(msg_id), None)
            if waiter is None:
                logger.debug("rpc response ignored id=%s reason=no-waiter", msg_id)
                return
            if isinstance(message.get("error"), dict):
                err = message["error"]
                logger.debug("rpc response received id=%s outcome=error code=%s", msg_id, _int_or_none(err.get("code")))
                waiter.put(JsonRpcError(_int_or_none(err.get("code")), str(err.get("message", "JSON-RPC error")), err.get("data")))
            else:
                logger.debug("rpc response received id=%s outcome=success", msg_id)
                waiter.put(message.get("result"))
            return
        if isinstance(method, str):
            # Notifications have a method but no id. Relationship discovery
            # happens under the same lock as the subscriber snapshot, so a
            # child-start edge is visible to immediately following events.
            params = message.get("params")
            notification = Notification(method=method, payload=params if isinstance(params, dict) else {})
            logger.debug(
                "rpc notification received method=%s session=%s event=%s",
                method,
                _string_field(notification.payload, "sessionId"),
                _notification_event_type(notification),
            )
            with self._lock:
                self._record_session_relationship_locked(notification)
                subscribers = list(self._notification_subscribers.items())
            delivered = False
            for subscription_id, (subscriber, predicate) in subscribers:
                try:
                    matches = predicate is None or predicate(notification)
                except BaseException as exc:
                    with self._lock:
                        current = self._notification_subscribers.get(subscription_id)
                        if current is not None and current[0] is subscriber:
                            self._notification_subscribers.pop(subscription_id, None)
                    subscriber.put(exc)
                    continue
                if matches:
                    subscriber.put(notification)
                    delivered = True
            if not delivered:
                self._notifications.put(notification)

    def _fail_waiters(self, exc: BaseException) -> None:
        """Wake every blocking API when the shared transport can no longer progress."""
        logger.debug("rpc waiters failing error=%s", type(exc).__name__)
        with self._lock:
            waiters = list(self._responses.values())
            self._responses.clear()
            subscribers = list(self._notification_subscribers.values())
            self._notification_subscribers.clear()
        for waiter in waiters:
            waiter.put(exc)
        for subscriber, _predicate in subscribers:
            subscriber.put(exc)
        self._notifications.put(exc)
        self._requests.put(exc)

    def _runtime_closed_error(self, reason: str) -> TransportClosedError:
        """Attach available child exit and stderr facts to a transport failure."""
        diagnostics = self._runtime_diagnostics()
        return TransportClosedError(f"{reason}\n{diagnostics}" if diagnostics else reason)

    def _runtime_diagnostics(self) -> str:
        """Return available subprocess state for transport failures and timeouts."""
        proc = self._proc
        if (
            proc is not None
            and proc.poll() is not None
            and self._stderr_thread is not None
            and self._stderr_thread.is_alive()
            and threading.current_thread() is not self._stderr_thread
        ):
            self._stderr_thread.join(timeout=0.1)

        parts: list[str] = []
        if proc is not None:
            exit_code = proc.poll()
            if exit_code is not None:
                parts.append(f"exit code: {exit_code}")
        if self._stderr_lines:
            parts.append("stderr tail:\n" + "\n".join(self._stderr_lines))
        return "\n".join(parts)

    def _default_launch_args(self, env: dict[str, str]) -> tuple[str, ...]:
        """Resolve the supported dsh launch command and explicit Harness home."""
        if self.config.dsh_bin is None:
            try:
                from deepseek_harness_runtime import resolve_bundled_launch_args
            except ImportError as exc:
                raise FileNotFoundError(
                    "Unable to locate the bundled DeepSeek Harness dsh runtime. "
                    "Install deepseek-harness-runtime-bin."
                ) from exc
            base = resolve_bundled_launch_args()
        else:
            base = (str(Path(self.config.dsh_bin).expanduser().resolve()),)

        if self.config.dsh_home is not None:
            if not self.config.dsh_home.strip():
                raise ValueError("HarnessConfig requires a non-empty dsh_home")
            env["DSH_HOME"] = str(Path(self.config.dsh_home).expanduser().resolve())
        elif not env.get("DSH_HOME", "").strip():
            raise ValueError(
                "HarnessConfig requires an explicit dsh_home or non-empty DSH_HOME; "
                "the Python SDK never uses ~/.dsh implicitly"
            )

        patches = tuple(
            argument
            for patch in self.config.patches
            for argument in ("--patch", str(Path(patch).expanduser().resolve()))
        )
        return (*base, "--profile", self.config.profile, *patches)

    def _unsubscribe_notifications(self, subscription_id: str) -> None:
        """Remove one owned subscriber without affecting the global queue."""
        with self._lock:
            self._notification_subscribers.pop(subscription_id, None)

    def _record_session_relationship_locked(self, notification: Notification) -> None:
        """Retain discovered child ancestry for later descendant filtering."""
        if notification.method != "subagent.started":
            return
        parent_id = notification.payload.get("parentSessionId")
        child_id = notification.payload.get("childSessionId")
        if (
            isinstance(parent_id, str)
            and parent_id
            and isinstance(child_id, str)
            and child_id
            and parent_id != child_id
        ):
            self._session_parents[child_id] = parent_id

    def _notification_belongs_to_session_tree(self, session_id: str) -> NotificationFilter:
        """Build a predicate that follows the selected Session and known descendants."""
        def belongs(notification: Notification) -> bool:
            payload = notification.payload
            if notification.method in {"subagent.started", "subagent.finished"}:
                parent_id = payload.get("parentSessionId")
                if (
                    isinstance(parent_id, str)
                    and self._session_is_descendant_of(parent_id, session_id)
                ):
                    return True
                return payload.get("childSessionId") == session_id
            related_id = payload.get("sessionId")
            return (
                isinstance(related_id, str)
                and self._session_is_descendant_of(related_id, session_id)
            )

        return belongs

    def _session_is_descendant_of(self, session_id: str, root_session_id: str) -> bool:
        """Walk recorded parent links without looping on malformed ancestry."""
        current = session_id
        visited: set[str] = set()
        while current not in visited:
            if current == root_session_id:
                return True
            visited.add(current)
            parent = self._session_parents.get(current)
            if parent is None:
                return False
            current = parent
        return False


class NotificationSubscription:
    """Owned queue registration removed deterministically on close."""
    def __init__(
        self,
        client: HarnessClient,
        subscription_id: str,
        notifications: queue.Queue[Notification | BaseException],
    ) -> None:
        self._client = client
        self._subscription_id = subscription_id
        self._notifications = notifications
        self._closed = False

    def __enter__(self) -> "NotificationSubscription":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def close(self) -> None:
        """Stop future delivery; already queued notifications remain readable."""
        if self._closed:
            return
        self._closed = True
        self._client._unsubscribe_notifications(self._subscription_id)

    def next(self) -> Notification:
        """Block for the next matching notification or transport failure."""
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def drain(self, on_notification: Callable[[Notification], None]) -> None:
        """Deliver every currently queued notification on the caller thread."""
        while True:
            try:
                item = self._notifications.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, BaseException):
                raise item
            on_notification(item)


class _SessionPromptResponse(BaseModel):
    """Validated result fields returned after a prompt enters the runtime inbox."""

    messageId: str


class _ShutdownResponse(BaseModel):
    """Validated empty result returned by a graceful runtime shutdown."""

    pass


def _int_or_none(value: object) -> int | None:
    """Read an optional JSON-RPC integer without coercing booleans or strings."""
    return value if isinstance(value, int) else None


def _string_field(value: JsonObject, key: str) -> str:
    """Read a string metadata field for logging without coercing payload data."""
    candidate = value.get(key)
    return candidate if isinstance(candidate, str) else "-"


def _notification_event_type(notification: Notification) -> str:
    """Extract only the Session event type used by privacy-safe diagnostics."""
    event = notification.payload.get("event")
    if not isinstance(event, dict):
        return "-"
    event_type = event.get("type")
    return event_type if isinstance(event_type, str) else "-"
