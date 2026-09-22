# RD data protocol 1 (development)

The numeric registry is `remote-desktop.v1.json`; generated JavaScript,
TypeScript, C++ and Kotlin constants share its 24-byte big-endian frame header.
This document specifies the additional JSON payloads used by the 8.0 clients.
The contract is not frozen for release yet. A successful build or protocol test
does not establish operational native media support.

All payloads below require the current connection epoch, valid monotonic lease,
peer proof and actual direct UDP path. No server payload forwarding is permitted.
Messages on different channels can arrive in either order; slow file I/O must
never block the control channel, revocation or the input watchdog.

## Input control and displays

| Message | JSON fields |
| --- | --- |
| CONTROL_REQUEST | `request_id` UUID, `requested_input_permissions` array |
| CONTROL_GRANTED | echo `request_id`, positive increasing `new_input_epoch` |
| INPUT_STATE | echo `request_id`, `generation` (input epoch), `keys`, `buttons`, `motion_sequence` |
| INPUT_SYNC_ACK | echo `request_id`, `input_epoch`, `layout_epoch` |
| RELEASE_ALL | `reason` (bounded non-sensitive enum/string) |
| DISPLAY_LAYOUT | increasing `layout_epoch`, `active_display` ID, 1–16 `displays` with unique `id` and `slot`, positive `width_px`, `height_px`, optional `name` |
| DISPLAY_SELECT | `display_id`, current `layout_epoch` |

A controller enables input only after the ACK for its current request and epochs.
Late grants/ACKs after release or a newer request are discarded and explicitly
released; they do not terminate the read-only video session. Layout changes first
release all input. Reliable button packets carry their own coordinates. Text
commits carry an independent UUID and final UTF-8, never intermediate IME state.

## Independent features

`FEATURE_REQUEST {permission, enabled}` asks the host to enable or disable exactly
one already-granted feature. `FEATURE_STATE {permission, enabled, error_code?}`
acknowledges actual backend state. A request cannot enlarge the signed scope.
Only audio.system, audio.microphone, clipboard.read/write and files.send/receive
use this feature switch. They default off and require host agreement.

Microphone capture is reserved to one controller session, including while an OS
permission prompt is pending. Stops invalidate pending capture callbacks, detach
the track and tell the host to clear its virtual-input buffer. Clipboard is bound
to one explicitly selected foreground session. Background transitions clear
pending text and disable the feature; late payloads do not reopen it.

## Text clipboard

`CLIPBOARD_OFFER {id, size, sha256, mime}` uses a fresh UUID, UTF-8 byte size ≤65536,
lowercase hexadecimal SHA256 and MIME `text/plain;charset=utf-8`.
`CLIPBOARD_ACCEPT {id}` permits chunks. Each binary chunk is UUID16 + uint64-BE
offset + UTF-8 bytes (up to 8192 bytes from browser). The declared total is exact;
invalid UTF-8, gaps, overflow and digest mismatches fail safely. After all bytes
are checked, `CLIPBOARD_ACK {id}` completes the operation; an empty clipboard
requires no chunks. Retain bounded recent IDs and last-content digest to suppress
echoes. Never automatically write an OS clipboard without required foreground
permission/user gesture. Clear buffers on stop, revoke, reconnect and logout.

## Selected files

| Message | Payload |
| --- | --- |
| FILE_OFFER | `{id, name, size}`; fresh UUID, basename, exact bytes |
| FILE_ACCEPT | `{id}` after the user selects a writable destination |
| FILE_CHUNK | UUID16 + uint64-BE offset + 1–16384 bytes |
| FILE_ACK (chunk) | `{id, offset}` after the receiver writes this chunk; offset is total bytes written |
| FILE_COMPLETE | `{id, size, sha256}` after the sender has received every chunk ACK |
| FILE_ACK (complete) | `{id, sha256}` only after exact size/digest verification and successful destination commit |
| FILE_CANCEL | `{id, reason?}`; stop reads/writes and abort the temporary destination |

Maximum file size is 8 GiB, batch 32 GiB/64 files, with two active files and one
unacknowledged chunk per file. This application-level ACK bounds pending disk
writes independently of SCTP's network buffer. Completion ACKs cannot be confused
with chunk ACKs. Empty files use OFFER/ACCEPT/COMPLETE without chunks. Pending
offers and stalled ACKs have bounded timeouts. Filenames must not contain path
separators, controls, traversal or platform-reserved names. Files are never opened
automatically. Overwrite requires the destination selector's explicit consent.
Canceled IDs tolerate bounded late chunks/completion without killing other files
or the viewing session. A disconnected transfer requires a new offer and explicit
acceptance; no automatic replay. Cancellation during the destination's final
commit cannot claim that a file already written by the OS was removed.

## Signed authorization fixtures

`remote-authorization-vectors.json` contains public keys and fixed-time real
ES256/P1363 signed ticket, lease and host grant vectors. Join each `jws_parts`
array with `.` to recover a compact JWS. The private fixture keys are discarded
and none of these keys or claims are trusted in production.

