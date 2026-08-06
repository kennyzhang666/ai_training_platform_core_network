#!/usr/bin/env python3
"""LDAP3-backed identity adapter for the platform's trusted gateway.

The platform API does not receive LDAP credentials.  This small WSGI service
authenticates a browser session against Active Directory, then exposes a
session verification endpoint for the reverse proxy.  The reverse proxy
copies the signed identity headers returned by that endpoint to the platform
API, which remains in ``TRUSTED_GATEWAY`` mode.

The module intentionally has no framework dependency.  Install ``ldap3`` from
``requirements.txt`` and run it behind the internal HTTPS gateway.  It does
not log passwords, LDAP assertions, cookies or identity headers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import ssl
import time
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from typing import Any, Callable, Mapping, MutableMapping, Sequence
from urllib.parse import parse_qs


class LdapGatewayError(Exception):
    """Base class for errors that should not expose LDAP internals."""


class LdapAuthenticationError(LdapGatewayError):
    """The supplied credentials cannot be authenticated."""


class LdapProfileError(LdapGatewayError):
    """The account authenticated but its platform profile is incomplete."""


class InvalidSessionError(LdapGatewayError):
    """The gateway session cookie is missing, invalid or expired."""


@dataclass(frozen=True)
class LdapConfig:
    server: str = "china.huawei.com"
    port: int = 389
    use_ssl: bool = False
    start_tls: bool = False
    base_dn: str = "dc=china,dc=huawei,dc=com"
    bind_prefix: str = "China\\"
    account_attribute: str = "sAMAccountName"
    title_attribute: str = "title"
    department_attribute: str = "department"
    name_attribute: str = "displayName"
    ca_cert_file: str | None = None
    timeout_seconds: int = 5

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "LdapConfig":
        values = os.environ if env is None else env
        server = values.get("LDAP_SERVER", "china.huawei.com").strip()
        base_dn = values.get("LDAP_BASE_DN", "dc=china,dc=huawei,dc=com").strip()
        if not server:
            raise ValueError("LDAP_SERVER is required")
        if not base_dn:
            raise ValueError("LDAP_BASE_DN is required")
        port = _positive_int(values, "LDAP_PORT", 389, 1, 65535)
        timeout = _positive_int(values, "LDAP_TIMEOUT_SECONDS", 5, 1, 60)
        use_ssl = _boolean(values.get("LDAP_USE_SSL"), False)
        start_tls = _boolean(values.get("LDAP_START_TLS"), False)
        if use_ssl and start_tls:
            raise ValueError("LDAP_USE_SSL and LDAP_START_TLS cannot both be enabled")
        return cls(
            server=server,
            port=port,
            use_ssl=use_ssl,
            start_tls=start_tls,
            base_dn=base_dn,
            bind_prefix=values.get("LDAP_BIND_PREFIX", "China\\"),
            account_attribute=_attribute_name(values.get("LDAP_ACCOUNT_ATTRIBUTE", "sAMAccountName")),
            title_attribute=_attribute_name(values.get("LDAP_TITLE_ATTRIBUTE", "title")),
            department_attribute=_attribute_name(values.get("LDAP_DEPARTMENT_ATTRIBUTE", "department")),
            name_attribute=_attribute_name(values.get("LDAP_NAME_ATTRIBUTE", "displayName")),
            ca_cert_file=values.get("LDAP_CA_CERT_FILE", "").strip() or None,
            timeout_seconds=timeout,
        )


@dataclass(frozen=True)
class GatewayConfig:
    ldap: LdapConfig
    trusted_gateway_secret: str
    session_secret: str
    session_ttl_seconds: int = 8 * 60 * 60
    trusted_gateway_max_age_seconds: int = 90
    cookie_name: str = "platform_ldap_session"
    csrf_cookie_name: str = "platform_ldap_csrf"
    cookie_secure: bool = True

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "GatewayConfig":
        values = os.environ if env is None else env
        trusted_secret = values.get("TRUSTED_GATEWAY_HMAC_SECRET", "").strip()
        session_secret = values.get("LDAP_GATEWAY_SESSION_SECRET", "").strip()
        if len(trusted_secret) < 32:
            raise ValueError("TRUSTED_GATEWAY_HMAC_SECRET must contain at least 32 characters")
        if len(session_secret) < 32:
            raise ValueError("LDAP_GATEWAY_SESSION_SECRET must contain at least 32 characters")
        return cls(
            ldap=LdapConfig.from_env(values),
            trusted_gateway_secret=trusted_secret,
            session_secret=session_secret,
            session_ttl_seconds=_positive_int(values, "LDAP_GATEWAY_SESSION_TTL_SECONDS", 8 * 60 * 60, 300, 7 * 24 * 60 * 60),
            trusted_gateway_max_age_seconds=_positive_int(values, "TRUSTED_GATEWAY_MAX_AGE_SECONDS", 90, 1, 300),
            cookie_name=values.get("LDAP_GATEWAY_COOKIE_NAME", "platform_ldap_session").strip() or "platform_ldap_session",
            csrf_cookie_name=values.get("LDAP_GATEWAY_CSRF_COOKIE_NAME", "platform_ldap_csrf").strip() or "platform_ldap_csrf",
            cookie_secure=_boolean(values.get("LDAP_GATEWAY_COOKIE_SECURE"), True),
        )


@dataclass(frozen=True)
class LdapUser:
    employee_no: str
    name: str
    department: str = ""


def _positive_int(values: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = values.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(raw: str | None, default: bool) -> bool:
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError("boolean environment values must be true or false")


def _attribute_name(value: str) -> str:
    candidate = value.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", candidate):
        raise ValueError("LDAP attribute names must contain only ASCII letters, digits, underscores or hyphens")
    return candidate


def _load_ldap3() -> Any:
    try:
        import ldap3  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - exercised by deployment, not unit tests
        raise LdapGatewayError("ldap3 is not installed in the gateway environment") from exc
    return ldap3


def escape_filter_value(value: str) -> str:
    """Escape an RFC 4515 filter value, including UTF-8 octets."""

    escaped: list[str] = []
    for byte in value.encode("utf-8"):
        if byte in {0x00, 0x28, 0x29, 0x2A, 0x5C} or byte >= 0x80:
            escaped.append(f"\\{byte:02x}")
        else:
            escaped.append(chr(byte))
    return "".join(escaped)


def _safe_user_id(user_id: str) -> str:
    value = user_id.strip()
    # The bind name is a Windows DOMAIN\\user value.  Keep it deliberately
    # narrow and reject separators/control characters before LDAP is called.
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value):
        raise LdapAuthenticationError("工号格式不正确")
    return value


def _entry_value(entry: Any, attribute: str) -> str:
    if isinstance(entry, Mapping):
        value = entry.get(attribute)
    else:
        try:
            value = getattr(entry, attribute)
        except AttributeError:
            return ""
    if hasattr(value, "value"):
        value = value.value
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return str(value).strip() if value is not None else ""


def _safe_identity_value(value: str, label: str, required: bool = False) -> str:
    candidate = value.strip()
    if not candidate and required:
        raise LdapProfileError(f"LDAP 用户资料缺少{label}")
    if len(candidate) > 256 or any(ord(char) < 0x20 or ord(char) == 0x7F for char in candidate):
        raise LdapProfileError(f"LDAP 用户资料中的{label}格式不正确")
    return candidate


def parse_user_entry(user_id: str, entry: Any, config: LdapConfig) -> LdapUser:
    """Map the supplied AD entry to the platform's three identity fields."""

    title = _entry_value(entry, config.title_attribute)
    name = ""
    department = ""
    if title and "," in title:
        parts = title.split(",", 2)
        if len(parts) >= 3:
            name = parts[1].strip()
            department = parts[2].strip()
    if not name:
        name = _entry_value(entry, config.name_attribute)
    if not department:
        department = _entry_value(entry, config.department_attribute)
    name = _safe_identity_value(name, "姓名", required=True)
    department = _safe_identity_value(department, "部门")
    return LdapUser(employee_no=_safe_user_id(user_id), name=name, department=department)


