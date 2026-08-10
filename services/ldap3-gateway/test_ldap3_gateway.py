import io
import hashlib
import hmac
import unittest
from socketserver import ThreadingMixIn
from types import SimpleNamespace
from urllib.parse import urlencode

from ldap3_gateway import (
    GatewayConfig,
    InvalidSessionError,
    LdapAuthenticationError,
    LdapConfig,
    LdapGatewayApp,
    LdapProfileError,
    LdapUser,
    authenticate_ldap_user,
    decode_session,
    encode_session,
    escape_filter_value,
    trusted_gateway_headers,
    ThreadingWSGIServer,
)


class FakeBindError(Exception):
    pass


class FakeEntry:
    def __init__(self, **attributes):
        for key, value in attributes.items():
            setattr(self, key, SimpleNamespace(value=value))


class FakeConnection:
    last = None

    def __init__(self, server, auto_bind, user, password, receive_timeout, **kwargs):
        FakeConnection.last = self
        self.user = user
        self.password = password
        self.entries = [FakeEntry(title="w00123,张三,云计算", department="备用部门", displayName="张三")]
        if password == "bad":
            raise FakeBindError("bad credentials")

    def search(self, **kwargs):
        self.search_kwargs = kwargs
        return True

    def start_tls(self):
        self.start_tls_called = True
        return True

    def bind(self):
        self.bind_called = True
        return True

    def unbind(self):
        self.unbound = True


class FakeLdap:
    NONE = "NONE"
    SUBTREE = "SUBTREE"
    Tls = staticmethod(lambda **kwargs: kwargs)
    Server = staticmethod(lambda *args, **kwargs: (args, kwargs))
    Connection = FakeConnection
    core = SimpleNamespace(exceptions=SimpleNamespace(LDAPBindError=FakeBindError))