Ticket and lease both bind `session_request_id` as well as session/epoch, owner,
endpoints, key thumbprints, grant/version, restore epoch and permissions. A
one-session grant's `one_session_request_id` must equal that signed request ID.
The negative vectors are correctly signed but fail their binding or validity
checks; signature verification alone must never make them acceptable.

<!-- BEGIN GENERATED RD PAYLOAD REFERENCE -->
## Machine-readable payload reference

Generated from `remote-desktop.v1.json`; edit the registry and regenerate.
`body_schema` uses JSON Schema 2020-12 with the registry's `$defs`.
Unknown JSON fields are rejected at every object level. `x-maxEncodedBytes`
counts UTF-8 JSON bytes; `x-uniqueBy` and `x-fieldInArray` enforce display
identity constraints. UUID/nonce/hash formats and integer bounds are explicit.

`defined` means a wire encoding exists, not that an OS/media backend implements
the feature. `reserved` bodies have schema `false` and must be rejected.
A valid body never replaces current epoch/lease/proof/role/permission and
request/transfer ownership checks. All size limits below exclude the 24-byte
frame header. Frame channel limits include that header.

| Message | Type / channel | Encoding / status | Body fields | Maximum body bytes |
| --- | --- | --- | --- | --- |
| SESSION_HELLO | `0x01` / control | json / defined | `{nonce, ticket_hash, protocol, capability_hash}` | 16360 |
| SESSION_PROOF | `0x02` / control | json / defined | `{transcript_version, signature, jkt}` | 16360 |
| PATH_VERIFIED | `0x03` / control | json / defined | `{epoch, protocol, local_candidate_type, remote_candidate_type}` | 16360 |
| SESSION_READY | `0x04` / control | json / defined | `{epoch}` or `{epoch, permissions, lease_seq}` | 16360 |
| CAPABILITIES | `0x05` / control | json / defined | `{permissions, codecs}` | 8192 |
| CAPABILITIES_ACK | `0x06` / control | json / defined | `{capability_hash, permissions}` | 16360 |
| DISPLAY_LAYOUT | `0x07` / control | json / defined | `{layout_epoch, active_display, displays}` | 16360 |
| DISPLAY_SELECT | `0x08` / control | json / defined | `{display_id, layout_epoch}` | 16360 |
| STREAM_CONFIG | `0x09` / control | json / reserved | Rejected (`false`) | 16360 |
| STREAM_ACK | `0x0a` / control | json / reserved | Rejected (`false`) | 16360 |
| PAUSE | `0x0b` / control | json / defined | `{reason, resume_allowed}` | 16360 |
| RESUME | `0x0c` / control | json / reserved | Rejected (`false`) | 16360 |
| CONTROL_REQUEST | `0x10` / control | json / defined | `{request_id, requested_input_permissions}` | 16360 |
| CONTROL_GRANTED | `0x11` / control | json / defined | `{request_id, new_input_epoch}` | 16360 |
| CONTROL_RELEASED | `0x12` / control | json / defined | `{reason, new_input_epoch?}` | 16360 |
| INPUT_STATE | `0x13` / control | json / defined | `{request_id, generation, keys, buttons, motion_sequence}` | 16360 |
| INPUT_SYNC_ACK | `0x14` / control | json / defined | `{request_id, input_epoch, layout_epoch}` | 16360 |
| RELEASE_ALL | `0x15` / control | json / defined | `{reason}` | 16360 |
| KEY | `0x20` / input | binary / defined | `usage_page:uint16@0`, `usage:uint16@2`, `action:uint8@4`, `repeat:uint8@5`, `reserved:uint16@6` | 8 |
| BUTTON | `0x21` / input | binary / defined | `layout_epoch:uint32@0`, `display_slot:uint16@4`, `x:uint16@6`, `y:uint16@8`, `button:uint8@10`, `action:uint8@11`, `motion_seq:uint32@12`, `cumulative_dx:int64@16`, `cumulative_dy:int64@24` | 32 |
| WHEEL | `0x22` / input | binary / defined | `layout_epoch:uint32@0`, `display_slot:uint16@4`, `x:uint16@6`, `y:uint16@8`, `reserved:uint16@10`, `delta_x:int32@12`, `delta_y:int32@16`, `motion_seq:uint32@20` | 24 |
| TEXT_COMMIT | `0x23` / input | binary / defined | `submission_id:uuid16@0`, `text_length:uint32@16`, `text:utf8@20` | 4116 |
| TEXT_ACK | `0x24` / input | binary / defined | `submission_id:uuid16@0`, `result_code:uint16@16` | 18 |
| POINTER_ABS | `0x30` / motion | binary / defined | `layout_epoch:uint32@0`, `display_slot:uint16@4`, `x:uint16@6`, `y:uint16@8`, `reserved:uint16@10`, `motion_seq:uint32@12` | 16 |
| POINTER_REL | `0x31` / motion | binary / defined | `layout_epoch:uint32@0`, `motion_seq:uint32@4`, `cumulative_dx:int64@8`, `cumulative_dy:int64@16` | 24 |
| INPUT_HEARTBEAT | `0x40` / feedback | json / defined | `{input_epoch, state_version, keys, buttons}` | 2024 |
| RECEIVER_FEEDBACK | `0x41` / feedback | json / reserved | Rejected (`false`) | 2024 |
| CURSOR_POSITION | `0x42` / feedback | json / reserved | Rejected (`false`) | 2024 |
| CURSOR_SHAPE | `0x43` / control | json / reserved | Rejected (`false`) | 16360 |
| SESSION_CLOSE | `0x50` / control | json / defined | `{reason?}` | 16360 |
| PROTOCOL_ERROR | `0x51` / control | json / reserved | Rejected (`false`) | 16360 |
| FEATURE_REQUEST | `0x60` / control | json / defined | `{permission, enabled}` | 16360 |
| FEATURE_STATE | `0x61` / control | json / defined | `{permission, enabled, error_code?}` | 16360 |
| CLIPBOARD_OFFER | `0x70` / clipboard | json / defined | `{id, size, sha256, mime}` | 16360 |
| CLIPBOARD_ACCEPT | `0x71` / clipboard | json / defined | `{id}` | 16360 |
| CLIPBOARD_CHUNK | `0x72` / clipboard | binary / defined | `transfer_id:uuid16@0`, `offset:uint64@16`, `content:bytes@24` | 16360 |
| CLIPBOARD_ACK | `0x73` / clipboard | json / defined | `{id}` | 16360 |
| FILE_OFFER | `0x80` / file | json / defined | `{id, name, size}` | 17384 |
| FILE_ACCEPT | `0x81` / file | json / defined | `{id}` | 17384 |
| FILE_CHUNK | `0x82` / file | binary / defined | `transfer_id:uuid16@0`, `offset:uint64@16`, `content:bytes@24` | 16408 |
| FILE_COMPLETE | `0x83` / file | json / defined | `{id, size, sha256}` | 17384 |
| FILE_ACK | `0x84` / file | json / defined | `{id, offset}` or `{id, sha256}` | 17384 |
| FILE_CANCEL | `0x85` / file | json / defined | `{id, reason?}` | 17384 |