def _is_bind_error(error: BaseException, ldap_module: Any) -> bool:
    exception_root = getattr(getattr(ldap_module, "core", None), "exceptions", None)
    bind_error = getattr(exception_root, "LDAPBindError", None)
    return bool(bind_error and isinstance(error, bind_error)) or error.__class__.__name__ == "LDAPBindError"


def authenticate_ldap_user(config: LdapConfig, user_id: str, password: str, ldap_module: Any | None = None) -> LdapUser:
    """Bind to AD and return only the fields trusted by the platform."""

    safe_user_id = _safe_user_id(user_id)
    if not isinstance(password, str) or not password:
        raise LdapAuthenticationError("工号或密码错误")
    ldap3 = ldap_module or _load_ldap3()
    connection: Any | None = None
    try:
        tls = None
        if config.use_ssl or config.start_tls:
            tls = ldap3.Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=config.ca_cert_file)
        server = ldap3.Server(
            config.server,
            port=config.port,
            use_ssl=config.use_ssl,
            tls=tls,
            get_info=getattr(ldap3, "NONE", None),
            connect_timeout=config.timeout_seconds,
        )
        connection = ldap3.Connection(
            server,
            auto_bind=not config.start_tls,
            user=f"{config.bind_prefix}{safe_user_id}",
            password=password,
            receive_timeout=config.timeout_seconds,
            raise_exceptions=True,
        )
        if config.start_tls:
            if connection.start_tls() is False:
                raise LdapGatewayError("LDAP TLS negotiation failed")
            if connection.bind() is False:
                raise LdapAuthenticationError("工号或密码错误")
        search_filter = f"({config.account_attribute}={escape_filter_value(safe_user_id)})"
        attributes = [config.title_attribute, config.department_attribute, config.name_attribute]
        connection.search(
            search_base=config.base_dn,
            search_filter=search_filter,
            search_scope=getattr(ldap3, "SUBTREE", None),
            attributes=attributes,
        )
        entries = list(getattr(connection, "entries", []) or [])
        if len(entries) != 1:
            raise LdapProfileError("LDAP 用户资料不存在或不唯一")
        return parse_user_entry(safe_user_id, entries[0], config)
    except LdapGatewayError:
        raise
    except Exception as error:
        if _is_bind_error(error, ldap3):
            raise LdapAuthenticationError("工号或密码错误") from error
        raise LdapGatewayError("LDAP 服务暂时不可用") from error
    finally:
        if connection is not None:
            try:
                connection.unbind()
            except Exception:
                pass