class LdapGatewayTests(unittest.TestCase):
    def setUp(self):
        self.ldap = LdapConfig()
        self.user = LdapUser("w00123", "张三", "云计算")

    def test_gateway_server_handles_multiple_login_and_verify_requests_concurrently(self):
        self.assertTrue(issubclass(ThreadingWSGIServer, ThreadingMixIn))
        self.assertTrue(ThreadingWSGIServer.daemon_threads)

    def test_company_intranet_ldap_profile_is_the_runtime_default(self):
        config = LdapConfig.from_env({})
        self.assertEqual(config.server, "china.huawei.com")
        self.assertEqual(config.port, 389)
        self.assertFalse(config.use_ssl)
        self.assertFalse(config.start_tls)
        self.assertEqual(config.base_dn, "dc=china,dc=huawei,dc=com")
        self.assertEqual(config.bind_prefix, "China\\")
        self.assertEqual(config.account_attribute, "sAMAccountName")
        self.assertEqual(config.title_attribute, "title")
        self.assertEqual(config.department_attribute, "department")

    def test_http_only_switch_disables_secure_cookie_without_changing_default(self):
        base = {
            "TRUSTED_GATEWAY_HMAC_SECRET": "t" * 32,
            "LDAP_GATEWAY_SESSION_SECRET": "s" * 32,
        }
        https_config = GatewayConfig.from_env(base)
        self.assertFalse(https_config.http_only)
        self.assertTrue(https_config.cookie_secure)
        http_config = GatewayConfig.from_env({
            **base,
            "INTRANET_HTTP_ONLY": "true",
            # The deployment switch is authoritative so an old copied
            # COOKIE_SECURE=true value cannot break HTTP-only login.
            "LDAP_GATEWAY_COOKIE_SECURE": "true",
        })
        self.assertTrue(http_config.http_only)
        self.assertFalse(http_config.cookie_secure)

    def test_filter_value_escapes_ldap_metacharacters(self):
        self.assertEqual(escape_filter_value("a*)(b\\"), r"a\2a\29\28b\5c")

    def test_authentication_maps_title_and_uses_narrow_search(self):
        user = authenticate_ldap_user(self.ldap, "w00123", "secret", FakeLdap)
        self.assertEqual(user, self.user)
        self.assertEqual(FakeConnection.last.user, r"China\w00123")
        self.assertEqual(FakeConnection.last.search_kwargs["search_filter"], "(sAMAccountName=w00123)")
        self.assertEqual(FakeConnection.last.search_kwargs["attributes"], ["title", "department", "displayName"])
        self.assertTrue(FakeConnection.last.unbound)

    def test_bad_credentials_are_generic(self):
        with self.assertRaises(LdapAuthenticationError):
            authenticate_ldap_user(self.ldap, "w00123", "bad", FakeLdap)

    def test_mock_mode_accepts_any_non_empty_password_without_ldap(self):
        user = authenticate_ldap_user(LdapConfig(mock=True), "w09999", "anything", None)
        self.assertEqual(user.employee_no, "w09999")
        self.assertEqual(user.name, "测试用户 w09999")
        self.assertEqual(user.department, "AI 工程团队")

    def test_mock_environment_repairs_windows_codepage_mojibake(self):
        # "测试用户" decoded as GBK after a UTF-8 PowerShell script is read
        # with the system code page becomes "娴嬭瘯鐢ㄦ埛".
        mojibake = "\u5a34\u5b2d\u762f\u9422\u3126\u57db "
        config = LdapConfig.from_env({"LDAP_MOCK": "true", "LDAP_MOCK_NAME_PREFIX": mojibake})
        self.assertEqual(config.mock_name_prefix, "测试用户")
        user = authenticate_ldap_user(config, "z00123", "anything", None)
        self.assertEqual(user.name, "测试用户z00123")

    def test_mock_mode_still_rejects_empty_password(self):
        with self.assertRaises(LdapAuthenticationError):
            authenticate_ldap_user(LdapConfig(mock=True), "w09999", "", None)

    def test_start_tls_is_negotiated_before_bind(self):
        user = authenticate_ldap_user(LdapConfig(start_tls=True), "w00123", "secret", FakeLdap)
        self.assertEqual(user.name, "张三")
        self.assertTrue(FakeConnection.last.start_tls_called)
        self.assertTrue(FakeConnection.last.bind_called)

    def test_incomplete_profile_is_rejected(self):
        class MissingNameConnection(FakeConnection):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.entries = [FakeEntry(title="w00123,,云计算", department="云计算", displayName="")]

        class MissingNameLdap(FakeLdap):
            Connection = MissingNameConnection

        with self.assertRaises(LdapProfileError):
            authenticate_ldap_user(self.ldap, "w00123", "secret", MissingNameLdap)

    def test_gateway_signature_matches_platform_canonical_text(self):
        headers = trusted_gateway_headers(self.user, "s" * 32, "2026-08-05T03:00:00.000Z")
        self.assertEqual(headers["X-Trusted-Employee-No"], "w00123")
        expected = hmac.new(b"s" * 32, "w00123\n2026-08-05T03:00:00.000Z\n张三\n云计算".encode("utf-8"), hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Trusted-Identity-Signature"], expected)

    def test_identity_header_values_reject_line_breaks(self):
        with self.assertRaises(LdapProfileError):
            trusted_gateway_headers(LdapUser("w00123", "张三\n伪造", "云计算"), "s" * 32)

    def test_session_round_trip_and_tamper_detection(self):
        token = encode_session(self.user, 200, "s" * 32)
        self.assertEqual(decode_session(token, "s" * 32, now=100), self.user)
        with self.assertRaises(InvalidSessionError):
            decode_session(token[:-1] + ("0" if token[-1] != "0" else "1"), "s" * 32, now=100)
        with self.assertRaises(InvalidSessionError):
            decode_session(token, "s" * 32, now=200)

    def test_verify_endpoint_returns_signed_headers(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        token = encode_session(self.user, 200, config.session_secret)
        app = LdapGatewayApp(config, clock=lambda: 100)
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/auth/verify",
            "HTTP_COOKIE": f"{config.cookie_name}={token}",
        }
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app(environ, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(body, b"")
        self.assertEqual(captured["headers"]["X-Trusted-Employee-No"], "w00123")

    @staticmethod
    def _call(app, environ):
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = headers

        body = b"".join(app(environ, start_response)).decode("utf-8")
        return captured, body

    def test_login_page_renders_csrf_and_return_target(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured, body = self._call(app, {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/auth/login",
            "QUERY_STRING": "returnTo=%2Fdrills%2Fparking",
        })
        self.assertEqual(captured["status"], "200 OK")
        self.assertIn("分组核心网", body)
        self.assertIn("AI能力提升平台", body)
        self.assertIn("登录", body)
        self.assertIn("工号", body)
        self.assertIn("密码", body)
        self.assertIn("LDAP3域账号统一认证", body)
        self.assertIn('src="/login-logo.png"', body)
        self.assertIn('name="password"', body)
        self.assertIn('name="csrf" value="', body)
        self.assertIn('name="returnTo" value="/drills/parking"', body)
        self.assertNotIn("{{CSRF}}", body)
        self.assertNotIn("{{ERROR_", body)
        self.assertTrue(any(name == "Set-Cookie" and config.csrf_cookie_name in value for name, value in captured["headers"]))

    def test_brand_logo_route_serves_the_platform_asset(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": "/brand-logo.png"}, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(captured["headers"]["Content-Type"], "image/png")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_login_logo_route_serves_the_login_asset(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": "/login-logo.png"}, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(captured["headers"]["Content-Type"], "image/png")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_form_login_shows_generic_error_without_exposing_password(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)

        def reject(_config, _user_id, _password):
            raise LdapAuthenticationError("internal detail")

        app = LdapGatewayApp(config, authenticator=reject, clock=lambda: 100)
        initial, page = self._call(app, {"REQUEST_METHOD": "GET", "PATH_INFO": "/auth/login", "QUERY_STRING": ""})
        csrf_cookie = next(value for name, value in initial["headers"] if name == "Set-Cookie" and value.startswith(config.csrf_cookie_name))
        csrf = csrf_cookie.split("=", 1)[1].split(";", 1)[0]
        password = "never-render-this-password"
        form = urlencode({"csrf": csrf, "returnTo": "/", "userId": "w00123", "password": password}).encode("utf-8")
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/x-www-form-urlencoded",
            "CONTENT_LENGTH": str(len(form)),
            "HTTP_COOKIE": f"{config.csrf_cookie_name}={csrf}",
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "401 Unauthorized")
        self.assertIn("工号或密码错误", body)
        self.assertNotIn(password, body)
        self.assertNotIn("{{ERROR_", body)
        self.assertNotIn('"message"', body)

    def test_form_login_rejects_expired_csrf_with_login_page(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        form = urlencode({"csrf": "wrong", "returnTo": "/", "userId": "w00123", "password": "secret"}).encode("utf-8")
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/x-www-form-urlencoded",
            "CONTENT_LENGTH": str(len(form)),
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "403 Forbidden")
        self.assertIn("登录请求已失效", body)
        self.assertIn('name="csrf" value="', body)

    def test_json_login_keeps_machine_readable_error_response(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)

        def reject(_config, _user_id, _password):
            raise LdapAuthenticationError("internal detail")

        app = LdapGatewayApp(config, authenticator=reject, clock=lambda: 100)
        form = b'{"csrf":"wrong","userId":"w00123","password":"secret"}'
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/json",
            "HTTP_ACCEPT": "application/json",
            "CONTENT_LENGTH": str(len(form)),
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "403 Forbidden")
        self.assertIn('"message":"登录请求已失效，请刷新后重试"', body)


if __name__ == "__main__":
    unittest.main()