Reserved messages:

- `STREAM_CONFIG`: Only a semantic target-output description exists; exact codec/color wire is not implemented.
- `STREAM_ACK`: No stream-revision negotiation implementation emits or consumes this body.
- `RESUME`: Resume version fields have not been frozen or implemented.
- `RECEIVER_FEEDBACK`: Statistics field names and units have not been frozen; the native view worker currently ignores this type.
- `CURSOR_POSITION`: No remote cursor feedback implementation is active.
- `CURSOR_SHAPE`: Chunked cursor-shape fields and format negotiation are not implemented.
- `PROTOCOL_ERROR`: Rejected-type field spelling and interoperable error body are not implemented.

Current profile and binary implementation limits:

- `PATH_VERIFIED`: The current interoperable body has no proof-summary or verification-version fields; the host independently checks actual selected UDP stats before emitting it.
- `CAPABILITIES`: Current view profile: permissions/codecs only; full platform/display/input capability negotiation is not implemented.
- `CONTROL_RELEASED`: A denied initial request has reason only; new_input_epoch is optional for a release that invalidates an issued epoch.
- `SESSION_CLOSE`: A close body may be empty for compatibility with existing peers; a provided reason is bounded and non-sensitive.
- `SESSION_READY` host-to-controller uses `{epoch}`; the controller reply also requires `permissions` and `lease_seq`. Role selection is a separate state-machine check.
- `FILE_ACK` is exactly `{id, offset}` or `{id, sha256}`. Mixed chunk/completion ACKs fail validation.
- `INPUT_STATE` is an empty-state resynchronization: no pressed keys/buttons or prior motion watermark. `request_id` must match the pending local control request.
- Heartbeat `state_version` must increase within the input epoch; body validation alone cannot establish that history.
- The nine binary encodings are defined. Relative pointer/button injection and browser `TEXT_ACK` handling are not active backend features merely because their layouts exist.
- `TEXT_COMMIT` length is 0–4096 UTF-8 bytes in the native parser; the browser currently emits only nonempty text. UUIDs are raw 16-byte values, without an extra length prefix.
- Clipboard chunks contain UUID16 + uint64-BE offset + bytes. Browser senders use at most 8192 data bytes; the clipboard frame bound allows at most 16336 data bytes. Validate UTF-8 after reassembly, since a chunk may split a code point.
- File chunks contain UUID16 + uint64-BE offset + 1–16384 bytes. Declared file/batch limits, contiguous offsets, digest validation, explicit receiver consent and one outstanding chunk per file remain mandatory.
<!-- END GENERATED RD PAYLOAD REFERENCE -->
