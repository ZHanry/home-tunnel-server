"""RD REST schemas used by the single API generator; wire constants live in contracts."""
import json


def install(context):
    obj, enum, array, ref, define, op = (context[name] for name in ("obj", "enum", "array", "ref", "define", "op"))
    schemas, paths, root = (context[name] for name in ("schemas", "paths", "ROOT"))
    S, B, I, V, ID, DATE = (context[name] for name in ("S", "B", "I", "V", "ID", "DATE"))
    string, nullable = context["string"], context["nullable"]
    registry = json.loads((root / "contracts/remote-desktop.v1.json").read_text(encoding="utf-8"))
    strict = lambda props, required=(): obj(props, required, additionalProperties=False)
    scope = {**array(enum(*registry["permissions"]), len(registry["permissions"]), 1), "uniqueItems": True, "contains": {"const": "view"}}
    signature = string(16000, 1)
    nonce = {"type": "string", "pattern": "^[A-Za-z0-9_-]{43}$"}
    key = strict({"kty": {"const": "EC"}, "crv": {"const": "P-256"}, "x": nonce, "y": nonce}, ["kty", "crv", "x", "y"])
    define("RdPublicKey", key["properties"], key["required"])
    schemas["RdPublicKey"]["additionalProperties"] = False
    protocol = strict({"major": {"const": 1}, "minor": {"const": 0}}, ["major", "minor"])
    capability = strict({"permissions": scope, "unattended_enabled": B, "displays": array(strict({"id": string(128, 1), "name": string(128), "width": {"type": "integer", "minimum": 1, "maximum": 32768}, "height": {"type": "integer", "minimum": 1, "maximum": 32768}}, ["id", "name", "width", "height"]), 16), "codecs": array(enum("H264", "VP8", "AV1", "HEVC"), 4), "status": enum("ready", "locked", "permission_required", "unavailable")}, ["permissions"])
    define("RdEndpoint", {"id": ID, "owner_user_id": ID, "linked_device_id": nullable(ID), "endpoint_kind": enum("desktop", "android", "browser"), "role": enum("host", "controller", "both"), "name": S, "platform": S, "public_jwk": ref("RdPublicKey"), "jkt": nonce, "status": enum("active", "revoked"), "local_enabled": B, "online": B, "capabilities": obj({}), "capability_version": I, "metadata_version": V}, ["id", "owner_user_id", "endpoint_kind", "role", "jkt", "local_enabled"])
    define("RdToken", {"token": string(256, 1), "expires_at": DATE, "dpop_nonce": nonce}, ["token", "expires_at", "dpop_nonce"])
    define("RdChallenge", {"challenge_id": ID, "nonce": nonce, "expires_at": DATE, "proof_payload": obj({})}, ["challenge_id", "nonce", "expires_at", "proof_payload"])
    define("RdPairing", {"id": ID, "state": enum("pending", "confirmed", "rejected", "expired"), "expires_at": DATE, "transcript": obj({}), "display_code": nullable(S), "grant_id": nullable(ID)}, ["id", "state", "expires_at", "transcript"])
    define("RdGrant", {"id": ID, "host_endpoint_id": ID, "controller_endpoint_id": ID, "status": enum("active", "revoked", "expired"), "mode": enum("one_session", "persistent"), "grant_version": V, "permissions": scope, "grant_jws": signature, "expires_at": nullable(DATE)}, ["id", "host_endpoint_id", "controller_endpoint_id", "status", "grant_version", "permissions", "grant_jws"])
    define("RdSession", {"id": ID, "session_id": ID, "host_endpoint_id": ID, "controller_endpoint_id": ID, "state": enum("pending_approval", "authorized", "connecting", "active", "reconnecting", "closing", "closed", "failed", "expired"), "state_version": V, "connection_epoch": V, "permissions": scope, "approval_expires_at": DATE, "lease_expires_at": nullable(DATE), "lease_seq": I, "close_reason": nullable(S), "display_id": S, "ticket_jws": nullable(signature), "lease_jws": nullable(signature), "grant_jws": nullable(signature), "host_public_jwk": ref("RdPublicKey"), "controller_public_jwk": ref("RdPublicKey")}, ["id", "session_id", "state", "state_version", "connection_epoch", "permissions"])
    policy = strict({"enabled": B, "sessions_per_user": {"type": "integer", "minimum": 1, "maximum": 32}, "sessions_per_controller": {"type": "integer", "minimum": 1, "maximum": 16}}, ["enabled", "sessions_per_user", "sessions_per_controller"])
    pagination = [context["query"]("limit", {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}), context["query"]("offset", {"type": "integer", "minimum": 0, "maximum": 100000, "default": 0})]
    listing = lambda item: obj({"items": array(item, 100), "limit": V, "offset": I}, ["items", "limit", "offset"])

    def route(method, path, response=None, body=None, status=200, authentication="dpop", paged=False, idempotent=False, description=""):
        op(method, path, response, body, status, pagination if paged else [], description or "Remote desktop authorization only. Payloads use authenticated direct UDP WebRTC; no server media or file relay. Disabled deployments return RD_DISABLED. Request JSON is limited to 16 KiB.")
        operation = paths["/api/v1" + path][method]
        account = [{"bearerAuth": []}, {"sessionCookie": []}]
        proof = {"dpopAuth": [], "dpopProof": []}
        operation["security"] = account if authentication == "account" else [proof] if authentication == "dpop" else [*account, proof] if authentication == "either" else []
        operation["tags"] = ["remote-desktop"]
        if idempotent:
            operation["parameters"].append({"name": "Idempotency-Key", "in": "header", "required": True, "schema": {"type": "string", "minLength": 16, "maxLength": 128}, "description": "Same key and body return the persisted result. Changed body conflicts. One-session grant uses its session_request_id."})
        for code, text in ((413, "Body too large"), (422, "Unsupported role, protocol or capability")):
            operation["responses"][str(code)] = {"description": text, "content": {"application/json": {"schema": ref("Error")}}}

    route("post", "/rd/reauth", obj({"verified_at": DATE, "expires_at": DATE}, ["verified_at", "expires_at"]), strict({"password": string(256, 1), "mfa_code": string(128)}, ["password"]), authentication="account")
    define("RdServerKey", {"kid": nonce, "alg": {"const": "ES256"}, "public_jwk": ref("RdPublicKey"), "not_before": DATE, "not_after": DATE}, ["kid", "alg", "public_jwk", "not_before", "not_after"])
    define("RdKeyset", {"keyset_version": V, "active_kid": nonce, "keys": array(ref("RdServerKey"), 8, 1)}, ["keyset_version", "active_kid", "keys"])
    define("RdKeysetRotationPayload", {"server_instance_id": ID, "from_version": V, "to_version": V, "from_kid": nonce, "issued_at": DATE, "keyset": ref("RdKeyset")}, ["server_instance_id", "from_version", "to_version", "from_kid", "issued_at", "keyset"])
    define("RdServerKeys", {"server_instance_id": ID, "restore_epoch": V, **schemas["RdKeyset"]["properties"], "rotation_proofs": array(string(8192, 1), 32)}, ["server_instance_id", "restore_epoch", "keyset_version", "active_kid", "keys", "rotation_proofs"])
    route("get", "/rd/server-keys", ref("RdServerKeys"), authentication="account", description="Pinned P-256 server keys, validity windows and sequential old-active-key-signed ht-rd-keyset+jwt rotation proofs. RFC3339 issued_at; from_version to to_version advances exactly one. Reject foreign instance, rollback and unsigned same-version substitution. Response limit 256 KiB. restore_epoch advances revoke sessions without resetting key trust.")
    route("post", "/rd/enrollment-challenges", ref("RdChallenge"), strict({"endpoint_kind": enum("desktop", "android", "browser"), "role": enum("host", "controller", "both"), "public_jwk": ref("RdPublicKey"), "linked_device_id": ID}, ["endpoint_kind", "role", "public_jwk"]), 201, "account")
    route("post", "/rd/endpoints", obj({"endpoint": ref("RdEndpoint"), **schemas["RdToken"]["properties"]}, ["endpoint", "token", "expires_at", "dpop_nonce"]), strict({"challenge_id": ID, "signed_proof": signature, "name": string(80, 1), "platform": string(80, 1)}, ["challenge_id", "signed_proof", "name", "platform"]), 201, "account")
    route("post", "/rd/token-challenges", ref("RdChallenge"), strict({"endpoint_id": ID, "purpose": enum("host_online", "controller_refresh")}, ["endpoint_id", "purpose"]), 201, "challenge", description="Host challenge is anonymous and non-enumerating. controller_refresh additionally requires the authenticated parent account session and cookie CSRF/Origin checks.")
    route("post", "/rd/tokens", ref("RdToken"), strict({"endpoint_id": ID, "challenge_id": ID, "proof": signature}, ["endpoint_id", "challenge_id", "proof"]), authentication="challenge", description="Single-use P-256 proof bound to the challenge. Controller refresh additionally requires the same parent account session. Host identity cannot acquire controller permissions.")
    route("get", "/rd/endpoints", listing(ref("RdEndpoint")), authentication="either", paged=True)
    route("get", "/rd/endpoints/{id}", ref("RdEndpoint"), authentication="either")
    route("patch", "/rd/endpoints/{id}/metadata", obj({"id": ID, "name": S, "metadata_version": V}), strict({"name": string(80, 1), "expected_version": V}, ["name", "expected_version"]), authentication="either")
    route("put", "/rd/endpoints/{id}/capabilities", ref("RdEndpoint"), strict({"local_enabled": B, "capability_version": V, "capabilities": capability, "signed_proof": signature}, ["local_enabled", "capability_version", "capabilities", "signed_proof"]))
    route("delete", "/rd/endpoints/{id}", status=204, authentication="account")
    route("post", "/rd/signal-tickets", obj({"ticket": S, "expires_at": DATE, "signal_path": {"const": "/api/v1/rd/signal"}, "subprotocol": {"const": "ht.rd.signal.v1"}}, ["ticket", "expires_at", "signal_path", "subprotocol"]), strict({"purpose": enum("connect", "reauth")}), 201)
    route("post", "/rd/pairings", ref("RdPairing"), strict({"host_endpoint_id": ID, "session_request_id": ID, "permissions": scope, "mode": enum("one_session", "persistent"), "nonce_controller": nonce}, ["host_endpoint_id", "session_request_id", "permissions", "nonce_controller"]), 201)
    route("get", "/rd/pairings/{id}", ref("RdPairing"))
    route("post", "/rd/pairings/{id}/confirm", ref("RdPairing"), strict({"signed_proof": signature, "nonce_host": nonce, "grant_jws": signature}, ["signed_proof"]))
    route("post", "/rd/pairings/{id}/reject", status=204)
    route("get", "/rd/grants", listing(ref("RdGrant")), authentication="either", paged=True)
    route("put", "/rd/grants/{id}", obj({"id": ID, "grant_version": V, "status": S}), strict({"grant_jws": signature}, ["grant_jws"]))
    route("delete", "/rd/grants/{id}", status=204, authentication="either")
    route("post", "/rd/sessions", ref("RdSession"), strict({"host_endpoint_id": ID, "grant_id": ID, "permissions": scope, "display_id": string(128, 1), "protocol": protocol, "quality": enum("balanced", "quality", "speed")}, ["host_endpoint_id", "grant_id", "permissions", "display_id", "protocol"]), 202, idempotent=True)
    route("get", "/rd/sessions", listing(ref("RdSession")), authentication="either", paged=True)
    route("get", "/rd/sessions/{id}", ref("RdSession"), authentication="either")
    route("post", "/rd/sessions/{id}/decision", ref("RdSession"), strict({"decision": enum("accept", "reject"), "grant_version": V, "permissions": scope, "expected_version": V, "signed_proof": signature}, ["decision", "grant_version", "permissions", "expected_version", "signed_proof"]))
    route("post", "/rd/sessions/{id}/report", ref("RdSession"), strict({"phase": enum("connecting", "ready", "failed"), "connection_epoch": V, "expected_version": V, "error_code": enum("RD_NO_DIRECT_PATH", "RD_MEDIA_FAILED", "RD_PERMISSION_DENIED", "RD_PEER_AUTH_FAILED", "RD_CANCELLED"), "path_verified": B}, ["phase", "connection_epoch", "expected_version"]))
    route("post", "/rd/sessions/{id}/renew", ref("RdSession"), strict({"current_epoch": V, "last_lease_seq": V, "signed_proof": signature}, ["current_epoch", "last_lease_seq", "signed_proof"]))
    route("post", "/rd/sessions/{id}/reconnect", ref("RdSession"), strict({"expected_epoch": V, "reason": enum("network_changed", "ice_failed", "display_changed", "media_failed")}, ["expected_epoch", "reason"]), 202, idempotent=True)
    route("post", "/rd/sessions/{id}/close", status=204, authentication="either")
    route("post", "/rd/sessions/{id}/close-ack", body=strict({"connection_epoch": V, "lease_seq": I, "signed_proof": signature}, ["connection_epoch", "lease_seq", "signed_proof"]), status=204)
    route("get", "/rd/audit", listing(obj({"id": ID, "action": S, "resource_id": ID, "created_at": DATE})), authentication="account", paged=True)
    policy_response = obj({"policy": policy, "version": I, "udp_only": {"const": True}, "allow_turn": {"const": False}, "allow_ice_tcp": {"const": False}}, ["policy", "version"])
    route("get", "/admin/rd/policy", policy_response, authentication="account")
    route("patch", "/admin/rd/policy", policy_response, strict({"policy": policy, "expected_version": I}, ["policy", "expected_version"]), authentication="account")
    route("post", "/admin/rd/sessions/{id}/revoke", status=204, authentication="account")
    schemas["Capabilities"]["properties"]["remote_desktop"] = obj({"enabled": B, "protocol": protocol, "signal_path": S, "udp_only": {"const": True}, "allow_turn": {"const": False}, "allow_ice_tcp": {"const": False}, "stun_urls": array(S, 4), "limits": obj({"endpoints_per_user": V, "sessions_per_user": V, "sessions_per_controller": V, "sessions_per_host": {"const": 1}})}, ["enabled", "protocol", "udp_only"])