def utc_timestamp(now: float | None = None) -> str:
    from datetime import datetime, timezone

    moment = datetime.fromtimestamp(time.time() if now is None else now, tz=timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trusted_gateway_signature(user: LdapUser, issued_at: str, secret: str) -> str:
    employee_no = _safe_user_id(user.employee_no)
    name = _safe_identity_value(user.name, "姓名", required=True)
    department = _safe_identity_value(user.department, "部门")
    if "\r" in issued_at or "\n" in issued_at or len(issued_at) > 64:
        raise ValueError("issued_at is not a safe header value")
    canonical = f"{employee_no}\n{issued_at}\n{name}\n{department}"
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def trusted_gateway_headers(user: LdapUser, secret: str, issued_at: str | None = None) -> dict[str, str]:
    issued = issued_at or utc_timestamp()
    return {
        "X-Trusted-Employee-No": user.employee_no,
        "X-Trusted-Name": user.name,
        "X-Trusted-Department": user.department,
        "X-Trusted-Issued-At": issued,
        "X-Trusted-Identity-Signature": trusted_gateway_signature(user, issued, secret),
    }


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise InvalidSessionError("登录会话无效")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def encode_session(user: LdapUser, expires_at: int, secret: str) -> str:
    payload = json.dumps(
        {"employeeNo": user.employee_no, "name": user.name, "department": user.department, "exp": expires_at},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    body = _b64(payload)
    signature = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def decode_session(token: str, secret: str, now: int | None = None) -> LdapUser:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise InvalidSessionError("登录会话无效")
        payload = json.loads(_unb64(body).decode("utf-8"))
        if not isinstance(payload, dict):
            raise InvalidSessionError("登录会话无效")
        expires_at = payload.get("exp")
        if not isinstance(expires_at, int) or expires_at <= int(time.time() if now is None else now):
            raise InvalidSessionError("登录会话已过期")
        employee_no = payload.get("employeeNo")
        name = payload.get("name")
        department = payload.get("department", "")
        if not all(isinstance(value, str) for value in (employee_no, name, department)):
            raise InvalidSessionError("登录会话无效")
        return LdapUser(employee_no=employee_no, name=name, department=department)
    except InvalidSessionError:
        raise
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise InvalidSessionError("登录会话无效") from error


def _parse_cookies(raw: str) -> dict[str, str]:
    cookie = SimpleCookie()
    try:
        cookie.load(raw or "")
    except CookieError:
        return {}
    return {key: morsel.value for key, morsel in cookie.items()}


def _relative_return_to(value: str | None) -> str:
    candidate = value or "/"
    if not candidate.startswith("/") or candidate.startswith("//") or "\r" in candidate or "\n" in candidate:
        return "/"
    return candidate


def _cookie(name: str, value: str, max_age: int, secure: bool, http_only: bool = True) -> str:
    parts = [f"{name}={value}", "Path=/", "SameSite=Lax", f"Max-Age={max_age}"]
    if secure:
        parts.append("Secure")
    if http_only:
        parts.append("HttpOnly")
    return "; ".join(parts)


def _read_body(environ: Mapping[str, Any], limit: int = 32 * 1024) -> bytes:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError as error:
        raise ValueError("请求体长度无效") from error
    if length < 0 or length > limit:
        raise ValueError("请求体过大")
    stream = environ.get("wsgi.input")
    return stream.read(length) if stream is not None else b""


def _json_response(start_response: Callable[..., Any], status: str, payload: Mapping[str, Any], headers: Sequence[tuple[str, str]] = ()) -> list[bytes]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response_headers = [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), *headers]
    start_response(status, response_headers)
    return [body]


def _html_response(start_response: Callable[..., Any], status: str, body_text: str, headers: Sequence[tuple[str, str]] = ()) -> list[bytes]:
    body = body_text.encode("utf-8")
    response_headers = [("Content-Type", "text/html; charset=utf-8"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), *headers]
    start_response(status, response_headers)
    return [body]


class LdapGatewayApp:
    """A small WSGI app for login and reverse-proxy auth subrequests."""

    def __init__(self, config: GatewayConfig, authenticator: Callable[[LdapConfig, str, str], LdapUser] = authenticate_ldap_user, clock: Callable[[], float] = time.time, template_path: Path | None = None) -> None:
        self.config = config
        self.authenticator = authenticator
        self.clock = clock
        self.template_path = template_path or Path(__file__).with_name("static") / "login.html"
        self.brand_logo_path = Path(__file__).with_name("static") / "brand-logo.png"
        self.login_logo_path = Path(__file__).with_name("static") / "login-logo.png"

    def _verify_cookie(self, environ: Mapping[str, Any]) -> LdapUser:
        cookies = _parse_cookies(str(environ.get("HTTP_COOKIE", "")))
        token = cookies.get(self.config.cookie_name, "")
        if not token:
            raise InvalidSessionError("未登录")
        return decode_session(token, self.config.session_secret, int(self.clock()))

    def _login_page(self, csrf: str, return_to: str, start_response: Callable[..., Any], error: str = "", status: str = "200 OK") -> list[bytes]:
        escaped_return = html.escape(return_to, quote=True)
        escaped_csrf = html.escape(csrf, quote=True)
        escaped_error = html.escape(error, quote=True)
        error_state = "visible" if error else "hidden"
        try:
            template = self.template_path.read_text(encoding="utf-8")
        except OSError:
            # Keep the service diagnosable even when a packaging mistake omits
            # the template; the Docker image and source checkout both include
            # the real static page.
            template = """<!doctype html><meta charset=\"utf-8\"><title>平台登录</title><h1>平台登录</h1><form method=\"post\" action=\"/auth/login\"><input type=\"hidden\" name=\"csrf\" value=\"{{CSRF}}\"><input type=\"hidden\" name=\"returnTo\" value=\"{{RETURN_TO}}\"><div class=\"form-error\" data-state=\"{{ERROR_STATE}}\">{{ERROR_MESSAGE}}</div><label>工号<input name=\"userId\" required></label><label>密码<input name=\"password\" type=\"password\" required></label><button>登录</button></form>"""
        page = (
            template
            .replace("{{CSRF}}", escaped_csrf)
            .replace("{{RETURN_TO}}", escaped_return)
            .replace("{{ERROR_STATE}}", error_state)
            .replace("{{ERROR_MESSAGE}}", escaped_error)
        )
        csrf_cookie = _cookie(self.config.csrf_cookie_name, csrf, 600, self.config.cookie_secure, http_only=False)
        return _html_response(start_response, status, page, [("Set-Cookie", csrf_cookie)])

    def __call__(self, environ: MutableMapping[str, Any], start_response: Callable[..., Any]) -> list[bytes]:
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        path = str(environ.get("PATH_INFO", "/"))
        if method == "GET" and path == "/brand-logo.png":
            return self._logo(start_response, self.brand_logo_path)
        if method == "GET" and path == "/login-logo.png":
            return self._logo(start_response, self.login_logo_path)
        if method == "GET" and path in {"/healthz", "/auth/health"}:
            return _json_response(start_response, "200 OK", {"status": "ok"})
        if method == "GET" and path in {"/auth/login", "/login"}:
            csrf = secrets.token_urlsafe(24)
            query = parse_qs(str(environ.get("QUERY_STRING", "")), keep_blank_values=True)
            return_to = _relative_return_to(query.get("returnTo", ["/"])[-1])
            return self._login_page(csrf, return_to, start_response)
        if method == "POST" and path in {"/auth/login", "/login"}:
            return self._login(environ, start_response)
        if method == "POST" and path == "/auth/logout":
            expired = _cookie(self.config.cookie_name, "", 0, self.config.cookie_secure)
            return _json_response(start_response, "200 OK", {"loggedOut": True}, [("Set-Cookie", expired)])
        if method == "GET" and path in {"/auth/session", "/auth/verify"}:
            return self._verify(environ, start_response, include_body=path == "/auth/session")
        return _json_response(start_response, "404 Not Found", {"message": "not found"})

    def _logo(self, start_response: Callable[..., Any], path: Path) -> list[bytes]:
        try:
            body = path.read_bytes()
        except OSError:
            return _json_response(start_response, "404 Not Found", {"message": "not found"})
        start_response(
            "200 OK",
            [
                ("Content-Type", "image/png"),
                ("Content-Length", str(len(body))),
                ("Cache-Control", "public, max-age=3600"),
            ],
        )
        return [body]

    def _login(self, environ: MutableMapping[str, Any], start_response: Callable[..., Any]) -> list[bytes]:
        cookies = _parse_cookies(str(environ.get("HTTP_COOKIE", "")))
        content_type = str(environ.get("CONTENT_TYPE", ""))
        wants_json = content_type.startswith("application/json") or "application/json" in str(environ.get("HTTP_ACCEPT", ""))
        return_to = "/"

        def failure(status: str, message: str) -> list[bytes]:
            if wants_json:
                return _json_response(start_response, status, {"message": message})
            csrf = secrets.token_urlsafe(24)
            return self._login_page(csrf, return_to, start_response, message, status=status)

        try:
            body = _read_body(environ).decode("utf-8")
            if content_type.startswith("application/json"):
                fields = json.loads(body)
            else:
                parsed = parse_qs(body, keep_blank_values=True)
                fields = {key: values[-1] if values else "" for key, values in parsed.items()}
            if not isinstance(fields, dict):
                raise ValueError("请求体格式无效")
            csrf = str(fields.get("csrf", ""))
            if not csrf or not hmac.compare_digest(csrf, cookies.get(self.config.csrf_cookie_name, "")):
                return failure("403 Forbidden", "登录请求已失效，请刷新后重试")
            user_id = str(fields.get("userId", fields.get("user_id", "")))
            password = fields.get("password", "")
            if not isinstance(password, str):
                password = str(password)
            return_to = _relative_return_to(str(fields.get("returnTo", "/")))
            user = self.authenticator(self.config.ldap, user_id, password)
        except LdapAuthenticationError:
            return failure("401 Unauthorized", "工号或密码错误")
        except LdapProfileError:
            return failure("401 Unauthorized", "统一认证失败，请检查工号和密码或联系管理员")
        except LdapGatewayError:
            return failure("503 Service Unavailable", "统一认证服务暂时不可用")
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return failure("400 Bad Request", "登录请求格式无效")
        expires_at = int(self.clock()) + self.config.session_ttl_seconds
        token = encode_session(user, expires_at, self.config.session_secret)
        session_cookie = _cookie(self.config.cookie_name, token, self.config.session_ttl_seconds, self.config.cookie_secure)
        csrf_expired = _cookie(self.config.csrf_cookie_name, "", 0, self.config.cookie_secure, http_only=False)
        start_response("302 Found", [("Location", return_to), ("Set-Cookie", session_cookie), ("Set-Cookie", csrf_expired), ("Content-Length", "0"), ("Cache-Control", "no-store")])
        return [b""]

    def _verify(self, environ: Mapping[str, Any], start_response: Callable[..., Any], include_body: bool) -> list[bytes]:
        try:
            user = self._verify_cookie(environ)
        except InvalidSessionError:
            return _json_response(start_response, "401 Unauthorized", {"message": "未登录"})
        issued_at = utc_timestamp(self.clock())
        headers = trusted_gateway_headers(user, self.config.trusted_gateway_secret, issued_at)
        if include_body:
            return _json_response(start_response, "200 OK", {"authenticated": True, "employeeNo": user.employee_no, "name": user.name, "department": user.department})
        start_response("200 OK", [("Content-Length", "0"), ("Cache-Control", "no-store"), *headers.items()])
        return [b""]


def main() -> None:
    from wsgiref.simple_server import make_server

    config = GatewayConfig.from_env()
    host = os.environ.get("LDAP_GATEWAY_HOST", "127.0.0.1")
    port = _positive_int(os.environ, "LDAP_GATEWAY_PORT", 8081, 1, 65535)
    application = LdapGatewayApp(config)
    with make_server(host, port, application) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
