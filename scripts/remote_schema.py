"""Structural checks and documentation for the canonical RD payload registry."""
import json


def validate_registry(registry):
    assert registry["schema_dialect"] == "https://json-schema.org/draft/2020-12/schema"
    definitions = registry["$defs"]

    def schema(value):
        if isinstance(value, bool):
            return
        assert isinstance(value, dict), "Each body schema must be an object or Boolean"
        if "$ref" in value:
            assert value["$ref"].startswith("#/$defs/")
            assert value["$ref"].removeprefix("#/$defs/") in definitions
        if value.get("type") == "object":
            assert value.get("additionalProperties") is False, "Unknown fields must fail closed"
            assert set(value.get("required", ())) <= value.get("properties", {}).keys()
            for child in value.get("properties", {}).values():
                schema(child)
        if value.get("type") == "array":
            assert "maxItems" in value and 0 <= value.get("minItems", 0) <= value["maxItems"]
            schema(value["items"])
        if value.get("type") in ("integer", "number"):
            assert "minimum" in value and "maximum" in value
        for name in ("oneOf", "anyOf", "allOf"):
            for child in value.get(name, ()):
                schema(child)
        for name in ("contains", "not"):
            if name in value:
                schema(value[name])

    for definition in definitions.values():
        schema(definition)
    assert set(definitions["permissions"]["items"]["enum"]) == set(registry["permissions"])
    assert set(definitions["feature_permission"]["enum"]) == set(registry["permissions"]) - {"view", "input.keyboard", "input.pointer", "input.text"}
    widths = {"uint8": 1, "uint16": 2, "uint32": 4, "uint64": 8, "int32": 4, "int64": 8, "uuid16": 16}
    for name, message in registry["messages"].items():
        assert message["wire_status"] in ("defined", "reserved"), name
        assert 0 < message["max_payload_bytes"] <= registry["channels"][message["channel"]]["max_message_bytes"] - registry["header"]["length"], name
        assert message.get("permission_rule"), name
        if message["encoding"] == "json":
            schema(message["body_schema"])
            if message["wire_status"] == "reserved":
                assert message["body_schema"] is False and message.get("reserved_reason"), name
                assert not message.get("examples"), name
            else:
                assert isinstance(message["body_schema"], dict) and message.get("examples"), name
                assert message["body_schema"]["x-maxEncodedBytes"] == message["max_payload_bytes"], name
                for example in message["examples"]:
                    assert len(json.dumps(example, ensure_ascii=False, separators=(",", ":")).encode()) <= message["max_payload_bytes"], name
        else:
            assert message["body_schema"] is False, "Binary bodies cannot accept JSON"
            assert message["wire_status"] == "defined" and message["binary_layout"]["byte_order"] == "big"
            offset = 0
            for index, field in enumerate(message["binary_layout"]["fields"]):
                assert field["offset"] == offset, (name, field["name"])
                if field["type"] in widths:
                    assert field["bytes"] == widths[field["type"]]
                    offset += field["bytes"]
                else:
                    assert index == len(message["binary_layout"]["fields"]) - 1
                    assert field["type"] in ("bytes", "utf8")
            if "payload_bytes" in message:
                assert offset == message["payload_bytes"] == message["max_payload_bytes"], name


def generated_reference(registry):
    lines = [
        "<!-- BEGIN GENERATED RD PAYLOAD REFERENCE -->",
        "## Machine-readable payload reference",
        "",
        "Generated from `remote-desktop.v1.json`; edit the registry and regenerate.",
        "`body_schema` uses JSON Schema 2020-12 with the registry's `$defs`.",
        "Unknown JSON fields are rejected at every object level. `x-maxEncodedBytes`",
        "counts UTF-8 JSON bytes; `x-uniqueBy` and `x-fieldInArray` enforce display",
        "identity constraints. UUID/nonce/hash formats and integer bounds are explicit.",
        "",
        "`defined` means a wire encoding exists, not that an OS/media backend implements",
        "the feature. `reserved` bodies have schema `false` and must be rejected.",
        "A valid body never replaces current epoch/lease/proof/role/permission and",
        "request/transfer ownership checks. All size limits below exclude the 24-byte",
        "frame header. Frame channel limits include that header.",
        "",
        "| Message | Type / channel | Encoding / status | Body fields | Maximum body bytes |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name, message in registry["messages"].items():
        body = message["body_schema"]
        if message["encoding"] == "binary":
            description = ", ".join(f"`{field['name']}:{field['type']}@{field['offset']}`" for field in message["binary_layout"]["fields"])
        elif body is False:
            description = "Rejected (`false`)"
        else:
            variants = body.get("oneOf", [body])
            description = " or ".join("`{" + ", ".join(field + ("?" if field not in variant["required"] else "") for field in variant["properties"]) + "}`" for variant in variants)
        lines.append(f"| {name} | `0x{message['id']:02x}` / {message['channel']} | {message['encoding']} / {message['wire_status']} | {description} | {message['max_payload_bytes']} |")
    lines.extend(["", "Reserved messages:", ""])
    for name, message in registry["messages"].items():
        if message["wire_status"] == "reserved":
            lines.append(f"- `{name}`: {message['reserved_reason']}")
    lines.extend(["", "Current profile and binary implementation limits:", ""])
    for name, message in registry["messages"].items():
        if message.get("profile_note"):
            lines.append(f"- `{name}`: {message['profile_note']}")
    lines.extend([
        "- `SESSION_READY` host-to-controller uses `{epoch}`; the controller reply also requires `permissions` and `lease_seq`. Role selection is a separate state-machine check.",
        "- `FILE_ACK` is exactly `{id, offset}` or `{id, sha256}`. Mixed chunk/completion ACKs fail validation.",
        "- `INPUT_STATE` is an empty-state resynchronization: no pressed keys/buttons or prior motion watermark. `request_id` must match the pending local control request.",
        "- Heartbeat `state_version` must increase within the input epoch; body validation alone cannot establish that history.",
        "- The nine binary encodings are defined. Relative pointer/button injection and browser `TEXT_ACK` handling are not active backend features merely because their layouts exist.",
        "- `TEXT_COMMIT` length is 0–4096 UTF-8 bytes in the native parser; the browser currently emits only nonempty text. UUIDs are raw 16-byte values, without an extra length prefix.",
        "- Clipboard chunks contain UUID16 + uint64-BE offset + bytes. Browser senders use at most 8192 data bytes; the clipboard frame bound allows at most 16336 data bytes. Validate UTF-8 after reassembly, since a chunk may split a code point.",
        "- File chunks contain UUID16 + uint64-BE offset + 1–16384 bytes. Declared file/batch limits, contiguous offsets, digest validation, explicit receiver consent and one outstanding chunk per file remain mandatory.",
        "<!-- END GENERATED RD PAYLOAD REFERENCE -->",
    ])
    return "\n".join(lines) + "\n"
